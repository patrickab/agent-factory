/**
 * Contracts: memory-store facts a wave's tasks work by (`<store>/run/contract/<name>/<fact>`, or one document
 * `<store>/run/contract/<name>.md`), the store being the wave's `plan`, read through the `memory-store` CLI.
 * - A task's record keeps a stamp (sha256) per fact; `contractCheck` before a coder turn notes every fact whose hash
 *   differs (a direct edit of the store) besides the notes `contracts.apply` left
 * - `withContractsLock` around an apply and every check, so a change is announced once
 * - Imports only Bun, `node:` and plain plugin modules: the task runner loads it
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { factoryHome } from "./settings.ts";
import { ls, read } from "./store.ts";
import { withLock } from "./lock.ts";
import { listTasks, readTask, writeTask, type ContractStamp, type TaskRecord } from "./tasks.ts";

export const CONTRACT_DIR = "run/contract";
const CONTRACT_NAME = /^[A-Za-z0-9._-]+$/;
const LOCK_WAIT_MS = 30_000;

/** A contract's facts: path in the store -> text. */
export type ContractFacts = Map<string, string>;

export function isContractName(name: string): boolean {
  return CONTRACT_NAME.test(name) && name !== "." && name !== "..";
}

function contractDir(name: string): string {
  return `${CONTRACT_DIR}/${name}`;
}

function contractDocument(name: string): string {
  return `${CONTRACT_DIR}/${name}.md`;
}

/** Whether the contract `name` is a directory of facts, one document, or does not exist (null). */
export async function contractKind(store: string, name: string): Promise<"dir" | "doc" | null> {
  if ((await ls(store, contractDir(name))) !== null) return "dir";
  return (await read(store, [contractDocument(name)]))[0] === null ? null : "doc";
}

/** The facts of the contract `name` (path -> text), read in one call; an empty map when it does not exist. */
export async function readContract(store: string, name: string): Promise<ContractFacts> {
  const paths: string[] = [];
  const walk = async (dir: string): Promise<boolean> => {
    const listed = await ls(store, dir);
    if (listed === null) return false;
    paths.push(...listed.facts);
    for (const sub of listed.dirs) await walk(sub);
    return true;
  };
  if (!(await walk(contractDir(name)))) paths.push(contractDocument(name));
  const texts = await read(store, paths);
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
