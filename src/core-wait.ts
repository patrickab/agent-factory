/**
 * The core's `tasks.wait` (`core.ts` maps it): a supervisor's completion signal over the watched tasks and waves.
 *
 * - Polls until they rest (no runner lives and the state is a resting one, or it is interrupted; a wave: `merged`,
 *   `cancelled`) or one needs attention (a task resting and not `done`; a wave `rejected`, `blocked`,
 *   `waiting_approve`, interrupted, building stuck or queued after a cancelled wave), or the timeout passes. A queued
 *   wave that can still start neither rests nor needs attention: it starts once the waves it waits for merge. One
 *   whose waves all merged with no runner of its own or theirs left is interrupted (`queueStalled`)
 * - Every poll builds the answer's views and judges them; a session file is parsed again only when it changed
 *   (`sessionSummary`)
 */
import { setTimeout as sleep } from "node:timers/promises";
import { stringsParam, tagParam, WAIT_TIMEOUT_MS, type Handler } from "./core-shared.ts";
import { findTask, needsAttention, rests, tasksIn, taskView, type TaskView } from "./core-tasks.ts";
import { findProof, proofNeedsAttention, proofRests, proofView, type ProofView } from "./gates-prove.ts";
import { findWave, lookWave, type WaveLook } from "./core-waves.ts";
import { listTasks, tagInGroup, type TaskRecord } from "./tasks.ts";
import { listWaves, readWave, RESTING_WAVE_STAGES, type WaveFile, type WaveView } from "./waves.ts";
import { FactoryError } from "./util.ts";

const WAIT_POLL_MS = 500;

/**
 * No runner lives and nothing moves the wave on by itself: its stage is a resting one, it is interrupted, or it is
 * stuck (`stuckKeys`: tasks that can never start and nothing else running, where its runner rests too; or queued after
 * a cancelled wave). A queued wave that can still start does not rest: a merge of the waves it waits for starts it.
 */
function waveRests({ view }: WaveLook): boolean {
  return view.interrupted || (!view.running && (view.stuck || (view.stage !== "queued" && RESTING_WAVE_STAGES.includes(view.stage))));
}

/**
 * It waits for the supervisor (invariant 8): resting `rejected`, `blocked`, `waiting_approve` or interrupted, or stuck
 * (building, whether or not its runner has rested yet, or queued after a cancelled wave).
 */
function waveNeedsAttention(look: WaveLook): boolean {
  return look.view.stuck || (waveRests(look) && look.view.attention);
}

/** What a `tasks.wait` watches, read again on every poll: new tasks and waves of a tag count as they appear. */
type Watched = () => Promise<{ records: TaskRecord[]; waves: WaveFile[]; proofs?: string[] }>;

/** `proofs` only when the wait watches gate proofs: the answer of every other wait is as before. */
export type WaitAnswer = { tasks: TaskView[]; waves: WaveView[]; proofs?: ProofView[]; attention: string[]; timedOut: boolean };

/**
 * `tasks.wait`: polls the watched tasks and waves until all rest, one needs attention, the deadline passes or nothing
 * is watched. A cancelled task of a watched wave needs no attention: it left the wave, which goes on without it.
 */
async function waitForTasks(watched: Watched, timeoutMs: number, signal: AbortSignal | undefined): Promise<WaitAnswer> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (signal?.aborted) throw new FactoryError("failed", "tasks.wait was aborted");
    const timedOut = Date.now() >= deadline;
    const { records, waves: files, proofs: proofIds = [] } = await watched();
    const waveIds = new Set(files.map((file) => file.declaration.id));
    // One read of the task records and the waves for every watched wave, as `waves.list` does.
    const all = files.length === 0 ? [] : await listWaves();
    const read = { records: new Map((files.length === 0 ? [] : await listTasks()).map((record) => [record.id, record])) };
    const [tasks, looks, proofs] = await Promise.all([Promise.all(records.map((record) => taskView(record))), Promise.all(files.map((file) => lookWave(file, all, read))), Promise.all(proofIds.map(proofView))]);
    const attention = [
      ...tasks.filter((view) => needsAttention(view) && !(view.state === "cancelled" && view.wave !== null && waveIds.has(view.wave))).map((view) => view.id),
      ...looks.filter(waveNeedsAttention).map((look) => look.view.id),
      ...proofs.filter(proofNeedsAttention).map((proof) => proof.id),
    ];
    const answer = { tasks, waves: looks.map((look) => look.view), ...(proofs.length === 0 ? {} : { proofs }), attention };
    if ((tasks.every(rests) && looks.every(waveRests) && proofs.every(proofRests)) || attention.length > 0) return { ...answer, timedOut: false };
    if (timedOut) return { ...answer, timedOut: true };
    // An abort ends the sleep; the loop head answers it.
    await sleep(Math.max(0, Math.min(WAIT_POLL_MS, deadline - Date.now())), undefined, { signal }).catch(() => undefined);
  }
}

export const WAIT_HANDLERS = {
  "tasks.wait": async (params, { signal }) => {
    const ids = stringsParam("tasks.wait", "ids", params.ids);
    const tag = tagParam("tasks.wait", params.tag);
    const wave = params.wave as string | undefined;
    if ([ids, tag, wave].filter((given) => given !== undefined).length !== 1) throw new FactoryError("invalid", "tasks.wait needs exactly one of ids, tag and wave");
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
      return waitForTasks(async () => ({ records, waves: [], proofs }), timeoutMs, signal);
    }
    if (wave !== undefined) {
      const id = (await findWave(wave)).declaration.id;
      return waitForTasks(async () => ({ records: (await listTasks()).filter((record) => record.wave === id), waves: [await readWave(id)] }), timeoutMs, signal);
    }
    const group = tag as string;
    return waitForTasks(
      async () => ({ records: await tasksIn(undefined, group), waves: (await listWaves()).filter((file) => tagInGroup(file.declaration.tag, group)) }),
      timeoutMs,
      signal,
    );
  },
} satisfies Record<string, Handler>;
