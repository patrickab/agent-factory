/**
 * The core's contract actions (`contracts.apply`) and the check of `waves.start`'s `contracts`.
 * - `contracts.apply`: one memory-store op on one fact, under the contracts lock. A running task of a wave listing the
 *   contract gets the follow-up at once, another started one on its record for its next turn; its stamp is stored
 *   either way, so `contractCheck` says it once. Pending tasks read the contract at their launch
 */
import { contractKind, contractNote, CONTRACT_DIR, factChanges, isContractName, memoryStore, memoryStoreOnPath, readContract, stampOf, withContractsLock } from "./contracts.ts";
import { nonEmpty, oneLine, type Handler, type Params } from "./core-shared.ts";
import { messageTask } from "./launch.ts";
import { lastFactoryState } from "./runner.ts";
import { listTasks, readTask, writeTask, type TaskRecord } from "./tasks.ts";
import { FactoryError, isRecord, outputTail } from "./util.ts";
import { appendWaveEvent, foldWave, listWaves } from "./waves.ts";

const OPS = ["add", "update", "retire", "write_doc"];

function requireMemoryStore(name: string): void {
  if (!memoryStoreOnPath()) throw new FactoryError("refused", `${name}: memory-store is not on PATH, contracts need it`);
}

/**
 * The contracts of a wave declared with `contracts` (undefined: none, nothing is read). `core` comes first when the store
 * holds it. Throws `invalid` for a bad name or no `plan`, `refused` without memory-store or for an unknown contract.
 */
export async function waveContracts(plan: string | undefined, raw: string[] | undefined): Promise<string[] | undefined> {
  if (raw === undefined) return undefined;
  if (plan === undefined) throw new FactoryError("refused", "waves.start: contracts need plan, the memory-store that holds them");
  const bad = raw.find((name) => !isContractName(name));
  if (bad !== undefined) throw new FactoryError("invalid", `waves.start: ${JSON.stringify(bad)} is no contract name (A-Z a-z 0-9 . _ -)`);
  requireMemoryStore("waves.start");
  const given = [...new Set(raw as string[])];
  for (const name of given) {
    if ((await contractKind(plan, name)) === null) throw new FactoryError("refused", `waves.start: memory-store ${plan} has no contract ${name} (${CONTRACT_DIR}/${name}/ or ${CONTRACT_DIR}/${name}.md)`);
  }
  // Each once, `core` first: named, or read from the store when it holds it.
  const names = given.filter((name) => name !== "core");
  if (given.includes("core") || (await contractKind(plan, "core")) !== null) names.unshift("core");
  return names.length === 0 ? undefined : names;
}

/** The op with its path in the store: a fact inside the contract's directory, or the contract's one document. */
async function storeOp(store: string, name: string, raw: unknown): Promise<Params> {
  if (!isRecord(raw) || typeof raw.op !== "string" || !OPS.includes(raw.op)) throw new FactoryError("invalid", `contracts.apply: op must be an object whose op is one of ${OPS.join(", ")}`);
  const kind = await contractKind(store, name);
  if (kind === null) throw new FactoryError("not_found", `memory-store ${store} has no contract ${name}`);
  const dir = `${CONTRACT_DIR}/${name}/`;
  const given = raw.path === undefined ? undefined : nonEmpty(raw.path);
  if (raw.path !== undefined && given === undefined) throw new FactoryError("invalid", "contracts.apply: op.path must be a non-empty string");
  if (kind === "doc") {
    const document = `${CONTRACT_DIR}/${name}.md`;
    if (raw.op !== "write_doc") throw new FactoryError("refused", `contracts.apply: the contract ${name} is one document, only write_doc changes it`);
    if (given !== undefined && given !== `${name}.md` && given !== document) throw new FactoryError("invalid", `contracts.apply: the contract ${name} is the one document ${document}`);
    return { ...raw, path: document };
  }
  if (given === undefined) throw new FactoryError("invalid", "contracts.apply: op.path names the fact (its path inside the contract)");
  const path = given.startsWith(dir) ? given : `${dir}${given}`;
  if (path.split("/").some((part) => part === "" || part === "." || part === "..")) throw new FactoryError("invalid", `contracts.apply: ${given} is no fact path inside the contract ${name}`);
  return { ...raw, path };
}

type Listed = { wave: string; tag: string; key: string; task: string };

async function applyContract(params: Params): Promise<unknown> {
  const store = nonEmpty(params.store);
  const name = nonEmpty(params.name);
  if (store === undefined) throw new FactoryError("invalid", "contracts.apply needs store, the memory-store of the contract");
  if (name === undefined || !isContractName(name)) throw new FactoryError("invalid", "contracts.apply needs name, a contract name (A-Z a-z 0-9 . _ -)");
  requireMemoryStore("contracts.apply");
  return withContractsLock(async () => {
    const op = await storeOp(store, name, params.op);
    const before = await readContract(store, name);
    const applied = await memoryStore(["apply", store, "--ops", JSON.stringify([op])]);
    if (!applied.ok) throw new FactoryError("failed", `memory-store apply: ${oneLine(outputTail(applied.output, 500))}`);
    const after = await readContract(store, name);
    const changes = factChanges(before, after);
    const answer = { store, name, changed: changes.map((change) => change.path), notified: [] as Listed[], kept: [] as Listed[], done: [] as Listed[] };
    if (changes.length === 0) return answer;
    const note = contractNote(name, changes);
    const stamp = stampOf(after);
    const records = new Map((await listTasks()).map((record) => [record.id, record]));
    for (const file of await listWaves()) {
      const fold = foldWave(file.declaration, file.events);
      if (fold.plan !== store || !(fold.contracts ?? []).includes(name) || fold.stage === "cancelled") continue;
      const done: string[] = [];
      for (const task of fold.tasks) {
        // A task launched before its `task` event (its runner writes it next, or adopts the record) has its record under its declared id.
        const record = records.get(task.taskId ?? task.id ?? "");
        if (record === undefined) continue;
        const state = (await lastFactoryState(record.sessionDir, record.sessionId))?.state;
        const listed = { wave: fold.id, tag: fold.tag, key: task.key, task: record.id };
        if (state === "done") {
          done.push(task.key);
          answer.done.push(listed);
        } else if (state !== undefined && state !== "cancelled") {
          answer[(await notifyTask(record, name, stamp, note, state === "running")) ? "notified" : "kept"].push(listed);
        }
      }
      if (done.length > 0) await appendWaveEvent(fold.id, { kind: "contract", name, paths: answer.changed, done });
    }
    return answer;
  });
}

/**
 * Stores the contract's new stamp on the task's record; a running task gets `note` at once (true), any other keeps it
 * on its record for its next coder turn, as does a running one the message did not reach.
 */
async function notifyTask(found: TaskRecord, name: string, stamp: ReturnType<typeof stampOf>, note: string, running: boolean): Promise<boolean> {
  const record = await readTask(found.id);
  const contracts = { ...(record.contracts ?? {}), [name]: stamp };
  if (running) {
    await writeTask({ ...record, contracts });
    // A message that cannot go now (the task merges, another action holds it) waits on the record for its next turn.
    const sent = await messageTask(record, note).then(
      () => true,
      () => false,
    );
    if (sent) return true;
  }
  await writeTask({ ...record, contracts, contractNotes: [...(record.contractNotes ?? []), note] });
  return false;
}

export const CONTRACT_HANDLERS = {
  "contracts.apply": (params) => applyContract(params),
} satisfies Record<string, Handler>;
