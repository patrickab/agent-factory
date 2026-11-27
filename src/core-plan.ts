/**
 * An adjustable plan: `tasks.update` and `waves.update` (`core.ts` maps them), and the wave runner's side of a task's
 * start (`launchSpec`, `recordStart`), so an update racing it is never lost.
 *
 * - Every change is an `update` event in the wave's log (`waves.ts` folds it), checked and appended under its log lock
 * - A pending task's spec is replaced (`after` checked as at `waves.add`); one the runner launches (a `launch` event
 *   with a live runner, or a record under its declared id: no `task` event yet) or that started keeps its `after` and
 *   `model`, and its coder is told the old and new text: at once while it runs, else on its record for its next coder
 *   turn (the notes `contractCheck` hands to the runner); one being launched as its start is recorded (`recordStart`
 *   against the `launch` event's text, also when a later runner adopts the record)
 * - `waves.update`: the wave's title and reviewer instructions; a review reads them when it starts
 */
import { withContractsLock } from "./contracts.ts";
import { nonEmpty, type Handler, type Params } from "./core-shared.ts";
import { findTask, pendingWaveTask } from "./core-tasks.ts";
import { findWave, lookWave } from "./core-waves.ts";
import { liveRunners, messageTask, type RunnerEnv } from "./launch.ts";
import { lastFactoryState } from "./runner.ts";
import { requireModels } from "./models.ts";
import type { ModelSize } from "./settings.ts";
import { readTask, writeTask, type TaskRecord } from "./tasks.ts";
import { FactoryError, short } from "./util.ts";
import { liveWaveRunners, pokeWave } from "./wave-poke.ts";
import { appendWaveEvents, checkTaskGraph, foldWave, readWave, WAVE_FINAL_STAGES, type FoldedTask, type NewWaveEvent, type WaveFold } from "./waves.ts";

/** A task's text as its coder knows it. */
type TaskText = Pick<FoldedTask, "title" | "request">;

/** The follow-up of a changed task: the fields that differ, old and new. Null when none does. */
export function taskChangeNote(old: TaskText, now: TaskText): string | null {
  const fields = (["title", "request"] as const).filter((field) => old[field] !== now[field]);
  if (fields.length === 0) return null;
  return ["Your task changed, follow the new text:", ...fields.map((field) => `- ${field}\n  old: ${old[field]}\n  new: ${now[field]}`)].join("\n");
}

/** Leaves `note` on the task's record: the runner hands it to the coder before its next turn (`contractCheck`). */
async function keepNote(id: string, note: string): Promise<void> {
  await withContractsLock(async () => {
    const record = await readTask(id);
    await writeTask({ ...record, contractNotes: [...(record.contractNotes ?? []), note] });
  });
}

/**
 * Tells the task's coder `note`: a running task with a live runner gets it as a follow-up now ("sent"); otherwise, or
 * when that fails, it waits on the record for the next coder turn ("kept").
 */
async function tellTask(record: TaskRecord, note: string): Promise<"sent" | "kept"> {
  const state = (await lastFactoryState(record.sessionDir, record.sessionId))?.state;
  if (state === "running" && (await liveRunners(record)).length > 0) {
    const sent = await messageTask(record, note).then(
      () => true,
      () => false,
    );
    if (sent) return "sent";
  }
  await keepNote(record.id, note);
  return "kept";
}

/**
 * The runner is about to launch the pending task `key`: records a `launch` event and resolves with its spec as folded
 * under the log lock (the latest update in), null when it is no longer pending, the wave no longer builds or its `after`
 * is no longer the one (`after`) the scheduler found done.
 */
export async function launchSpec(id: string, key: string, after: readonly string[]): Promise<FoldedTask | null> {
  let spec = null as FoldedTask | null;
  await appendWaveEvents(id, (fold) => {
    const task = fold.tasks.find((candidate) => candidate.key === key);
    if (fold.stage !== "building" || task === undefined || task.taskId !== null || task.dropped) return null;
    // Its `after` changed since the scheduler judged it startable: the next look judges it again.
    if (task.after.length !== after.length || task.after.some((name) => !after.includes(name))) return null;
    spec = { ...task, after: [...task.after] };
    return [{ kind: "launch", key, title: task.title, request: task.request }];
  });
  return spec;
}

/**
 * Records the start of the task `key` (its `task` event), launched with `launched`'s text. A `tasks.update` that came
 * between the launch and now changed the text: its coder is told (`tellTask`). Resolves with the note, null when none.
 */
export async function recordStart(id: string, key: string, launched: TaskText, record: TaskRecord): Promise<string | null> {
  let now: TaskText = launched;
  await appendWaveEvents(id, (fold) => {
    const task = fold.tasks.find((candidate) => candidate.key === key);
    if (task !== undefined) now = { title: task.title, request: task.request };
    return [{ kind: "task", key, taskId: record.id, sessionId: record.sessionId }];
  });
  const note = taskChangeNote(launched, now);
  if (note !== null) await tellTask(record, note);
  return note;
}

function textParam(action: string, params: Params, key: "title" | "request"): string | undefined {
  if (params[key] === undefined) return undefined;
  const value = nonEmpty(params[key]);
  if (value === undefined || value.trim() === "") throw new FactoryError("invalid", `${action}: ${key} must not be empty`);
  return value;
}

/** Where the update went: the declaration (pending), the coder now, its next turn, or its start (being launched). */
type Delivery = "pending" | "sent" | "kept" | "starting";

async function updateTask(params: Params, env?: RunnerEnv): Promise<unknown> {
  const wanted = nonEmpty(params.id)?.trim();
  if (wanted === undefined || wanted === "") throw new FactoryError("invalid", "tasks.update needs the id of a wave's task (waves.get shows a pending one's)");
  const title = textParam("tasks.update", params, "title");
  const request = textParam("tasks.update", params, "request");
  const after = params.after === undefined ? undefined : [...new Set(params.after as string[])];
  const model = params.model as ModelSize | undefined;
  if (title === undefined && request === undefined && after === undefined && model === undefined) throw new FactoryError("invalid", "tasks.update needs title, request, after or model");

  let waveId: string;
  let key: string;
  // A started task (or one being launched) has its record; a pending one only its id in its wave's log.
  const pending = await pendingWaveTask(wanted);
  let record: TaskRecord | undefined;
  try {
    record = await findTask(wanted);
  } catch (error) {
    if (pending === undefined || !(error instanceof FactoryError) || (error.code !== "refused" && error.code !== "not_found")) throw error;
  }
  if (record !== undefined) {
    const { id, wave } = record;
    if (wave === null) throw new FactoryError("refused", `task ${short(id)} belongs to no wave; send it a message with tasks.message`);
    waveId = wave;
    const file = await readWave(waveId);
    const found = foldWave(file.declaration, file.events).tasks.find((task) => task.taskId === id || task.id === id);
    if (found === undefined) throw new FactoryError("not_found", `task ${short(id)} is not in its wave's log`);
    key = found.key;
  } else {
    ({ wave: waveId, key } = pending as NonNullable<typeof pending>);
  }
  const shown = short(waveId);
  const file = await readWave(waveId);
  if (model === "small") await requireModels({ small: file.declaration.overrides.models?.small });
  // A started task's state, read before the log lock (its session, not its log).
  const before = foldWave(file.declaration, file.events).tasks.find((task) => task.key === key);
  const startedRecord = before?.taskId ? await readTask(before.taskId).catch(() => undefined) : undefined;
  const state = startedRecord === undefined ? undefined : (await lastFactoryState(startedRecord.sessionDir, startedRecord.sessionId))?.state;

  const refuse = (why: string) => new FactoryError("refused", `task ${key} of wave ${shown} ${why}`);
  // Set by the check under the log lock (a closure: typed wide on purpose).
  let delivery = "pending" as Delivery;
  let old: TaskText = { title: "", request: "" };
  let taskId = null as string | null;
  const appended = await appendWaveEvents(waveId, async (fold) => {
    if (WAVE_FINAL_STAGES.includes(fold.stage)) throw new FactoryError("refused", `wave ${shown} is ${fold.stage}, its tasks cannot change`);
    const task = fold.tasks.find((candidate) => candidate.key === key);
    if (task === undefined) throw new FactoryError("not_found", `wave ${shown} has no task ${key}`);
    if (task.dropped) throw refuse("was dropped (it could never start): add a task with waves.add");
    old = { title: task.title, request: task.request };
    taskId = task.taskId;
    const event: NewWaveEvent = { kind: "update", key };
    // Read under the log lock, so no launch slips in between. A record under its declared id: `launchTask` wrote it,
    // its coder has the launched text (a runner that died before its `task` event; the next one adopts it). A `launch`
    // event without a live runner and without a record is a launch that died with it: the task is pending.
    const recorded = task.taskId === null && task.id !== undefined && (await readTask(task.id).then(() => true, () => false));
    const launching = task.taskId === null && (recorded || (task.launching === true && (await liveWaveRunners(waveId)).length > 0));
    if (task.taskId === null && !launching) {
      // The changed task first: a cycle through it is named from it.
      if (after !== undefined) checkTaskGraph([{ key, after }, ...fold.tasks.filter((other) => other.key !== key)]);
      if (after !== undefined && after.join("\0") !== task.after.join("\0")) event.after = after;
      if (model !== undefined && model !== task.model) event.model = model;
    } else {
      // Started since the state was read: it has just begun, as good as one being launched.
      const current = task.taskId !== null && task.taskId === before?.taskId ? (state ?? "starting") : "starting";
      if (current === "done" || current === "cancelled" || current === "merging") throw refuse(`is ${current}, it cannot change: add a task with waves.add`);
      if (current === "waiting_approve") throw refuse("waits for approve, its work is finished: add a task with waves.add");
      if (after !== undefined || model !== undefined) throw refuse(`has started (${current}): its after and model are fixed; change only title or request, or add a task with waves.add`);
      delivery = task.taskId === null ? "starting" : "kept";
    }
    if (title !== undefined && title !== task.title) event.title = title;
    if (request !== undefined && request !== task.request) event.request = request;
    return Object.keys(event).length > 2 ? [event] : null;
  });
  if (appended !== null && delivery === "kept" && taskId !== null) {
    const note = taskChangeNote(old, { title: title ?? old.title, request: request ?? old.request });
    const record = await readTask(taskId).catch(() => undefined);
    if (note !== null && record !== undefined) delivery = await tellTask(record, note);
  }
  // A pending task's new `after` may let it start now; a failed poke is left to the next one.
  if (appended !== null && delivery === "pending") await pokeWave(waveId, env).catch(() => undefined);
  return { wave: (await lookWave(await readWave(waveId))).view, key, changed: appended !== null, delivery };
}

async function updateWave(params: Params): Promise<unknown> {
  const title = textParam("waves.update", params, "title");
  const request = textParam("waves.update", params, "request");
  if (title === undefined && request === undefined) throw new FactoryError("invalid", "waves.update needs title or request");
  const { id } = (await findWave(params.id)).declaration;
  const appended = await appendWaveEvents(id, (fold) => {
    if (WAVE_FINAL_STAGES.includes(fold.stage)) throw new FactoryError("refused", `wave ${short(id)} is ${fold.stage}, it cannot change`);
    const event: NewWaveEvent = { kind: "update" };
    if (title !== undefined && title !== fold.title) event.title = title;
    if (request !== undefined && request !== fold.request) event.request = request;
    return Object.keys(event).length > 1 ? [event] : null;
  });
  return { wave: (await lookWave(await readWave(id))).view, changed: appended !== null };
}

export const PLAN_HANDLERS = {
  "tasks.update": (params, { env }) => updateTask(params, env),
  "waves.update": (params) => updateWave(params),
} satisfies Record<string, Handler>;
