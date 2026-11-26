/**
 * The core's task actions (`tasks.*` but `tasks.wait`, `core.ts` maps them) and the task as clients see it
 * (`TaskView`).
 *
 * - Reads a task's session file for its state, settings, usage (assistant messages plus recorded reviews), outcome
 *   and timeline (by byte offset, so a client polls with `next`)
 * - `TaskView.actions` holds the predicates of the actions' own checks (`taskActions`)
 * - A task that checks its state and then acts on it holds the task lock (`tasks.ts`) from the check on; a runner it
 *   spawns takes the lock over until it exits. `cancel` stops a live runner first: two Pi processes never share a session
 * - A task of a wave is continued only while its wave builds (invariant 2), a done one its wave counts on is not
 *   removed, and a task outside a wave never targets an open wave's branch (invariant 13); after an action that runs a
 *   wave's task again its wave's runner is poked
 * - An old merge request record (invariant 7) can only be removed
 */
import { existsSync, realpathSync } from "node:fs";
import { readFile, stat, truncate } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { FactoryError, nonEmpty, oneLine, primaryOf, SHORT_ID_CHARS, shortId, tagParam, type Handler, type Params } from "./core-shared.ts";
import { requireFactoryModels } from "./core-settings.ts";
import { diffFileCounts, git, snapshotTree, treeDiff, type FileCounts } from "./git.ts";
import {
  defaultBranch,
  deleteTask,
  launchTask,
  LaunchRefusedError,
  liveRunners,
  messageTask,
  MessageRefusedError,
  sendCommand,
  stopRunners,
  taskInboxPath,
  unmergedWork,
  type RunnerEnv,
  type UnmergedWork,
} from "./launch.ts";
import { inboxReadPath, readFactoryStates, sessionFilePath, taskMainBranch } from "./runner.ts";
import { runCommand } from "./run.ts";
import { loadSettings, resolveSettings, type StoredSettings } from "./settings.ts";
import { COMMIT_ASK_TYPE, isFactoryPrompt, messageText, normalizeModels, parseSettingsFields, RESTING_STATES, type Finding, type Settings, type State } from "./state.ts";
import { listTasks, lockTask, parseTaskRecord, tagInGroup, TaskBusyError, taskLogPath, unlockTask, writeTask, type TaskRecord } from "./tasks.ts";
import { cents, errorText, isRecord } from "./util.ts";
import { foldWave, listWaves, readWave, type WaveStage } from "./waves.ts";
import { pokeWave } from "./wave-poke.ts";
import { addScoutUsage, cancelScouts, scoutUsage } from "./scouts.ts";

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
  /** The Pi session that started the task (a wave's task: the wave's); null when none did (CLI, MCP, old records). */
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
  /** The settings of the session's `factory-task` entry, null before it. */
  settings: Settings | null;
  /** Coder messages, reviews and the task's scouts together; `input` is uncached input tokens. Null before any. */
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number } | null;
  /** The part of `usage.cost` its scouts spent (cancelled and killed ones too). Always set by the core. */
  scoutingCost?: number;
  /** The coder's last message (its text), null before one. The answer to the commit message ask does not count. Added in factory/w2. */
  lastMessage: string | null;
  /**
   * Why the task is blocked, from the round it stopped in: the failed gate (`<argv> (exit N)` and its output tail) or
   * the failed merge's error; null unless the state is `blocked` and one of them says why. Added in factory/w2.
   */
  failure: string | null;
  /** The task's last review (`factory-review`), null before one. Added in factory/w2. */
  review: { round: number; status: string; approved: boolean; findings: Finding[] } | null;
  /** The commit the last successful merge landed, null before one. Added in factory/w2. */
  merged: string | null;
  /** The `flaky` names of the task's gate records (steps that failed and then passed on their rerun), in order. */
  flaky: string[];
  /** The task actions the core would accept now (`remove` maybe only with `force`). */
  actions: TaskActionName[];
}

export type TaskActionName = "tasks.approve" | "tasks.retry" | "tasks.cancel" | "tasks.remove" | "tasks.message";

export type TimelineKind = "task" | "round" | "gate" | "review" | "merge" | "state" | "coder" | "user" | "spawn" | "question";

/** `coder`/`user` data is `{text}`; the others carry the `factory-*` entry's data unchanged. */
export interface TimelineEntry {
  at: string;
  kind: TimelineKind;
  data: object;
}

/** The task whose id is `id` or starts with it. */
export async function findTask(id: unknown): Promise<TaskRecord> {
  const wanted = nonEmpty(id)?.trim();
  if (wanted === undefined) throw new FactoryError("invalid", "the id of a task must not be empty");
  const tasks = await listTasks();
  const exact = tasks.find((task) => task.id === wanted);
  if (exact) return exact;
  const matches = tasks.filter((task) => task.id.startsWith(wanted));
  if (matches.length === 0) {
    const pending = await pendingWaveTask(wanted);
    if (pending !== undefined) {
      throw new FactoryError("refused", `task ${pending.id.slice(0, SHORT_ID_CHARS)} (${pending.key} of wave ${pending.wave.slice(0, SHORT_ID_CHARS)}) has not started yet: tasks.update changes it, waves.get shows it`);
    }
    throw new FactoryError("not_found", `no task has an id starting with "${wanted}"`);
  }
  if (matches.length > 1) {
    throw new FactoryError("invalid", `"${wanted}" matches ${matches.length} tasks (${matches.map((task) => task.id).join(", ")}), give more of the id`);
  }
  return matches[0];
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

/** The session file's entries, a torn or invalid line skipped. */
function parseEntries(text: string): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (isRecord(entry)) entries.push(entry);
    } catch {
      // a line being written
    }
  }
  return entries;
}

function numberOr0(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function customData(entry: Record<string, unknown>, customType: string): Record<string, unknown> | undefined {
  return entry.type === "custom" && entry.customType === customType && isRecord(entry.data) ? entry.data : undefined;
}

function assistantMessage(entry: Record<string, unknown>): Record<string, unknown> | undefined {
  return entry.type === "message" && isRecord(entry.message) && entry.message.role === "assistant" ? entry.message : undefined;
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
function failedGateText(gate: Record<string, unknown>): string | null {
  if (!Array.isArray(gate.argv) || (gate.exitCode === 0 && gate.killed !== true)) return null;
  const exit = gate.killed === true ? "killed" : `exit ${String(gate.exitCode)}`;
  const tail = typeof gate.outputTail === "string" ? gate.outputTail.trimEnd() : "";
  return `${gate.argv.join(" ")} (${exit})${tail === "" ? "" : `\n${tail}`}`;
}

function reviewOf(data: Record<string, unknown>): TaskView["review"] {
  if (typeof data.round !== "number") return null;
  return {
    round: data.round,
    status: typeof data.status === "string" ? data.status : "unknown",
    approved: data.approved === true,
    findings: Array.isArray(data.findings) ? (data.findings as Finding[]) : [],
  };
}

/**
 * What a task's session says about how its work went (the fields factory/w2 added to `TaskView`): the coder's last
 * message (not its answer to the commit message ask), the failure of the round it stopped in when `blocked`, its last
 * review, the commit its last merge landed.
 */
function taskOutcome(entries: Record<string, unknown>[], blocked: boolean): Pick<TaskView, "lastMessage" | "failure" | "review" | "merged"> {
  let lastMessage: string | null = null;
  let answeringCommitAsk = false;
  let failedGate: string | null = null;
  let mergeError: string | null = null;
  let review: TaskView["review"] = null;
  let merged: string | null = null;
  for (const entry of entries) {
    if (customData(entry, "factory-round")) {
      // A new round: what failed before it was fed back to the coder.
      [failedGate, mergeError, answeringCommitAsk] = [null, null, false];
    }
    if (entry.type === "custom_message" && entry.customType === COMMIT_ASK_TYPE) answeringCommitAsk = true;
    const gate = customData(entry, "factory-gate");
    if (gate) failedGate = failedGateText(gate) ?? failedGate;
    const merge = customData(entry, "factory-merge");
    if (merge?.ok === true && typeof merge.commit === "string") merged = merge.commit;
    if (merge) mergeError = merge.ok !== true && typeof merge.error === "string" ? merge.error : null;
    const reviewed = customData(entry, "factory-review");
    if (reviewed) review = reviewOf(reviewed) ?? review;
    if (entry.type !== "message" || !isRecord(entry.message)) continue;
    const text = messageText(entry.message).trim();
    if (entry.message.role === "user" && !isFactoryPrompt(text)) answeringCommitAsk = false;
    if (entry.message.role === "assistant" && text !== "" && !answeringCommitAsk) lastMessage = text;
  }
  return { lastMessage, failure: blocked ? (failedGate ?? mergeError) : null, review, merged };
}

/** The `flaky` names of every `factory-gate` entry, without repeats. */
function flakyNames(entries: Record<string, unknown>[]): string[] {
  const names = new Set<string>();
  for (const entry of entries) {
    const flaky = customData(entry, "factory-gate")?.flaky;
    if (Array.isArray(flaky)) for (const name of flaky) if (typeof name === "string") names.add(name);
  }
  return [...names];
}

/** The unrounded usage of a task view, for sums (the view itself shows cost in cents), and the unrounded scouting cost. */
const unroundedUsage = new WeakMap<object, NonNullable<TaskView["usage"]>>();
const unroundedScouting = new WeakMap<object, number>();
export function rawUsage(view: TaskView): TaskView["usage"] {
  return unroundedUsage.get(view) ?? view.usage;
}
export function rawScoutingCost(view: TaskView): number {
  return unroundedScouting.get(view) ?? view.scoutingCost ?? 0;
}

export { cents };
export async function taskView(record: TaskRecord, knownWaveStage?: WaveStage): Promise<TaskView> {
  const sessionPath = (await sessionFilePath(record.sessionDir, record.sessionId)) ?? null;
  const entries = sessionPath === null ? [] : parseEntries(await readFile(sessionPath, "utf8"));
  let last: { state: State; round: number; reason: string; at: string } | null = null;
  let settings: Settings | null = null;
  let question: string | null = null;
  let usage: TaskView["usage"] = null;
  const addUsage = (input: unknown, output: unknown, cost: unknown, cacheRead: unknown, cacheWrite: unknown) => {
    usage ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    usage.cacheRead += numberOr0(cacheRead);
    usage.cacheWrite += numberOr0(cacheWrite);
    usage.input += numberOr0(input);
    usage.output += numberOr0(output);
    usage.cost += numberOr0(cost);
  };
  for (const entry of entries) {
    const state = customData(entry, "factory-state");
    if (state && typeof state.state === "string" && typeof state.round === "number" && typeof state.reason === "string") {
      last = { state: state.state as State, round: state.round, reason: state.reason, at: typeof entry.timestamp === "string" ? entry.timestamp : "" };
    }
    const asked = customData(entry, "factory-question");
    if (asked && typeof asked.text === "string") question = asked.text;
    const task = customData(entry, "factory-task");
    if (task && isRecord(task.settings)) {
      // SAFETY: the factory-task entry is written by the plugin from a parsed StartPayload, whose settings are Settings.
      settings = task.settings as unknown as Settings;
    }
    const review = customData(entry, "factory-review");
    if (review && isRecord(review.usage)) addUsage(review.usage.input, review.usage.output, review.usage.cost, review.usage.cacheRead, review.usage.cacheWrite);
    const message = assistantMessage(entry);
    if (message && isRecord(message.usage)) {
      const { input, output, cost, cacheRead, cacheWrite } = message.usage;
      addUsage(input, output, isRecord(cost) ? cost.total : undefined, cacheRead, cacheWrite);
    }
  }
  const scouting = await scoutUsage({ kind: "task", id: record.id });
  usage = addScoutUsage(usage, scouting) as TaskView["usage"];
  const running = (await liveRunners(record)).length > 0;
  const view: Omit<TaskView, "actions"> = {
    id: record.id,
    repo: record.repo,
    worktree: record.worktree,
    branch: record.branch,
    title: record.title,
    createdAt: record.createdAt,
    tag: record.tag,
    plan: record.plan,
    wave: record.wave,
    origin: record.origin,
    sessionId: record.sessionId,
    sessionPath,
    state: last?.state ?? null,
    round: last?.round ?? null,
    reason: last?.reason ?? null,
    at: last?.at ?? null,
    question: last?.state === "waiting_answer" ? question : null,
    running,
    interrupted: last !== null && !RESTING_STATES.includes(last.state) && !running,
    settings,
    usage: usage === null ? null : { ...(usage as NonNullable<TaskView["usage"]>), cost: cents((usage as NonNullable<TaskView["usage"]>).cost) },
    scoutingCost: cents(scouting?.cost ?? 0),
    ...taskOutcome(entries, last?.state === "blocked"),
    flaky: flakyNames(entries),
  };
  const waveStage = await taskWaveStage(record, knownWaveStage);
  const continuable = waveStage === null || waveStage === "building";
  const result = { ...view, actions: taskActions(view, record.kind === "merge_request", continuable, keptByWave(view, waveStage)) };
  if (usage !== null) unroundedUsage.set(result, usage);
  unroundedScouting.set(result, scouting?.cost ?? 0);
  return result;
}

/**
 * A done task its wave still counts on: the wave is neither merged nor cancelled (nor removed). Removed, it would count
 * as cancelled and strand the tasks waiting for it, so `tasks.remove` refuses it; `waves.remove` removes it with its wave.
 */
function keptByWave(view: Pick<TaskView, "state">, waveStage: WaveStage | "removed" | null): boolean {
  return view.state === "done" && waveStage !== null && waveStage !== "removed" && !WAVE_FINAL_STAGES.includes(waveStage);
}

const APPROVE_STATES: readonly State[] = ["waiting_approve"];
const RETRY_STATES: readonly State[] = ["blocked", "cancelled"];
export const FINAL_STATES: readonly State[] = ["done", "cancelled"];

/** A live runner holds it, or its state is `running`/`merging` with a live runner. */
function isActive(view: Omit<TaskView, "actions">): boolean {
  return view.running || (view.state !== null && !RESTING_STATES.includes(view.state) && !view.interrupted);
}

/** The check of `requireRemovable` as a predicate: it neither runs nor waits for an answer. */
export function removable(view: Omit<TaskView, "actions">): boolean {
  return !isActive(view) && view.state !== "waiting_answer";
}

/**
 * The predicates of the task actions' own checks (`requireState`, the lock, the runner, `requireContinuable`), as one
 * list for clients. An old merge request (`mergeRequest`) can only be removed. A task of a wave that does not build
 * (`continuable` false) is not continued: no approve, retry or message but the answer to its question. A done task its
 * wave still counts on (`kept`) is not removed.
 */
function taskActions(view: Omit<TaskView, "actions">, mergeRequest = false, continuable = true, kept = false): TaskActionName[] {
  const allowed: Record<TaskActionName, boolean> = {
    "tasks.approve": !mergeRequest && continuable && !view.running && !view.interrupted && view.state !== null && APPROVE_STATES.includes(view.state),
    "tasks.retry": !mergeRequest && continuable && !view.running && (view.interrupted || (view.state !== null && RETRY_STATES.includes(view.state))),
    "tasks.cancel": !mergeRequest && (view.state === null || !FINAL_STATES.includes(view.state)),
    "tasks.remove": removable(view) && !kept,
    "tasks.message": !mergeRequest && view.state !== null && view.state !== "merging" && (continuable || view.state === "waiting_answer"),
  };
  return (Object.keys(allowed) as TaskActionName[]).filter((name) => allowed[name]);
}

/**
 * Refuses `what` for a task of a wave that is not `building` (invariant 2): from its review on, the gates and the
 * reviewer have seen the wave's branch, and a commit of the task would reach it unseen (or, once merged, be lost).
 */
async function requireContinuable(record: TaskRecord, what: string): Promise<void> {
  const stage = await taskWaveStage(record);
  if (stage === null || stage === "building") return;
  const wave = (record.wave ?? "").slice(0, SHORT_ID_CHARS);
  throw new FactoryError(
    "refused",
    `task ${shortId(record)} belongs to wave ${wave}, which is ${stage === "removed" ? "removed" : stage}: its tasks take no more work once it left building, ${what} is refused; give the work to the wave with waves.add`,
  );
}

/**
 * Refuses `what` for an old merge request (invariant 7): it ran without a coder, under rules that are gone; no runner
 * starts for it again, it can only be removed.
 */
function refuseMergeRequest(record: TaskRecord, what: string): void {
  if (record.kind === "merge_request") throw new FactoryError("refused", `task ${shortId(record)} is an old merge request: ${what} is refused, it can only be removed`);
}

/** No runner lives and nothing moves the task on by itself: its state is a resting one, or it is interrupted. */
export function rests(view: TaskView): boolean {
  return !view.running && (view.interrupted || (view.state !== null && RESTING_STATES.includes(view.state)));
}

/** It rests and waits for someone: every resting state but `done`. */
export function needsAttention(view: TaskView): boolean {
  return rests(view) && view.state !== "done";
}

function stateText(view: TaskView): string {
  if (view.state === null) return "starting";
  if (view.interrupted) return `interrupted (${view.state} when its runner ended, round ${view.round}, ${view.reason})`;
  return `${view.state} (round ${view.round}, ${view.reason})`;
}

function requireState(view: TaskView, allowed: readonly State[], what: string, orInterrupted = false): void {
  if (orInterrupted && view.interrupted) return;
  if (view.state === null || view.interrupted || !allowed.includes(view.state)) {
    throw new FactoryError("refused", `task ${view.id.slice(0, SHORT_ID_CHARS)} is ${stateText(view)}, ${what}`);
  }
}

/** Takes the task lock; a live holder is `busy`. */
async function lock(record: TaskRecord): Promise<void> {
  try {
    await lockTask(record.id);
  } catch (error) {
    if (error instanceof TaskBusyError) throw new FactoryError("busy", error.message);
    throw error;
  }
}

/**
 * Runs `act` holding the task lock; a lock `act` handed to a runner stays with it. `check` runs first without the lock
 * (a refusal names the state, not the lock) and again under it.
 */
export async function withTaskLock<T>(record: TaskRecord, check: (view: TaskView) => Promise<void>, act: (view: TaskView) => Promise<T>): Promise<T> {
  await check(await taskView(record));
  await lock(record);
  try {
    const view = await taskView(record);
    await check(view);
    return await act(view);
  } finally {
    await unlockTask(record.id);
  }
}

async function requireNoRunner(record: TaskRecord): Promise<void> {
  if ((await liveRunners(record)).length > 0) throw new FactoryError("busy", `the runner of task ${shortId(record)} is still ending, try again in a few seconds`);
}

/** A command for a task at rest goes through a new runner; the last one must have ended first. */
async function sendToRestingTask(record: TaskRecord, message: string, env: RunnerEnv | undefined): Promise<void> {
  await requireNoRunner(record);
  await sendCommand(record, message, env);
}

/** The real path of `path`, itself when it does not exist. */
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Refuses (`refused`) an imported record unless `repo` is a primary checkout and `worktree` one of its linked
 * worktrees (per `git worktree list`) with `branch` checked out: removing the task deletes exactly those.
 */
async function requireLinkedWorktree(record: TaskRecord): Promise<void> {
  const refuse = (why: string) => new FactoryError("refused", `tasks.import: ${why}`);
  const list = await runCommand(["git", "worktree", "list", "--porcelain"], { cwd: record.repo, maxStdoutChars: 1_000_000 }).catch(() => undefined);
  if (list === undefined || list.exitCode !== 0) throw refuse(`${record.repo} is not a git repository`);
  const blocks = list.stdout
    .split("\n\n")
    .map((block) => block.split("\n").filter((line) => line !== ""))
    .filter((lines) => lines.length > 0);
  const pathOf = (lines: string[]) => realPath(lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length) ?? "");
  const [primary, ...linked] = blocks;
  if (primary === undefined || pathOf(primary) !== realPath(record.repo)) throw refuse(`${record.repo} is not the primary checkout of its repository`);
  const worktree = linked.find((lines) => pathOf(lines) === realPath(record.worktree));
  if (worktree === undefined) throw refuse(`${record.worktree} is not a linked worktree of ${record.repo}`);
  if (!worktree.includes(`branch refs/heads/${record.branch}`)) throw refuse(`${record.worktree} does not have branch ${record.branch} checked out`);
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
  "factory-spawn": "spawn",
  "factory-question": "question",
};

/** The entries of the session file's complete lines from byte `since` on; `next` is the end of the last one. */
async function readTimeline(record: TaskRecord, since: number): Promise<{ entries: TimelineEntry[]; next: number }> {
  const path = await sessionFilePath(record.sessionDir, record.sessionId);
  if (path === undefined) {
    if (since > 0) throw new FactoryError("invalid", `task ${shortId(record)} has no session file yet, since must be 0`);
    return { entries: [], next: 0 };
  }
  const size = (await stat(path)).size;
  if (since > size) throw new FactoryError("invalid", `since ${since} is past the end of the session file (${size} bytes)`);
  // Only the bytes from `since` on: a poll costs what was appended, not the whole session.
  const bytes = Buffer.from(await Bun.file(path).slice(since, size).arrayBuffer());
  const end = bytes.lastIndexOf(0x0a) + 1;
  if (end === 0) return { entries: [], next: since };
  const entries: TimelineEntry[] = [];
  for (const entry of parseEntries(bytes.subarray(0, end).toString("utf8"))) {
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
      throw new FactoryError("failed", `the runner of task ${shortId(record)} ended before it ran${last === "" ? "" : ` (${last})`}`);
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

/** The check of `tasks.remove` before it looks at the work: refused while the task runs or waits for an answer. */
export function requireRemovable(view: TaskView): void {
  if (isActive(view)) throw new FactoryError("refused", `task ${view.id.slice(0, SHORT_ID_CHARS)} is running, cancel it first`);
  if (view.state === "waiting_answer") {
    throw new FactoryError("refused", `task ${view.id.slice(0, SHORT_ID_CHARS)} waits for the answer to its question, answer it with tasks.message or cancel it first`);
  }
}

/** The wave's check of `tasks.remove` (`keptByWave`): a done task its wave still counts on stays. */
async function requireNotKeptByWave(record: TaskRecord, view: TaskView): Promise<void> {
  const stage = await taskWaveStage(record);
  if (!keptByWave(view, stage)) return;
  const wave = (record.wave ?? "").slice(0, SHORT_ID_CHARS);
  throw new FactoryError(
    "refused",
    `task ${shortId(record)} is done in wave ${wave}, which is ${stage}: the wave counts on it (removed, the tasks waiting for it could never start); remove it once the wave is merged or cancelled, or with its wave (waves.remove)`,
  );
}

/** What removing the task would drop; refused (detail `force`) without `force` when that is anything. */
export async function droppedWork(record: TaskRecord, force: boolean): Promise<string | null> {
  const target = await taskMainBranch(record.sessionDir, record.sessionId);
  const work = await unmergedWork(record, target);
  const dropsWork = work.commits > 0 || work.dirty;
  if (dropsWork && !force) {
    const changes = work.dirty ? " and uncommitted changes in its worktree" : "";
    throw new FactoryError("refused", `task ${shortId(record)} has ${unmergedText(work, target)}${changes}, give force: true to remove it anyway`, { force: true });
  }
  return dropsWork ? `${unmergedText(work, target)}${work.dirty ? " and uncommitted changes" : ""}` : null;
}

/** Stages nothing leaves. */
export const WAVE_FINAL_STAGES: readonly WaveStage[] = ["merged", "cancelled"];

/**
 * Refuses a task outside a wave whose target is the branch of a wave not merged or cancelled (invariant 13): the wave
 * would neither wait for it nor watch it, and its gates and reviewer would see a change none of its tasks made.
 */
async function requireNoOpenWaveBranch(repo: string, target: string): Promise<void> {
  for (const file of await listWaves()) {
    if (file.declaration.repo !== repo) continue;
    // A queued wave's branch is set by its `start` event, not in its declaration.
    const { stage, id, branch } = foldWave(file.declaration, file.events);
    if (branch !== target) continue;
    if (WAVE_FINAL_STAGES.includes(stage)) continue;
    throw new FactoryError(
      "refused",
      `${target} is the branch of wave ${id.slice(0, SHORT_ID_CHARS)}, which is ${stage}: only the wave's own tasks reach it; give the work to the wave with waves.add`,
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

export const TASK_HANDLERS = {
  "tasks.list": async (params, { cwd }) => {
    const tag = tagParam("tasks.list", params.tag);
    const repo = params.repo === undefined ? undefined : await primaryOf(params.repo as string, cwd);
    return { tasks: await Promise.all((await tasksIn(repo, tag)).map((record) => taskView(record))) };
  },

  "tasks.get": async (params) => taskView(await findTask(params.id)),
  "tasks.import": async (params) => {
    const raw = params.record as Record<string, unknown>;
    let record: TaskRecord;
    try {
      // Invariant 4: only `waves.start`/`waves.add` put a task into a wave, never an import.
      record = { ...parseTaskRecord(raw, String(raw.id)), wave: null };
      if (!/^[0-9a-f-]{36}$/.test(record.id)) throw new Error(`${record.id} is not a task id`);
      if (!isAbsolute(record.repo) || !isAbsolute(record.worktree)) throw new Error("repo and worktree must be absolute paths");
    } catch (error) {
      throw new FactoryError("invalid", `tasks.import: ${errorText(error)}`);
    }
    const existing = (await listTasks()).find((task) => task.id === record.id);
    if (existing) return taskView(existing);
    await requireLinkedWorktree(record);
    await writeTask(record);
    return taskView(record);
  },

  "tasks.timeline": async (params) => readTimeline(await findTask(params.id), (params.since as number | undefined) ?? 0),

  "tasks.diff": async (params) => {
    const record = await findTask(params.id);
    const target = await taskMainBranch(record.sessionDir, record.sessionId);
    if (target === undefined) throw new FactoryError("refused", `task ${shortId(record)} has not started yet, so it has no diff`);
    if (!existsSync(record.worktree)) throw new FactoryError("refused", `the worktree of task ${shortId(record)} is gone (${record.worktree})`);
    const base = await git(runCommand, record.worktree, ["merge-base", "HEAD", `refs/heads/${target}`]);
    // An old merge request's reviewer saw, and its target got, the committed tree only.
    const tree = record.kind === "merge_request" ? await git(runCommand, record.worktree, ["rev-parse", "HEAD^{tree}"]) : await snapshotTree(runCommand, record.worktree);
    const diff = await treeDiff(runCommand, record.worktree, base, tree);
    const files: FileCounts[] = await diffFileCounts(runCommand, record.worktree, base, tree);
    return { base, diff: diff.patch, files };
  },

  "tasks.start": async (params, { cwd, signal, env, origin }) => {
    const title = nonEmpty(params.title);
    const request = nonEmpty(params.request);
    if (title === undefined) throw new FactoryError("invalid", "tasks.start needs a title that is not empty");
    if (request === undefined) throw new FactoryError("invalid", "tasks.start needs a request that is not empty");
    const tag = tagParam("tasks.start", params.tag);
    if (params.plan !== undefined && nonEmpty(params.plan) === undefined) throw new FactoryError("invalid", "tasks.start: plan must not be empty");
    const plan = params.plan as string | undefined;
    let overrides: StoredSettings = {};
    try {
      if (params.overrides !== undefined) {
        const { models, ...fields } = parseSettingsFields(params.overrides as Params, "overrides.");
        overrides = models === undefined ? fields : { ...fields, models: normalizeModels(models) };
      }
    } catch (error) {
      throw new FactoryError("invalid", errorText(error));
    }
    const repo = await primaryOf(params.repo as string, cwd);
    const stored = await loadSettings(repo);
    const { coder, reviewer } = resolveSettings(stored, overrides, "").models;
    await requireFactoryModels({ coder, reviewer });
    // The target as `launchTask` resolves it; a missing default branch is its refusal.
    const target = overrides.branch ?? stored.branch ?? (await defaultBranch(repo).catch(() => undefined));
    if (target !== undefined) await requireNoOpenWaveBranch(repo, target);
    // Again once the worktree exists: a wave declared on the branch meanwhile (a racing `waves.start`) wins.
    const beforeRecord = (branch: string) => requireNoOpenWaveBranch(repo, branch);
    try {
      return taskView(await launchTask({ repo, title, request, overrides, tag, plan, origin: origin ?? null, signal, env, beforeRecord }));
    } catch (error) {
      if (error instanceof LaunchRefusedError) throw new FactoryError("refused", error.message);
      throw error;
    }
  },

  "tasks.approve": async (params, { env }) => {
    const record = await findTask(params.id);
    refuseMergeRequest(record, "approve");
    const check = async (view: TaskView) => {
      requireState(view, APPROVE_STATES, "approve needs waiting_approve");
      await requireContinuable(record, "approve");
    };
    await withTaskLock(record, check, () => sendToRestingTask(record, "/factory approve", env));
    await pokeWaveOf(record, env);
    return taskView(record);
  },

  "tasks.retry": async (params, { env }) => {
    const record = await findTask(params.id);
    refuseMergeRequest(record, "retry");
    // An interrupted task is set right by the session's start (`resumeTask`) before the retry runs.
    const check = async (view: TaskView) => {
      requireState(view, RETRY_STATES, "retry needs blocked, cancelled or interrupted", true);
      await requireContinuable(record, "retry");
    };
    const sent = await withTaskLock(record, check, async (view) => {
      const statesBefore = (await readFactoryStates(record.sessionDir, record.sessionId)).count;
      await sendToRestingTask(record, "/factory retry", env);
      return { interrupted: view.interrupted, statesBefore };
    });
    if (sent.interrupted) await requireRunnerStarted(record, sent.statesBefore);
    await pokeWaveOf(record, env);
    return taskView(record);
  },

  "tasks.cancel": async (params, { env }) => {
    const record = await findTask(params.id);
    refuseMergeRequest(record, "cancel");
    const before = await taskView(record);
    if (before.state !== null && FINAL_STATES.includes(before.state)) throw new FactoryError("refused", `task ${shortId(record)} is ${before.state} already`);
    await cancelTask(record, env);
    return taskView(record);
  },

  "tasks.remove": async (params) => {
    const record = await findTask(params.id);
    return withTaskLock(
      record,
      async (view) => {
        requireRemovable(view);
        await requireNotKeptByWave(record, view);
      },
      async () => {
        const dropped = await droppedWork(record, params.force === true);
        await deleteTask(record);
        return { removed: record.id, dropped };
      },
    );
  },

  "tasks.message": async (params, { env }) => {
    const record = await findTask(params.id);
    refuseMergeRequest(record, "a message");
    const text = nonEmpty(params.text);
    if (text === undefined) throw new FactoryError("invalid", "tasks.message needs a text that is not empty");
    const view = await taskView(record);
    if (view.state === null) throw new FactoryError("refused", `task ${shortId(record)} has not started yet, send the message once it runs`);
    if (view.state === "merging") throw new FactoryError("refused", `task ${shortId(record)} is merging, send the message when the merge has ended`);
    // The answer to its question continues the round it asked in, a wave's task or not; anything else is more work.
    if (view.state !== "waiting_answer") await requireContinuable(record, "a message");
    // `messageTask` takes the task lock itself (resting) or appends to the live runner's inbox (running).
    const deliver = async () => {
      try {
        await messageTask(record, text, env);
      } catch (error) {
        if (error instanceof MessageRefusedError) throw new FactoryError("refused", error.message);
        if (error instanceof TaskBusyError) throw new FactoryError("busy", oneLine(errorText(error)));
        throw new FactoryError("failed", oneLine(errorText(error)));
      }
    };
    await deliver();
    // A runner that ended as the line was appended never sends it: take it back and start a runner with it.
    if ((await liveRunners(record)).length === 0 && (await withdrawUnsentLine(record, text))) await deliver();
    await pokeWaveOf(record, env);
    return taskView(record);
  },
} satisfies Record<string, Handler>;
