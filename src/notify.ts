/**
 * Notifications (invariant 9): what the factory tells the Pi session that started a task or declared a wave, without
 * being asked, when it needs the supervisor or a wave merged. Pure: no I/O. Delivery is `notified.ts` and the Pi
 * extension (`pi/notifier.ts`).
 *
 * - `pendingNotices(tasks, waves, delivered)`: one `Notice` per event not in `delivered`, only for an `origin` (a task or
 *   wave declared without a Pi session gets none: `tasks.wait` is the way there)
 * - Task events: `waiting_answer`, `blocked`, `interrupted`, `waiting_approve`; only for a task outside a wave, or a
 *   wave's task while its wave builds (past `building` the wave's own notice covers it)
 * - Wave events: `rejected`, `blocked`, `waiting_approve`, `interrupted`, `unreachable` (building with tasks that can
 *   never start, nothing else moving it), `never` (queued after a wave that was cancelled), `merged`. A queued wave
 *   that can still start says nothing
 * - Gate proof events (`gates-prove.ts`): `passed`, `flaky`, `failing`, `interrupted`; key `proof:<id>:<event>`
 * - `contract` events (`contracts.apply` changed a contract the wave's done tasks worked by): one notice each, key
 *   `wave:<id>:contract:<index of the event>`
 * - `key` = `<task|wave>:<id>:<event>:<n>`. A task's n is its round, with the state entry's time after `@`: a coder may
 *   ask twice in one round. A wave's n is the index of its last `stage` event in the log for a stage; for
 *   `interrupted`, which no stage event marks, the length of its log; for `unreachable` the keys of the tasks that can
 *   never start (`unreachableTasks`), not the log's length: the runner's `building` event naming them lands after the
 *   task state that made them so, and must not make the same event a second one (invariant 12); for `never` the waves
 *   it waits for: it can never start only once
 * - `text`: `factory: <what happened>`, then the agent view block of the task or wave (a rejection carries its findings)
 * - Scouts a session started (caller `session`): one notice when the scout ended (`done`, `failed`, `cancelled`,
 *   interrupted), key `scout:<id>:report` (`scoutNoticeKey`), text the scout's block with its report and the report's
 *   path. A call that waited for the report claims the same key
 */
import { neverStarts, proofBlock, taskBlock, unreachableTasks, waveBlock } from "./agent-view.ts";
import type { ProofView } from "./gates-prove.ts";
import type { TaskView } from "./core.ts";
import { scoutBlock } from "./scout-view.ts";
import type { ScoutView } from "./scouts.ts";
import type { WaveView } from "./waves.ts";

export type Notice = { key: string; origin: string; text: string };

/**
 * A wave as notifications judge it: its view, whether it is stuck (builds with tasks that can never start, or is queued
 * after a cancelled wave: `WaveLook`), the kinds of its log's events.
 */
export type NoticeWave = { view: WaveView; stuck: boolean; events: readonly { kind: string }[] };

const TASK_EVENTS: Record<string, string> = {
  waiting_answer: "a coder asks",
  blocked: "is blocked",
  waiting_approve: "waits for tasks.approve",
};

function taskEvent(task: TaskView): string | null {
  if (task.running || task.state === null) return null;
  if (task.interrupted) return "interrupted";
  return Object.hasOwn(TASK_EVENTS, task.state) ? task.state : null;
}

function taskNotice(task: TaskView, origin: string): Notice | null {
  const event = taskEvent(task);
  if (event === null) return null;
  const what = event === "waiting_answer" ? TASK_EVENTS[event] : event === "interrupted" ? `task ${task.id.slice(0, 8)} was interrupted` : `task ${task.id.slice(0, 8)} ${TASK_EVENTS[event]}`;
  return { key: `task:${task.id}:${event}:${task.round ?? 0}@${task.at ?? ""}`, origin, text: `factory: ${what}\n${taskBlock(task)}` };
}

const WAVE_STAGE_EVENTS: Partial<Record<WaveView["stage"], string>> = {
  rejected: "was rejected",
  blocked: "is blocked",
  waiting_approve: "waits for waves.approve",
  merged: "was merged",
};

function waveNotice({ view, stuck, events }: NoticeWave, origin: string): Notice | null {
  let event: string;
  let n: number | string;
  let what: string;
  if (view.interrupted) {
    [event, n, what] = ["interrupted", events.length, "was interrupted"];
  } else if (view.stage === "building" && stuck) {
    [event, n, what] = ["unreachable", unreachableTasks(view.tasks).join(","), "has tasks that can never start"];
  } else if (view.stage === "queued" && (stuck || neverStarts(view))) {
    // Not the stage event's index: the core may judge it stuck before its `queued` event saying why lands.
    [event, n, what] = ["never", view.after.join(","), "can never start"];
  } else {
    const said = WAVE_STAGE_EVENTS[view.stage];
    if (said === undefined) return null;
    [event, n, what] = [view.stage, events.findLastIndex((entry) => entry.kind === "stage"), said];
  }
  return { key: `wave:${view.id}:${event}:${n}`, origin, text: `factory: wave ${view.tag} ${what}\n${waveBlock(view)}` };
}

/** One notice per `contract` event of the wave (`contracts.apply` changed a contract its done tasks worked by). */
function contractNotices({ view, events }: NoticeWave, origin: string): Notice[] {
  return events.flatMap((entry, index) => {
    if (entry.kind !== "contract") return [];
    const { name, paths, done } = entry as { kind: "contract"; name: string; paths: string[]; done: string[] };
    const text = `factory: contract ${name} changed (${paths.join(", ")}): wave ${view.tag} has done tasks ${done.join(", ")}, which may need a follow-up task`;
    return [{ key: `wave:${view.id}:contract:${index}`, origin, text }];
  });
}

/** The one key of a scout's report, whoever delivers it. */
export function scoutNoticeKey(id: string): string {
  return `scout:${id}:report`;
}

function scoutNotice(scout: ScoutView): Notice | null {
  if (scout.caller.kind !== "session" || scout.caller.id === null) return null;
  const ended = scout.state === "done" || scout.state === "failed" || scout.state === "cancelled";
  if (!ended && !scout.interrupted) return null;
  let what: string = scout.state === "done" ? "reported" : scout.state;
  if (scout.interrupted) what = "was interrupted";
  const path = scout.reportPath === null ? "" : `\nreport: ${scout.reportPath}`;
  return { key: scoutNoticeKey(scout.id), origin: scout.caller.id, text: `factory: scout ${scout.id.slice(0, 8)} ${what}\n${scoutBlock(scout)}${path}` };
}

/** The notices of the events in `tasks`, `waves`, `scouts` and gate `proofs` whose key is not in `delivered`, waves first, scouts and proofs last. */
export function pendingNotices(tasks: readonly TaskView[], waves: readonly NoticeWave[], delivered: ReadonlySet<string>, scouts: readonly ScoutView[] = [], proofs: readonly ProofView[] = []): Notice[] {
  const notices: Notice[] = [];
  const stages = new Map(waves.map((wave) => [wave.view.id, wave.view.stage]));
  for (const wave of waves) {
    const notice = wave.view.origin === null ? null : waveNotice(wave, wave.view.origin);
    if (notice !== null) notices.push(notice);
    if (wave.view.origin !== null) notices.push(...contractNotices(wave, wave.view.origin));
  }
  for (const task of tasks) {
    if (task.origin === null) continue;
    // A wave's task speaks only while its wave builds; an unknown (removed) wave says nothing either.
    if (task.wave !== null && stages.get(task.wave) !== "building") continue;
    const notice = taskNotice(task, task.origin);
    if (notice !== null) notices.push(notice);
  }
  for (const scout of scouts) {
    const notice = scoutNotice(scout);
    if (notice !== null) notices.push(notice);
  }
  for (const proof of proofs) {
    if (proof.origin === null || (proof.state === "running" && !proof.interrupted)) continue;
    const event = proof.interrupted ? "interrupted" : proof.state;
    const what = event === "passed" ? "pass" : event === "flaky" ? "pass, flaky" : event === "failing" ? "fail" : "were interrupted";
    notices.push({ key: `proof:${proof.id}:${event}`, origin: proof.origin, text: `factory: the gates of ${proof.branch} ${what}\n${proofBlock(proof)}` });
  }
  return notices.filter((notice) => !delivered.has(notice.key));
}
