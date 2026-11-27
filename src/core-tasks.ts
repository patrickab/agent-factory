/**
 * The core's task actions (`tasks.*` but `tasks.wait`) and the task as clients see it (`TaskView`), read from the
 * task's session file.
 * - One check per task action (`refusal`): the handlers throw it, `TaskView.actions` lists the actions without one
 * - `cancel` stops a live runner first: two Pi processes never share a session
 * - A task of a wave is continued only while its wave builds (invariant 2); a task outside a wave never targets an
 *   open wave's branch (invariant 13)
 */
import { existsSync } from "node:fs";
import { readFile, stat, truncate } from "node:fs/promises";
import { basename, join } from "node:path";
import { byId, nonEmpty, primaryOf, tagParam, type Handler } from "./core-shared.ts";
import { diffFileCounts, git, snapshotTree, treeDiff, type FileCounts } from "./git.ts";
import {
  defaultBranch,
  deleteTask,
  launchTask,
  liveRunners,
  messageTask,
  sendCommand,
  stopRunners,
  taskInboxPath,
  unmergedWork,
  type RunnerEnv,
  type UnmergedWork,
} from "./launch.ts";
import { inboxReadPath, readFactoryStates, sessionEntries, sessionFilePath, taskMainBranch } from "./runner.ts";
import { runCommand } from "./run.ts";
import { requireModels } from "./models.ts";
import { checkSettings, factoryHome, loadSettings, resolveSettings } from "./settings.ts";
import { COMMIT_ASK_TYPE, FACTORY_TURN_STATES, FINAL_STATES, isFactoryPrompt, messageText, minorFindings, rebuild, RESTING_STATES, type EntryData, type EntryType, type Finding, type GateData, type MergeData, type MinorFinding, type ReviewData, type Settings, type State, type StateData } from "./state.ts";
import { listTasks, lockTask, tagInGroup, taskLogPath, unlockTask, type TaskRecord } from "./tasks.ts";
import { addUsage, cents, FactoryError, isRecord, jsonLines, piUsage, short, writeAtomic, type Usage } from "./util.ts";
import { foldWave, listWaves, readWave, WAVE_FINAL_STAGES, type WaveStage } from "./waves.ts";
import { pokeWave } from "./wave-poke.ts";
import { cancelScouts, scoutUsage } from "./scouts.ts";
import { slotWaiting } from "./test-slots.ts";

/** A task as every client sees it. `running`: a live runner holds the task. */
export interface TaskView {
  id: string;
  repo: string;
  worktree: string;
  branch: string;
  title: string;
  createdAt: string;
  tag: string;
  plan: string | null;
  /** The wave the task belongs to (`waves.start`, `waves.add`), null outside one. */
  wave: string | null;
  /** The Pi session that started the task (a wave's task: the wave's); null when none did (CLI, MCP). */
  origin: string | null;
  sessionId: string;
  sessionPath: string | null;
  state: State | null;
  round: number | null;
  reason: string | null;
  /** The timestamp of the last `factory-state` entry. */
  at: string | null;
  /** The coder's open question (`factory_ask_supervisor`) while the state is `waiting_answer`, else null. */
  question: string | null;
  running: boolean;
  /** The state is `running` or `merging` but no runner lives (it crashed, or the host rebooted). */
  interrupted: boolean;
  /** Its runner waits for a test slot (`test-slots.ts`) to run a gate; absent otherwise. */
  waitingForSlot?: true;
  /** The settings of the session's `factory-task` entry, null before it. */
  settings: Settings | null;
  /** Coder messages, reviews and the task's scouts together; `input` is uncached input tokens. Null before any. */
  usage: Usage | null;
  /** The coder's last message (its text), null before one. The answer to the commit message ask does not count. */
  lastMessage: string | null;
  /**
   * Why the task is blocked, from the round it stopped in: the failed gate (`<argv> (exit N)` and its output tail) or
   * the failed merge's error; null unless the state is `blocked` and one of them says why.
   */
  failure: string | null;
  /** The task's last review (`factory-review`), null before one. */
  review: { round: number; status: string; approved: boolean; findings: Finding[] } | null;
  /** The minor findings of every review (`factory-review`), oldest first: stored, they never start a round. */
  minors: MinorFinding[];
  /** The commit the last successful merge landed, null before one. */
  merged: string | null;
  /** The `flaky` names of the task's gate records (steps that failed and then passed on their rerun), in order. */
  flaky: string[];
  /** The task actions the core would accept now (`remove` maybe only with `force`). */
  actions: TaskActionName[];
}

const TASK_ACTIONS = ["tasks.approve", "tasks.retry", "tasks.cancel", "tasks.remove", "tasks.message"] as const;
export type TaskActionName = (typeof TASK_ACTIONS)[number];

export type TimelineKind = "task" | "round" | "gate" | "review" | "merge" | "state" | "coder" | "user" | "question";

/** `coder`/`user` data is `{text}`; the others carry the `factory-*` entry's data unchanged. */
export interface TimelineEntry {
  at: string;
  kind: TimelineKind;
  data: object;
}

/** The task whose id is `id` or starts with it. */
export async function findTask(id: unknown): Promise<TaskRecord> {
  try {
    return byId(await listTasks(), (task) => task.id, id, "task");
  } catch (error) {
    const wanted = nonEmpty(id)?.trim();
    if (!(error instanceof FactoryError) || error.code !== "not_found" || wanted === undefined) throw error;
    const pending = await pendingWaveTask(wanted);
    if (pending === undefined) throw error;
    throw new FactoryError("refused", `task ${short(pending.id)} (${pending.key} of wave ${short(pending.wave)}) has not started yet: tasks.update changes it, waves.get shows it`);
  }
}

/** The pending task of a wave whose declared id is `wanted` or starts with it (the first such), else undefined. */
export async function pendingWaveTask(wanted: string): Promise<{ id: string; key: string; wave: string } | undefined> {
  for (const file of await listWaves()) {
    for (const task of foldWave(file.declaration, file.events).tasks) {
      if (task.taskId === null && task.id?.startsWith(wanted)) return { id: task.id, key: task.key, wave: file.declaration.id };
    }
  }
  return undefined;
}

/**
 * The stage of the record's wave, null outside one, `removed` when its wave is gone. `known`: the stage the caller
 * read already (`waveTaskViews`).
 */
async function taskWaveStage(record: TaskRecord, known?: WaveStage): Promise<WaveStage | "removed" | null> {
  if (record.wave === null) return null;
  if (known !== undefined) return known;
  try {
    const file = await readWave(record.wave);
    return foldWave(file.declaration, file.events).stage;
  } catch (error) {
    if (error instanceof FactoryError && error.code === "not_found") return "removed";
    throw error;
  }
}

/** A failed gate as `<argv> (exit N)` and its output tail; null for a passed one. */
function failedGateText(gate: GateData): string | null {
  if (gate.exitCode === 0 && !gate.killed) return null;
  const tail = gate.outputTail.trimEnd();
  return `${gate.argv.join(" ")} (${gate.killed ? "killed" : `exit ${String(gate.exitCode)}`})${tail === "" ? "" : `\n${tail}`}`;
}

/** The unrounded usage of a task view, for sums (the view itself shows cost in cents). */
const unroundedUsage = new WeakMap<object, Usage>();
export function rawUsage(view: TaskView): Usage | null {
  return unroundedUsage.get(view) ?? view.usage;
}

/** What a task's session file says (`sessionSummary`): a function of its content only. `usage` unrounded. */
interface SessionSummary extends Pick<TaskView, "settings" | "question" | "lastMessage" | "failure" | "review" | "merged" | "minors" | "flaky"> {
  last: { state: State; round: number; reason: string; at: string } | null;
  usage: TaskView["usage"];
}

/**
 * The plugin's reducer (`rebuild`) gives the settings, the question and the merged commit; one loop adds the rest: the
 * last state with its time, usage, the coder's last message (not its answer to the commit message ask), the failure of
 * the round it stopped in when `blocked`, the last review, minors and flaky names.
 */
function summarize(entries: Record<string, unknown>[]): SessionSummary {
  const snapshot = rebuild(entries);
  let last: SessionSummary["last"] = null;
  let usage: Usage | null = null;
  let lastMessage: string | null = null;
  let answeringCommitAsk = false;
  let failedGate: string | null = null;
  let mergeError: string | null = null;
  let review: TaskView["review"] = null;
  const minors: MinorFinding[] = [];
  const flaky = new Set<string>();
  for (const entry of entries) {
    if (entry.type === "custom_message" && entry.customType === COMMIT_ASK_TYPE) answeringCommitAsk = true;
    if (entry.type === "custom") {
      const data = entry.data as EntryData[EntryType];
      switch (entry.customType as EntryType) {
        case "factory-state": {
          const { state, round, reason } = data as StateData;
          last = { state, round, reason, at: typeof entry.timestamp === "string" ? entry.timestamp : "" };
          break;
        }
        case "factory-round":
          // A new round: what failed before it was fed back to the coder.
          [failedGate, mergeError, answeringCommitAsk] = [null, null, false];
          break;
        case "factory-gate": {
          const gate = data as GateData;
          failedGate = failedGateText(gate) ?? failedGate;
          for (const name of gate.flaky ?? []) flaky.add(name);
          break;
        }
        case "factory-merge":
          mergeError = (data as MergeData).ok ? null : (data as MergeData).error;
          break;
        case "factory-review": {
          const { round, status, approved, findings, usage: used } = data as ReviewData;
          review = { round, status, approved, findings };
          minors.push(...minorFindings(round, findings));
          usage = addUsage(usage, used);
          break;
        }
      }
    }
    if (entry.type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    const text = messageText(message).trim();
    if (message.role === "user" && !isFactoryPrompt(text)) answeringCommitAsk = false;
    if (message.role !== "assistant") continue;
    if (text !== "" && !answeringCommitAsk) lastMessage = text;
    usage = addUsage(usage, piUsage(message.usage));
  }
  const blocked = (last as SessionSummary["last"])?.state === "blocked";
  return {
    last,
    usage,
    settings: snapshot?.task.settings ?? null,
    question: snapshot?.question ?? null,
    merged: snapshot?.mergedCommit ?? null,
    lastMessage,
    failure: blocked ? (failedGate ?? mergeError) : null,
    review,
    minors,
    flaky: [...flaky],
  };
}

/** Where the summary of the session file `sessionPath` is kept once its task finished: `cache/sessions/<file name>.json`. */
function summaryCachePath(sessionPath: string): string {
  return join(factoryHome(), "cache", "sessions", `${basename(sessionPath)}.json`);
}

/**
 * Summaries read in this process, by session path, with the file's size and mtime: a poll parses only what changed. At
 * most `MAX_SUMMARIES`, the least recently stored go first: a long-lived host lists tasks for months.
 */
const summaries = new Map<string, { size: number; mtimeMs: number; summary: SessionSummary }>();
const MAX_SUMMARIES = 500;

/**
 * The summary of the session file `sessionPath` (none: empty), parsed again only when its size or mtime changed. A
 * finished task's (`done`, `cancelled`) is kept on disk too: a listing does not read and parse the sessions of every
 * task ever run again.
 */
async function sessionSummary(sessionPath: string | null): Promise<SessionSummary> {
  if (sessionPath === null) return summarize([]);
  const file = await stat(sessionPath).catch(() => null);
  const cachePath = summaryCachePath(sessionPath);
  if (file !== null) {
    const known = summaries.get(sessionPath);
    if (known?.size === file.size && known.mtimeMs === file.mtimeMs) return known.summary;
    const cached: unknown = await readFile(cachePath, "utf8").then(JSON.parse, () => null).catch(() => null);
    if (isRecord(cached) && cached.size === file.size && cached.mtimeMs === file.mtimeMs && isRecord(cached.summary)) return cached.summary as unknown as SessionSummary;
  }
  const summary = summarize(await sessionEntries(sessionPath));
  if (file === null) return summary;
  summaries.delete(sessionPath);
  if (summaries.size >= MAX_SUMMARIES) summaries.delete(summaries.keys().next().value as string);
  summaries.set(sessionPath, { size: file.size, mtimeMs: file.mtimeMs, summary });
  if (summary.last !== null && FINAL_STATES.includes(summary.last.state)) {
    // Only a cache: on a failure the next listing reads the session again.
    await writeAtomic(cachePath, JSON.stringify({ size: file.size, mtimeMs: file.mtimeMs, summary })).catch(() => undefined);
  }
  return summary;
}

/** The task as clients see it. `knownWaveStage`: its wave's stage, read already. */
export async function taskView(record: TaskRecord, knownWaveStage?: WaveStage): Promise<TaskView> {
  // Liveness before the state: a runner writes its last state before it exits, so a state read after a dead runner is
  // its last one; read the other way round, a runner that wrote `done` and exited in between looks interrupted.
  const runners = await liveRunners(record);
  const running = runners.length > 0;
  const waitingForSlot = await slotWaiting(runners);
  const sessionPath = (await sessionFilePath(record.sessionDir, record.sessionId)) ?? null;
  const { last, settings, question, usage: sessionUsage, ...outcome } = await sessionSummary(sessionPath);
  const usage = addUsage(sessionUsage, await scoutUsage({ kind: "task", id: record.id }));
  const { sessionDir: _dir, contracts: _contracts, contractNotes: _notes, ...fields } = record;
  const view: Omit<TaskView, "actions"> = {
    ...fields,
    sessionPath,
    state: last?.state ?? null,
    round: last?.round ?? null,
    reason: last?.reason ?? null,
    at: last?.at ?? null,
    question: last?.state === "waiting_answer" ? question : null,
    running,
    interrupted: last !== null && !RESTING_STATES.includes(last.state) && !running,
    settings,
    usage: usage === null ? null : { ...usage, cost: cents(usage.cost) },
    ...outcome,
    ...(waitingForSlot ? { waitingForSlot } : {}),
  };
  const waveStage = await taskWaveStage(record, knownWaveStage);
  const result = { ...view, actions: TASK_ACTIONS.filter((action) => refusal(view, action, waveStage) === null) };
  if (usage !== null) unroundedUsage.set(result, usage);
  return result;
}

/**
 * Why the task refuses `action`, null when it takes it: the one check of each task action, which its handler throws and
 * `TaskView.actions` lists. `waveStage`: its wave's (`taskWaveStage`). A task of a wave that left `building` takes no
 * more work but the answer to its question (invariant 2): from its review on, the gates and the reviewer have seen the
 * wave's branch, and a commit of the task would reach it unseen (or, once merged, be lost). A done task its wave still
 * counts on (neither merged, cancelled nor removed) is not removed: removed, it would count as cancelled and strand the
 * tasks waiting for it; `waves.remove` removes it with its wave (`waveStage` null).
 */
/** A done task takes no message: its work is merged, more work is a new task. */
export const DONE_REFUSAL = "is done: give the work to its wave with waves.add, or start a new task";

export function refusal(view: Omit<TaskView, "actions">, action: TaskActionName, waveStage: WaveStage | "removed" | null): FactoryError | null {
  const task = `task ${short(view.id)}`;
  const refused = (why: string) => new FactoryError("refused", `${task} ${why}`);
  const leftBuilding = (what: string) =>
    waveStage === null || waveStage === "building"
      ? null
      : refused(`belongs to wave ${short(view.wave)}, which is ${waveStage}: its tasks take no more work once it left building, ${what} is refused; give the work to the wave with waves.add`);
  // A resting task whose runner has not exited yet.
  const ending = view.running ? new FactoryError("busy", `the runner of ${task} is still ending, try again in a few seconds`) : null;
  switch (action) {
    case "tasks.approve":
      if (view.state !== "waiting_approve" || view.interrupted) return refused(`is ${stateText(view)}, approve needs waiting_approve`);
      return ending ?? leftBuilding("approve");
    case "tasks.retry":
      if (!view.interrupted && view.state !== "blocked" && view.state !== "cancelled") return refused(`is ${stateText(view)}, retry needs blocked, cancelled or interrupted`);
      return ending ?? leftBuilding("retry");
    case "tasks.cancel":
      return view.state !== null && FINAL_STATES.includes(view.state) ? refused(`is ${view.state} already`) : null;
    case "tasks.remove":
      if (view.running) return refused("is running, cancel it first");
      if (view.state === "waiting_answer") return refused("waits for the answer to its question, answer it with tasks.message or cancel it first");
      if (view.state !== "done" || waveStage === null || waveStage === "removed" || WAVE_FINAL_STAGES.includes(waveStage)) return null;
      return refused(
        `is done in wave ${short(view.wave)}, which is ${waveStage}: the wave counts on it (removed, the tasks waiting for it could never start); remove it once the wave is merged or cancelled, or with its wave (waves.remove)`,
      );
    case "tasks.message":
      if (view.state === null) return refused("has not started yet, send the message once it runs");
      if (view.state === "merging") return refused("is merging, send the message when the merge has ended");
      if (view.state === "done") return refused(DONE_REFUSAL);
      return view.state === "waiting_answer" ? null : leftBuilding("a message");
  }
}

/** Throws the task's refusal of `action`. */
async function requireAction(record: TaskRecord, view: TaskView, action: TaskActionName): Promise<void> {
  const refused = refusal(view, action, await taskWaveStage(record));
  if (refused !== null) throw refused;
}

/**
 * No runner lives and nothing moves the task on by itself: its state is a resting one, or it is interrupted. A task
 * waiting for the factory (`FACTORY_TURN_STATES`: its wave's reviewer) does not rest.
 */
export function rests(view: TaskView): boolean {
  return !view.running && (view.interrupted || (view.state !== null && RESTING_STATES.includes(view.state) && !FACTORY_TURN_STATES.includes(view.state)));
}

/** It rests and waits for someone: every resting state but `done`. */
export function needsAttention(view: TaskView): boolean {
  return rests(view) && view.state !== "done";
}

function stateText(view: Omit<TaskView, "actions">): string {
  if (view.state === null) return "starting";
  if (view.interrupted) return `interrupted (${view.state} when its runner ended, round ${view.round}, ${view.reason})`;
  return `${view.state} (round ${view.round}, ${view.reason})`;
}

/**
 * Runs `act` holding the task lock; a lock `act` handed to a runner stays with it. `check` runs first without the lock
 * (a refusal names the state, not the lock) and again under it.
 */
export async function withTaskLock<T>(record: TaskRecord, check: (view: TaskView) => Promise<void>, act: (view: TaskView) => Promise<T>): Promise<T> {
  await check(await taskView(record));
  await lockTask(record.id);
  try {
    const view = await taskView(record);
    await check(view);
    return await act(view);
  } finally {
    await unlockTask(record.id);
  }
}

async function requireNoRunner(record: TaskRecord): Promise<void> {
  if ((await liveRunners(record)).length > 0) throw new FactoryError("busy", `the runner of task ${short(record.id)} is still ending, try again in a few seconds`);
}

/** A command for a task at rest goes through a new runner; the last one must have ended first. */
async function sendToRestingTask(record: TaskRecord, message: string, env: RunnerEnv | undefined): Promise<void> {
  await requireNoRunner(record);
  await sendCommand(record, message, env);
}

/**
 * Takes back the inbox line of `text` when it is the inbox's last line and no runner has sent it yet (it lies past
 * `<inbox>.read`); `false` otherwise.
 */
async function withdrawUnsentLine(record: TaskRecord, text: string): Promise<boolean> {
  const inbox = taskInboxPath(record.id);
  const bytes = await readFile(inbox).catch(() => undefined);
  if (bytes === undefined) return false;
  const line = Buffer.from(`${JSON.stringify({ text })}\n`);
  const start = bytes.length - line.length;
  const sent = Number((await readFile(inboxReadPath(inbox), "utf8").catch(() => "0")).trim()) || 0;
  if (start < sent || !bytes.subarray(start).equals(line)) return false;
  await truncate(inbox, start);
  return true;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** `1 unmerged commit (not on main)`, the count always named. */
function unmergedText(work: UnmergedWork, target: string | undefined): string {
  return `${plural(work.commits, "unmerged commit")} (not on ${target ?? "any other branch"})`;
}

function timelineKind(entry: Record<string, unknown>): { kind: TimelineKind; data: object } | undefined {
  if (entry.type === "custom" && typeof entry.customType === "string" && isRecord(entry.data)) {
    const kind = CUSTOM_KINDS[entry.customType];
    return kind === undefined ? undefined : { kind, data: entry.data };
  }
  if (entry.type !== "message" || !isRecord(entry.message)) return undefined;
  const text = messageText(entry.message);
  if (text.trim() === "") return undefined;
  if (entry.message.role === "assistant") return { kind: "coder", data: { text } };
  if (entry.message.role === "user" && !isFactoryPrompt(text)) return { kind: "user", data: { text } };
  return undefined;
}

const CUSTOM_KINDS: Record<string, TimelineKind | undefined> = {
  "factory-task": "task",
  "factory-round": "round",
  "factory-gate": "gate",
  "factory-review": "review",
  "factory-merge": "merge",
  "factory-state": "state",
  "factory-question": "question",
};

/** The entries of the session file's complete lines from byte `since` on; `next` is the end of the last one. */
async function readTimeline(record: TaskRecord, since: number): Promise<{ entries: TimelineEntry[]; next: number }> {
  const path = await sessionFilePath(record.sessionDir, record.sessionId);
  if (path === undefined) {
    if (since > 0) throw new FactoryError("invalid", `task ${short(record.id)} has no session file yet, since must be 0`);
    return { entries: [], next: 0 };
  }
  const size = (await stat(path)).size;
  if (since > size) throw new FactoryError("invalid", `since ${since} is past the end of the session file (${size} bytes)`);
  // Only the bytes from `since` on: a poll costs what was appended, not the whole session.
  const bytes = Buffer.from(await Bun.file(path).slice(since, size).arrayBuffer());
  const end = bytes.lastIndexOf(0x0a) + 1;
  if (end === 0) return { entries: [], next: since };
  const entries: TimelineEntry[] = [];
  for (const entry of jsonLines(bytes.subarray(0, end).toString("utf8"))) {
    const kind = timelineKind(entry);
    if (kind) entries.push({ at: typeof entry.timestamp === "string" ? entry.timestamp : "", ...kind });
  }
  return { entries, next: since + end };
}

/** The tasks of `repo` (every repository's without), only those in the tag group `tag` when given. */
export async function tasksIn(repo: string | undefined, tag: string | undefined): Promise<TaskRecord[]> {
  const records = await listTasks(repo);
  return tag === undefined ? records : records.filter((record) => tagInGroup(record.tag, tag));
}

/** How long a cancel or retry of an interrupted task waits for its runner to write a state or end. */
const RUNNER_START_WAIT_MS = 15_000;

/**
 * For a command to an interrupted task: waits until the session has more than `statesBefore` `factory-state` entries
 * (the runner runs) or the runner ended without one (`failed`, naming the last line of its log). A runner still
 * alive after `RUNNER_START_WAIT_MS` counts as started.
 */
async function requireRunnerStarted(record: TaskRecord, statesBefore: number): Promise<void> {
  const deadline = Date.now() + RUNNER_START_WAIT_MS;
  const wroteState = async () => (await readFactoryStates(record.sessionDir, record.sessionId)).count > statesBefore;
  while (Date.now() < deadline) {
    if (await wroteState()) return;
    if ((await liveRunners(record)).length === 0) {
      if (await wroteState()) return;
      const log = await readFile(taskLogPath(record.id), "utf8").catch(() => "");
      const last = log.trim().split("\n").at(-1)?.trim().slice(0, 300) ?? "";
      throw new FactoryError("failed", `the runner of task ${short(record.id)} ended before it ran${last === "" ? "" : ` (${last})`}`);
    }
    await Bun.sleep(100);
  }
}

/**
 * Cancels a task (`tasks.cancel` after its state check): the runner holds the task lock until it exits, so stop it,
 * then take the lock and send `/factory cancel`.
 */
export async function cancelTask(record: TaskRecord, env: RunnerEnv | undefined): Promise<void> {
  await cancelScouts({ kind: "task", id: record.id });
  await stopRunners(record);
  const sent = await withTaskLock(
    record,
    async () => undefined,
    async (view) => {
      // A runner stopped before the task was recorded leaves nothing to cancel in the session.
      if (view.state === null) return undefined;
      const statesBefore = (await readFactoryStates(record.sessionDir, record.sessionId)).count;
      await sendCommand(record, "/factory cancel", env);
      return { interrupted: view.interrupted, statesBefore };
    },
  );
  if (sent?.interrupted) await requireRunnerStarted(record, sent.statesBefore);
}

/**
 * What removing the task would drop; refused (detail `force`) without `force` when that is anything. `landed`: its
 * commits are merged whatever its branch holds (a done task of a merged wave: squashed or rebased, they are copies there).
 */
export async function droppedWork(record: TaskRecord, force: boolean, landed = false): Promise<string | null> {
  const target = await taskMainBranch(record.sessionDir, record.sessionId);
  const work = await unmergedWork(record, target);
  if (landed) work.commits = 0;
  const dropsWork = work.commits > 0 || work.dirty;
  if (dropsWork && !force) {
    const changes = work.dirty ? " and uncommitted changes in its worktree" : "";
    throw new FactoryError("refused", `task ${short(record.id)} has ${unmergedText(work, target)}${changes}, give force: true to remove it anyway`, { force: true });
  }
  return dropsWork ? `${unmergedText(work, target)}${work.dirty ? " and uncommitted changes" : ""}` : null;
}

/**
 * Refuses a task outside a wave whose target is the branch of a wave not merged or cancelled (invariant 13): the wave
 * would neither wait for it nor watch it, and its gates and reviewer would see a change none of its tasks made.
 */
async function requireNoOpenWaveBranch(repo: string, target: string): Promise<void> {
  for (const file of await listWaves()) {
    if (file.declaration.repo !== repo) continue;
    const { stage, id, branch } = foldWave(file.declaration, file.events);
    if (branch !== target) continue;
    if (WAVE_FINAL_STAGES.includes(stage)) continue;
    throw new FactoryError(
      "refused",
      `${target} is the branch of wave ${short(id)}, which is ${stage}: only the wave's own tasks reach it; give the work to the wave with waves.add`,
    );
  }
}

/**
 * After a task of a wave runs again (`tasks.retry`, `tasks.message`, `tasks.approve`): a runner that rested sees it run,
 * so a stuck wave is not taken for interrupted meanwhile. Best effort: the task's action has happened already, and a
 * failed poke leaves only what `waves.retry` sets right.
 */
async function pokeWaveOf(record: TaskRecord, env?: RunnerEnv): Promise<void> {
  if (record.wave) await pokeWave(record.wave, env).catch(() => undefined);
}

/**
 * `tasks.retry` but the poke of its wave: the checks (blocked, cancelled or interrupted, continuable),
 * `/factory retry` to its session, and for an interrupted task the wait until its runner started. Throws the refusal
 * as a `FactoryError`. `waves.retry` retries its interrupted tasks through it and pokes the wave once.
 */
export async function retryRestingTask(record: TaskRecord, env?: RunnerEnv): Promise<void> {
  // An interrupted task is set right by the session's start (`resumeTask`) before the retry runs.
  const sent = await withTaskLock(record, (view) => requireAction(record, view, "tasks.retry"), async (view) => {
    const statesBefore = (await readFactoryStates(record.sessionDir, record.sessionId)).count;
    await sendToRestingTask(record, "/factory retry", env);
    return { interrupted: view.interrupted, statesBefore };
  });
  if (sent.interrupted) await requireRunnerStarted(record, sent.statesBefore);
}

export const TASK_HANDLERS = {
  "tasks.list": async (params, { cwd }) => {
    const tag = tagParam("tasks.list", params.tag);
    const repo = params.repo === undefined ? undefined : await primaryOf(params.repo as string, cwd);
    return { tasks: await Promise.all((await tasksIn(repo, tag)).map((record) => taskView(record))) };
  },

  "tasks.get": async (params) => taskView(await findTask(params.id)),
  "tasks.timeline": async (params) => readTimeline(await findTask(params.id), (params.since as number | undefined) ?? 0),

  "tasks.diff": async (params) => {
    const record = await findTask(params.id);
    const target = await taskMainBranch(record.sessionDir, record.sessionId);
    if (target === undefined) throw new FactoryError("refused", `task ${short(record.id)} has not started yet, so it has no diff`);
    if (!existsSync(record.worktree)) throw new FactoryError("refused", `the worktree of task ${short(record.id)} is gone (${record.worktree})`);
    const base = await git(runCommand, record.worktree, ["merge-base", "HEAD", `refs/heads/${target}`]);
    const tree = await snapshotTree(runCommand, record.worktree);
    const diff = await treeDiff(runCommand, record.worktree, base, tree);
    const files: FileCounts[] = await diffFileCounts(runCommand, record.worktree, base, tree);
    return { diff: diff.patch, files };
  },

  "tasks.start": async (params, { cwd, signal, env, origin }) => {
    const title = nonEmpty(params.title);
    const request = nonEmpty(params.request);
    if (title === undefined) throw new FactoryError("invalid", "tasks.start needs a title that is not empty");
    if (request === undefined) throw new FactoryError("invalid", "tasks.start needs a request that is not empty");
    const tag = tagParam("tasks.start", params.tag);
    const overrides = checkSettings(params.overrides, "task", "overrides.");
    const repo = await primaryOf(params.repo as string, cwd);
    const stored = await loadSettings(repo);
    const { big, reviewer } = resolveSettings([stored, overrides], "").models;
    await requireModels({ big, reviewer });
    // The target as `launchTask` resolves it; a missing default branch is its refusal.
    const target = overrides.branch ?? stored.branch ?? (await defaultBranch(repo).catch(() => undefined));
    if (target !== undefined) await requireNoOpenWaveBranch(repo, target);
    // Again once the worktree exists: a wave declared on the branch meanwhile (a racing `waves.start`) wins.
    const beforeRecord = (branch: string) => requireNoOpenWaveBranch(repo, branch);
    return taskView(await launchTask({ repo, title, request, overrides, tag, origin: origin ?? null, signal, env, beforeRecord }));
  },

  "tasks.approve": async (params, { env }) => {
    const record = await findTask(params.id);
    await withTaskLock(record, (view) => requireAction(record, view, "tasks.approve"), () => sendToRestingTask(record, "/factory approve", env));
    await pokeWaveOf(record, env);
    return taskView(record);
  },

  "tasks.retry": async (params, { env }) => {
    const record = await findTask(params.id);
    await retryRestingTask(record, env);
    await pokeWaveOf(record, env);
    return taskView(record);
  },

  "tasks.cancel": async (params, { env }) => {
    const record = await findTask(params.id);
    await requireAction(record, await taskView(record), "tasks.cancel");
    await cancelTask(record, env);
    return taskView(record);
  },

  "tasks.remove": async (params) => {
    const record = await findTask(params.id);
    return withTaskLock(
      record,
      (view) => requireAction(record, view, "tasks.remove"),
      async () => {
        const dropped = await droppedWork(record, params.force === true);
        await deleteTask(record);
        return { removed: record.id, dropped };
      },
    );
  },

  "tasks.message": async (params, { env }) => {
    const record = await findTask(params.id);
    const text = nonEmpty(params.text);
    if (text === undefined) throw new FactoryError("invalid", "tasks.message needs a text that is not empty");
    await requireAction(record, await taskView(record), "tasks.message");
    // `messageTask` takes the task lock itself (resting) or appends to the live runner's inbox (running).
    await messageTask(record, text, env);
    // A runner that ended as the line was appended never sends it: take it back and start a runner with it.
    if ((await liveRunners(record)).length === 0 && (await withdrawUnsentLine(record, text))) await messageTask(record, text, env);
    await pokeWaveOf(record, env);
    return taskView(record);
  },
} satisfies Record<string, Handler>;
