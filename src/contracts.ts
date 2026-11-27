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
import { runCommand, type CommandResult } from "./run.ts";
import { factoryHome } from "./settings.ts";
import { onPath } from "./spawn.ts";
import { listTasks, readTask, withLock, writeTask, type ContractStamp, type TaskRecord } from "./tasks.ts";
import { outputTail } from "./util.ts";

export const CONTRACT_DIR = "run/contract";
const CONTRACT_NAME = /^[A-Za-z0-9._-]+$/;
const LOCK_WAIT_MS = 30_000;

/** A contract's facts: path in the store -> text. */
export type ContractFacts = Map<string, string>;

export function isContractName(name: string): boolean {
  return CONTRACT_NAME.test(name) && name !== "." && name !== "..";
}

export function memoryStoreOnPath(): boolean {
  return onPath("memory-store") !== null;
}

/** `memory-store <args>` (in `cwd`), `ok` when it exited 0; `exitCode` null when it could not run. */
export async function memoryStore(args: string[], cwd = "/"): Promise<CommandResult & { ok: boolean }> {
  const result = await runCommand(["memory-store", ...args], { cwd, maxStdoutChars: 5_000_000, timeoutMs: 60_000 });
  return { ...result, ok: result.exitCode === 0 };
}

/**
 * The texts `memory-store read --no-ids` prints for `paths`, in one call, each without its header; null for one that is
 * not found. Each path's section starts at its `## <path>` header, found in order after the one before.
 */
async function readPaths(store: string, paths: readonly string[]): Promise<(string | null)[]> {
  if (paths.length === 0) return [];
  const result = await memoryStore(["read", "--no-ids", store, ...paths]);
  if (!result.ok) throw new Error(`memory-store read ${store} ${paths.join(" ")}: ${outputTail(result.output)}`);
  const lines = result.stdout.split("\n");
  const isHeader = (line: string, path: string) => line === `## ${path}` || line.startsWith(`## ${path} — `);
  const starts: number[] = [];
  for (const path of paths) {
    const from = starts.length === 0 ? 0 : (starts.at(-1) as number) + 1;
    const at = lines.findIndex((line, index) => index >= from && isHeader(line, path));
    if (at < 0) throw new Error(`memory-store read ${store}: no section for ${path}`);
    starts.push(at);
  }
  return paths.map((path, index) => {
    if (lines[starts[index]].startsWith(`## ${path} — not_found`)) return null;
    return lines.slice(starts[index] + 1, starts[index + 1] ?? lines.length).join("\n").trim();
  });
}

/** The text `memory-store read --no-ids` prints for `path`, without its header; null when it is not found. */
async function readPath(store: string, path: string): Promise<string | null> {
  return (await readPaths(store, [path]))[0];
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

/** The facts of the contract `name` (path -> text), read in one call; an empty map when it does not exist. */
export async function readContract(store: string, name: string): Promise<ContractFacts> {
  const paths: string[] = [];
  const walk = async (dir: string): Promise<boolean> => {
    const listed = await listDir(store, dir);
    if (listed === null) return false;
    paths.push(...listed.facts);
    for (const sub of listed.dirs) await walk(sub);
    return true;
  };
  if (!(await walk(contractDir(name)))) paths.push(contractDocument(name));
  const texts = await readPaths(store, paths);
  return new Map(paths.flatMap((path, index) => (texts[index] === null ? [] : [[path, texts[index] as string] as const])));
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
  return withLock(join(factoryHome(), "contracts.lock"), "the contracts lock is held by another factory process", LOCK_WAIT_MS, act);
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
