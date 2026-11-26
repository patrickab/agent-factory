/**
 * Contracts: memory-store facts a wave's tasks work by (`<store>/run/contract/<name>/<fact>`, or one document
 * `<store>/run/contract/<name>.md`), the store being the wave's `plan`.
 *
 * - Reads them through the `memory-store` CLI (`ls`, `read --no-ids`): `contractKind`, `readContract` (fact path ->
 *   text, subdirectories included), `stampOf` (sha256 of the whole and of each fact)
 * - `contractsForLaunch`: what a task's launch needs, the prefix of the coder's first message (each contract's name and
 *   the command that reads it) and the stamps the task record keeps
 * - `contractNote`: the follow-up of a changed contract (contract, fact, old text, new text, "your contract changed")
 * - `contractCheck`: the task runner's look before a coder turn: the notes `contracts.apply` left on the record, plus a
 *   note for every fact whose hash differs from the stored stamp (a direct edit of the store); stores the new stamps
 * - `withContractsLock`: one lock (`<factory home>/contracts.lock`) around an apply and every check, so a change is
 *   announced once
 * - Imports only Bun, `node:` and plain plugin modules: the task runner loads it
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { runCommand } from "./run.ts";
import { factoryHome } from "./settings.ts";
import { onPath } from "./spawn.ts";
import { listTasks, lockFile, readTask, TaskBusyError, unlockFile, writeTask, type ContractStamp, type TaskRecord } from "./tasks.ts";
import { outputTail } from "./util.ts";

export const CONTRACT_DIR = "run/contract";
const CONTRACT_NAME = /^[A-Za-z0-9._-]+$/;
const LOCK_WAIT_MS = 30_000;
const LOCK_RETRY_MS = 50;

/** A contract's facts: path in the store -> text. */
export type ContractFacts = Map<string, string>;

export function isContractName(name: string): boolean {
  return CONTRACT_NAME.test(name) && name !== "." && name !== "..";
}

export function memoryStoreOnPath(): boolean {
  return onPath("memory-store") !== null;
}

async function memoryStore(args: string[]): Promise<{ ok: boolean; stdout: string; output: string }> {
  const result = await runCommand(["memory-store", ...args], { cwd: "/", maxStdoutChars: 5_000_000, timeoutMs: 60_000 });
  return { ok: result.exitCode === 0, stdout: result.stdout, output: result.output };
}

/** The text `memory-store read --no-ids` prints for `path`, without its header; null when it is not found. */
async function readPath(store: string, path: string): Promise<string | null> {
  const result = await memoryStore(["read", "--no-ids", store, path]);
  if (!result.ok) throw new Error(`memory-store read ${store} ${path}: ${outputTail(result.output)}`);
  const [header = "", ...rest] = result.stdout.split("\n");
  if (header.startsWith(`## ${path} — not_found`)) return null;
  return rest.join("\n").trim();
}

/** The directory `dir`'s entries per `memory-store ls`: its subdirectories and its memories and documents; null when it does not exist. */
async function listDir(store: string, dir: string): Promise<{ dirs: string[]; facts: string[] } | null> {
  const result = await memoryStore(["ls", store, dir]);
  if (!result.ok) return null;
  const dirs: string[] = [];
  const facts: string[] = [];
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("directories: ")) dirs.push(...line.slice("directories: ".length).split(", ").map((entry) => entry.trim()).filter((entry) => entry !== ""));
    else if (line.startsWith("- ")) facts.push(line.slice(2).split(" ")[0]);
  }
  return { dirs, facts };
}

function contractDir(name: string): string {
  return `${CONTRACT_DIR}/${name}`;
}

function contractDocument(name: string): string {
  return `${CONTRACT_DIR}/${name}.md`;
}

/** Whether the contract `name` is a directory of facts, one document, or does not exist (null). */
export async function contractKind(store: string, name: string): Promise<"dir" | "doc" | null> {
  if ((await listDir(store, contractDir(name))) !== null) return "dir";
  return (await readPath(store, contractDocument(name))) === null ? null : "doc";
}

/** The facts of the contract `name` (path -> text); an empty map when it does not exist. */
export async function readContract(store: string, name: string): Promise<ContractFacts> {
  const facts: ContractFacts = new Map();
  const walk = async (dir: string): Promise<boolean> => {
    const listed = await listDir(store, dir);
    if (listed === null) return false;
    for (const path of listed.facts) {
      const text = await readPath(store, path);
      if (text !== null) facts.set(path, text);
    }
    for (const sub of listed.dirs) await walk(sub);
    return true;
  };
  if (!(await walk(contractDir(name)))) {
    const text = await readPath(store, contractDocument(name));
    if (text !== null) facts.set(contractDocument(name), text);
  }
  return facts;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function stampOf(facts: ContractFacts): ContractStamp {
  const sorted = [...facts.entries()].sort(([a], [b]) => a.localeCompare(b));
  return { hash: sha256(JSON.stringify(sorted)), facts: Object.fromEntries(sorted.map(([path, text]) => [path, sha256(text)])) };
}

/** The prefix of a coder's first message: its contracts and the command that reads each. */
export function contractsPrefix(store: string, contracts: ReadonlyMap<string, ContractFacts>): string {
  const lines = [...contracts.entries()].map(([name, facts]) => `- ${name}: memory-store read ${store} ${[...facts.keys()].sort().join(" ")}`);
  return [`Your contracts (memory-store ${store}): read each before you start, they win over this request. A change to them reaches you as a follow-up.`, ...lines].join("\n");
}

/** What a task's launch needs of its contracts: the prefix of its first message and the stamps its record keeps. */
export async function contractsForLaunch(store: string, names: readonly string[]): Promise<{ prefix: string; stamps: Record<string, ContractStamp> }> {
  const contracts = new Map<string, ContractFacts>();
  for (const name of names) {
    const facts = await readContract(store, name);
    if (facts.size === 0) throw new Error(`the contract ${name} is not in memory-store ${store}`);
    contracts.set(name, facts);
  }
  return { prefix: contractsPrefix(store, contracts), stamps: Object.fromEntries([...contracts.entries()].map(([name, facts]) => [name, stampOf(facts)])) };
}

/** One fact's change: its old text (undefined: not known, null: none) and its new one (null: gone). */
export type FactChange = { path: string; old: string | null | undefined; new: string | null };

/** The follow-up of a changed contract. */
export function contractNote(name: string, changes: readonly FactChange[]): string {
  const facts = changes.map((change) => {
    const old = change.old === undefined ? "(not known: the store was edited directly)" : (change.old ?? "(none)");
    return `- fact ${change.path}\n  old: ${old}\n  new: ${change.new ?? "(retired)"}`;
  });
  return [`Your contract ${name} changed, re-read the facts below and follow the new text:`, ...facts].join("\n");
}

/** The facts whose text differs between `before` and `after`. */
export function factChanges(before: ContractFacts, after: ContractFacts): FactChange[] {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  return paths.filter((path) => before.get(path) !== after.get(path)).map((path) => ({ path, old: before.get(path) ?? null, new: after.get(path) ?? null }));
}

/** Runs `act` holding the contracts lock (waits for another holder up to `LOCK_WAIT_MS`). */
export async function withContractsLock<T>(act: () => Promise<T>): Promise<T> {
  const path = join(factoryHome(), "contracts.lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await lockFile(path, "the contracts lock is held by another factory process");
      break;
    } catch (error) {
      if (!(error instanceof TaskBusyError) || Date.now() > deadline) throw error;
      await sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return await act();
  } finally {
    await unlockFile(path);
  }
}

/**
 * The task runner's look before a coder turn of the task in session `sessionId`: the follow-ups left on its record and
 * one per contract whose stamp differs from the store's now (the facts that differ, their old text not known). Stores
 * the new stamps and clears the notes. Null when nothing changed or the task has no contracts.
 */
export async function contractCheck(sessionId: string): Promise<string | null> {
  const found = (await listTasks()).find((task) => task.sessionId === sessionId);
  if (found === undefined || (found.contracts === undefined && found.contractNotes === undefined)) return null;
  return withContractsLock(async () => {
    const record: TaskRecord = await readTask(found.id);
    const notes = [...(record.contractNotes ?? [])];
    const stamps = { ...(record.contracts ?? {}) };
    if (record.plan !== null) {
      for (const [name, stamp] of Object.entries(stamps)) {
        const facts = await readContract(record.plan, name);
        const now = stampOf(facts);
        if (now.hash === stamp.hash) continue;
        const paths = [...new Set([...Object.keys(stamp.facts), ...Object.keys(now.facts)])].sort();
        const changes = paths.filter((path) => stamp.facts[path] !== now.facts[path]).map((path) => ({ path, old: undefined, new: facts.get(path) ?? null }));
        notes.push(contractNote(name, changes));
        stamps[name] = now;
      }
    }
    if (notes.length === 0) return null;
    const { contractNotes: _notes, ...rest } = record;
    await writeTask({ ...rest, ...(record.contracts === undefined ? {} : { contracts: stamps }) });
    return notes.join("\n\n");
  });
}
