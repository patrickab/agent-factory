/**
 * The core's `tasks.wait` (`core.ts` maps it): a supervisor's completion signal over the watched tasks and waves.
 *
 * - Polls until they rest (no runner lives and the state is a resting one, or it is interrupted; a wave: `merged`,
 *   `cancelled`) or one needs attention (a task resting and not `done`; a wave `rejected`, `blocked`,
 *   `waiting_approve`, interrupted, building stuck or queued after a cancelled wave), or the timeout passes. A queued
 *   wave that can still start neither rests nor needs attention: it starts once the waves it waits for merge. One
 *   whose waves all merged with no runner of its own or theirs left is interrupted (`queueStalled`)
 * - A poll reads only what changed in the session files and looks for runners only where that decides; full views
 *   (`core-tasks.ts`, `core-waves.ts`) are built only for an answer
 */
import { stat } from "node:fs/promises";
import type { ActionName } from "./core.ts";
import { FactoryError, stringsParam, tagParam, WAIT_TIMEOUT_MS, type Handler } from "./core-shared.ts";
import { findTask, needsAttention, rests, tasksIn, taskView, type TaskView } from "./core-tasks.ts";
import { findProof, proofNeedsAttention, proofRests, proofView, type ProofView } from "./gates-prove.ts";
import { findWave, queueLook, queueStalled, waveLook, type WaveLook } from "./core-waves.ts";
import { liveRunners } from "./launch.ts";
import { readFactoryStates, sessionFilePath } from "./runner.ts";
import type { State } from "./state.ts";
import { listTasks, tagInGroup, type TaskRecord } from "./tasks.ts";
import { foldWave, listWaves, readWave, RESTING_WAVE_STAGES, stuckKeys, type WaveFile, type WaveStage, type WaveView } from "./waves.ts";
import { liveWaveRunners } from "./wave-poke.ts";

const WAIT_POLL_MS = 500;

/** The last `factory-state` of each watched session file, by task id, with the file's size and mtime it was read at. */
type WaitStates = Map<string, { size: number; mtimeMs: number; state: State | null }>;

/** The task's last state, the session file read again only when its size or mtime changed since the last poll. */
async function polledState(record: TaskRecord, cache: WaitStates): Promise<State | null> {
  const path = await sessionFilePath(record.sessionDir, record.sessionId);
  if (path === undefined) return null;
  const { size, mtimeMs } = await stat(path);
  const cached = cache.get(record.id);
  if (cached?.size === size && cached.mtimeMs === mtimeMs) return cached.state;
  const state = ((await readFactoryStates(record.sessionDir, record.sessionId)).last?.state as State | undefined) ?? null;
  cache.set(record.id, { size, mtimeMs, state });
  return state;
}

/**
 * Whether the watched tasks may end the wait (`rests`, `needsAttention`), from their states and only the runner
 * lookups that can change the answer: a task without a state never rests, and `done` ones matter only once every
 * other task rests and no watched wave is busy (`wavesBusy`).
 */
async function waitMayEnd(records: TaskRecord[], states: (State | null)[], wavesBusy: boolean): Promise<boolean> {
  const runs = async (record: TaskRecord) => (await liveRunners(record)).length > 0;
  for (const [index, record] of records.entries()) {
    const state = states[index];
    if (state !== null && state !== "done" && !(await runs(record))) return true;
  }
  if (wavesBusy || states.some((state) => state !== "done")) return false;
  for (const record of records) if (await runs(record)) return false;
  return true;
}

/** The stages a resting wave waits for the supervisor in (`interrupted` too). */
const WAVE_ATTENTION_STAGES: readonly WaveStage[] = ["rejected", "blocked", "waiting_approve"];

/**
 * No runner lives and nothing moves the wave on by itself: its stage is a resting one, it is interrupted, or it is
 * stuck (`stuckKeys`: tasks that can never start and nothing else running, where its runner rests too; or queued after
 * a cancelled wave). A queued wave that can still start does not rest: a merge of the waves it waits for starts it.
 */
function waveRests({ view, stuck }: WaveLook): boolean {
  return view.interrupted || (!view.running && (stuck || (view.stage !== "queued" && RESTING_WAVE_STAGES.includes(view.stage))));
}

/**
 * It waits for the supervisor (invariant 8): resting `rejected`, `blocked`, `waiting_approve` or interrupted, or stuck
 * (building, whether or not its runner has rested yet, or queued after a cancelled wave).
 */
function waveNeedsAttention(look: WaveLook): boolean {
  return look.stuck || (waveRests(look) && (look.view.interrupted || WAVE_ATTENTION_STAGES.includes(look.view.stage)));
}

/**
 * One cheap look at the watched waves (their logs, the polled states of a building wave's tasks, a runner lookup only
 * for a wave that does not rest): `attention` when one may need it (a resting stage that asks for it, a building wave
 * stuck, a queued one that can never start, or no runner where one should live), `busy` when one still moves (a runner
 * builds, reviews or merges it, or it is queued and can still start). `all`: every wave, read once per poll.
 * `stateOf` is a started task's state, `undefined` when its record is gone (it counts as cancelled).
 */
async function pollWaves(
  files: WaveFile[],
  stateOf: (taskId: string) => Promise<State | null | undefined>,
  all: () => Promise<WaveFile[]>,
): Promise<{ attention: boolean; busy: boolean }> {
  let attention = false;
  let busy = false;
  for (const file of files) {
    const fold = foldWave(file.declaration, file.events);
    if (fold.stage === "queued") {
      const look = await queueLook(fold, await all());
      if (look.never !== null) attention = true;
      else if (look.waiting.length === 0 && (await queueStalled(fold, look, (await liveWaveRunners(fold.id)).length > 0))) attention = true;
      else busy = true;
      continue;
    }
    if (RESTING_WAVE_STAGES.includes(fold.stage)) {
      attention ||= WAVE_ATTENTION_STAGES.includes(fold.stage);
      continue;
    }
    if (fold.stage === "building") {
      const states = new Map<string, string | null>();
      for (const task of fold.tasks) {
        if (task.taskId === null) continue;
        const state = await stateOf(task.taskId);
        states.set(task.key, state === undefined ? "cancelled" : state);
      }
      if (stuckKeys(fold, states).length > 0) {
        attention = true;
        continue;
      }
    }
    if ((await liveWaveRunners(file.declaration.id)).length > 0) busy = true;
    else attention = true;
  }
  return { attention, busy };
}

/** What a `tasks.wait` watches, read again on every poll: new tasks and waves of a tag count as they appear. */
type Watched = () => Promise<{ records: TaskRecord[]; waves: WaveFile[]; proofs?: string[] }>;

/** `proofs` only when the wait watches gate proofs: the answer of every other wait is as before. */
type WaitAnswer = { tasks: TaskView[]; waves: WaveView[]; proofs?: ProofView[]; attention: string[]; timedOut: boolean };

/**
 * `tasks.wait`: polls the watched tasks and waves until all rest, one needs attention, the deadline passes or nothing
 * is watched. A poll reads only what changed in the session files and looks for runners only where that decides; full
 * views are built only for an answer. A cancelled task of a watched wave needs no attention: it left the wave, which
 * goes on without it.
 */
async function waitForTasks(watched: Watched, ignore: string[], timeoutMs: number, signal: AbortSignal | undefined): Promise<WaitAnswer> {
  const deadline = Date.now() + timeoutMs;
  const ignored = (id: string) => ignore.some((prefix) => id.startsWith(prefix));
  const cache: WaitStates = new Map();
  while (true) {
    if (signal?.aborted) throw new FactoryError("failed", "tasks.wait was aborted");
    const all = await watched();
    const files = all.waves.filter((file) => !ignored(file.declaration.id));
    const waveIds = new Set(files.map((file) => file.declaration.id));
    const records = all.records.filter((record) => !ignored(record.id));
    const leftWave = (record: TaskRecord, state: State | null) => state === "cancelled" && record.wave !== null && waveIds.has(record.wave);
    const timedOut = Date.now() >= deadline;
    const byId = new Map(all.records.map((record) => [record.id, record]));
    const proofs = await Promise.all((all.proofs ?? []).filter((id) => !ignored(id)).map(proofView));
    const proofsBusy = proofs.some((proof) => !proofRests(proof));
    const proofsAttention = proofs.some(proofNeedsAttention);
    let everyWave: Promise<WaveFile[]> | undefined;
    const waves = await pollWaves(
      files,
      async (taskId) => {
        const record = byId.get(taskId);
        return record === undefined ? undefined : polledState(record, cache);
      },
      () => (everyWave ??= listWaves()),
    );
    const states = (await Promise.all(records.map((record) => polledState(record, cache)))).map((state, index) => (leftWave(records[index], state) ? "done" : state));
    if (timedOut || waves.attention || proofsAttention || (await waitMayEnd(records, states, waves.busy || proofsBusy))) {
      const tasks = await Promise.all(records.map((record) => taskView(record)));
      const looks = await Promise.all(files.map(waveLook));
      const waveViews = looks.map((look) => look.view);
      const attention = [
        ...tasks.filter((view) => needsAttention(view) && !(view.state === "cancelled" && view.wave !== null && waveIds.has(view.wave))).map((view) => view.id),
        ...looks.filter(waveNeedsAttention).map((look) => look.view.id),
        ...proofs.filter(proofNeedsAttention).map((proof) => proof.id),
      ];
      // The views are read after the poll: a task or wave that moved on in between is polled again. `proofs` only when it watches some.
      const shown = proofs.length === 0 ? {} : { proofs };
      if ((tasks.every(rests) && looks.every(waveRests) && proofs.every(proofRests)) || attention.length > 0) return { tasks, waves: waveViews, ...shown, attention, timedOut: false };
      if (timedOut) return { tasks, waves: waveViews, ...shown, attention, timedOut: true };
    }
    await abortableSleep(Math.min(WAIT_POLL_MS, deadline - Date.now()), signal);
  }
}

/** Sleeps `ms`, less when `signal` aborts first. */
async function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((done) => {
    const wake = () => {
      clearTimeout(timer);
      done();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", wake);
      done();
    }, ms);
    signal?.addEventListener("abort", wake, { once: true });
  });
}

export const WAIT_HANDLERS = {
  "tasks.wait": async (params, { signal }) => {
    const ids = stringsParam("tasks.wait", "ids", params.ids);
    const tag = tagParam("tasks.wait", params.tag);
    const wave = params.wave as string | undefined;
    if ([ids, tag, wave].filter((given) => given !== undefined).length !== 1) throw new FactoryError("invalid", "tasks.wait needs exactly one of ids, tag and wave");
    const ignore = stringsParam("tasks.wait", "ignore", params.ignore) ?? [];
    const timeoutMs = (params.timeoutMs as number | undefined) ?? WAIT_TIMEOUT_MS.default;
    if (ids !== undefined) {
      // Ids are resolved once: a prefix that turns ambiguous later must not end the wait. One no task has may be a proof's.
      const records: TaskRecord[] = [];
      const proofs: string[] = [];
      for (const id of ids) {
        const record = await findTask(id).catch(async (error: unknown) => {
          if (!(error instanceof FactoryError && error.code === "not_found")) throw error;
          proofs.push(await findProof(id).catch(() => Promise.reject(error)));
          return undefined;
        });
        if (record !== undefined) records.push(record);
      }
      return waitForTasks(async () => ({ records, waves: [], proofs }), ignore, timeoutMs, signal);
    }
    if (wave !== undefined) {
      const id = (await findWave(wave)).declaration.id;
      return waitForTasks(async () => ({ records: (await listTasks()).filter((record) => record.wave === id), waves: [await readWave(id)] }), ignore, timeoutMs, signal);
    }
    const group = tag as string;
    return waitForTasks(
      async () => ({ records: await tasksIn(undefined, group), waves: (await listWaves()).filter((file) => tagInGroup(file.declaration.tag, group)) }),
      ignore,
      timeoutMs,
      signal,
    );
  },
} satisfies Partial<Record<ActionName, Handler>>;
