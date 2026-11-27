/**
 * An adjustable plan: `tasks.update` and `waves.update`, and the wave runner's side of a task's launch (`launchSpec`).
 * - Every change is an `update` event in the wave's log, checked and appended under its log lock
 * - Only a pending task changes; a started one (or one being launched) gets its change with `tasks.message`
 */
import { nonEmpty, type Handler, type Params } from "./core-shared.ts";
import { findTask, pendingWaveTask } from "./core-tasks.ts";
import { findWave, lookWave } from "./core-waves.ts";
import type { RunnerEnv } from "./launch.ts";
import { requireModels } from "./models.ts";
import type { ModelSize } from "./settings.ts";
import { readTask } from "./tasks.ts";
import { FactoryError, short } from "./util.ts";
import { liveWaveRunners, pokeWave } from "./wave-poke.ts";
import { appendWaveEvents, checkTaskGraph, foldWave, readWave, WAVE_FINAL_STAGES, type FoldedTask, type NewWaveEvent } from "./waves.ts";

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
    return [{ kind: "launch", key }];
  });
  return spec;
}

function textParam(action: string, params: Params, key: "title" | "request"): string | undefined {
  if (params[key] === undefined) return undefined;
  const value = nonEmpty(params[key]);
  if (value === undefined || value.trim() === "") throw new FactoryError("invalid", `${action}: ${key} must not be empty`);
  return value;
}

const started = (key: string, wave: string) => new FactoryError("refused", `task ${key} of wave ${short(wave)} has started: send it the change with tasks.message, or add a task with waves.add`);

async function updateTask(params: Params, env?: RunnerEnv): Promise<unknown> {
  const wanted = nonEmpty(params.id)?.trim();
  if (wanted === undefined || wanted === "") throw new FactoryError("invalid", "tasks.update needs the id of a wave's pending task (waves.get shows it)");
  const title = textParam("tasks.update", params, "title");
  const request = textParam("tasks.update", params, "request");
  const after = params.after === undefined ? undefined : [...new Set(params.after as string[])];
  const model = params.model as ModelSize | undefined;
  if (title === undefined && request === undefined && after === undefined && model === undefined) throw new FactoryError("invalid", "tasks.update needs title, request, after or model");

  // A pending task has only its declared id in its wave's log; a started one has its record.
  const pending = await pendingWaveTask(wanted);
  if (pending === undefined) {
    const { id, wave } = await findTask(wanted);
    if (wave === null) throw new FactoryError("refused", `task ${short(id)} belongs to no wave; send it a message with tasks.message`);
    const file = await readWave(wave);
    throw started(foldWave(file.declaration, file.events).tasks.find((task) => task.taskId === id)?.key ?? short(id), wave);
  }
  const { wave: waveId, key } = pending;
  const shown = short(waveId);
  if (model === "small") await requireModels({ small: (await readWave(waveId)).declaration.overrides.models?.small });

  const appended = await appendWaveEvents(waveId, async (fold) => {
    if (WAVE_FINAL_STAGES.includes(fold.stage)) throw new FactoryError("refused", `wave ${shown} is ${fold.stage}, its tasks cannot change`);
    const task = fold.tasks.find((candidate) => candidate.key === key);
    if (task === undefined) throw new FactoryError("not_found", `wave ${shown} has no task ${key}`);
    if (task.dropped) throw new FactoryError("refused", `task ${key} of wave ${shown} was dropped (it could never start): add a task with waves.add`);
    // Read under the log lock, so no launch slips in between. A record under its declared id: `launchTask` wrote it
    // (a runner that died before its `task` event; the next one adopts it). A `launch` event without a live runner and
    // without a record is a launch that died with it: the task is pending.
    const recorded = await readTask(task.id).then(() => true, () => false);
    if (task.taskId !== null || recorded || (task.launching === true && (await liveWaveRunners(waveId)).length > 0)) throw started(key, waveId);
    // The changed task first: a cycle through it is named from it.
    if (after !== undefined) checkTaskGraph([{ key, after }, ...fold.tasks.filter((other) => other.key !== key)]);
    const event: NewWaveEvent = { kind: "update", key };
    if (title !== undefined && title !== task.title) event.title = title;
    if (request !== undefined && request !== task.request) event.request = request;
    if (after !== undefined && after.join("\0") !== task.after.join("\0")) event.after = after;
    if (model !== undefined && model !== task.model) event.model = model;
    return Object.keys(event).length > 2 ? [event] : null;
  });
  // A new `after` may let it start now; a failed poke is left to the next one.
  if (appended !== null) await pokeWave(waveId, env).catch(() => undefined);
  return { wave: (await lookWave(waveId)).view, key, changed: appended !== null };
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
  return { wave: (await lookWave(id)).view, changed: appended !== null };
}

export const PLAN_HANDLERS = {
  "tasks.update": (params, { env }) => updateTask(params, env),
  "waves.update": (params) => updateWave(params),
} satisfies Record<string, Handler>;
