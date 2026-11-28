/**
 * Factory task state, without Pi, git or I/O.
 *
 * - Provides the entry shapes the extension writes (`factory-task`, `-round`, `-gate`, `-review`, `-merge-intent`,
 *   `-merge`, `-state`, `-commit-message`, `-question`)
 * - Provides the reducer that rebuilds a task from those entries (`rebuild`), the same one that tracks it live (`applyEntry`)
 * - Provides the round budget, the `/factory start` payload check and the feedback texts the coder reads
 */
import type { CommitMessage } from "./commitmsg.ts";
import type { CommandResult } from "./run.ts";
import type { Usage } from "./util.ts";

/**
 * `waiting_answer`: the coder asked the supervisor (`factory-question`); the next message answers it. `reviewing`: a
 * task of a wave passed its gates and waits for the wave's reviewer (`review-each.ts`), whose
 * verdict comes as `/factory reviewed`.
 */
export type State = "running" | "waiting_approve" | "waiting_answer" | "blocked" | "merging" | "done" | "cancelled" | "reviewing";
/** `factoryTurn`: resting, but the next step is the factory's (a watcher does not count it as rest). */
const STATES: Record<State, { rests: boolean; factoryTurn?: true; final?: true }> = {
  running: { rests: false },
  waiting_approve: { rests: true },
  waiting_answer: { rests: true },
  blocked: { rests: true },
  merging: { rests: false },
  done: { rests: true, final: true },
  cancelled: { rests: true, final: true },
  reviewing: { rests: true, factoryTurn: true },
};
export const isResting = (state: State): boolean => STATES[state].rests;
export const isFactoryTurn = (state: State): boolean => STATES[state].factoryTurn === true;
export const isFinal = (state: State): boolean => STATES[state].final === true;
export type GatePhase = "gates" | "merge_gates" | "after_merge";
export type Trigger = "start" | "gates" | "review" | "protected" | "message" | "retry" | "conflict";
export type Severity = "blocker" | "major" | "minor";
export type ReviewStatus = "ok" | "malformed" | "aborted" | "failed" | "no_diff";

export interface Settings {
  /** The branch the task's worktree starts from, is rebased onto and merges into. */
  branch: string;
  merge: "auto" | "review";
  maxRounds: number;
  review: boolean;
  /** The models this task's roles run with (`taskModels`); a role without one runs with the session's. */
  models: { coder?: string; reviewer?: string };
}

export interface StartPayload {
  request: string;
  title: string;
  settings: Settings;
  /** Only in the payload, never recorded: goes before the request in the coder's first message (a wave task's contracts). */
  prefix?: string;
}

export interface Task extends StartPayload {
  /** The task's own branch, checked out in its worktree. */
  branch: string;
  /** `settings.branch`: what the task branch is rebased onto and merges into. */
  mainBranch: string;
  /** HEAD at start. */
  baseSha: string;
}

export interface RoundData {
  round: number;
  trigger: Trigger;
}

export interface GateData {
  round: number;
  phase: GatePhase;
  argv: string[];
  /** Null when a signal ended the command, so a killed gate never reads as exit 0. */
  exitCode: number | null;
  killed: boolean;
  durationMs: number;
  outputTail: string;
  /** A step that failed and then passed on its rerun: its failing test names, else its command. Absent otherwise. */
  flaky?: string[];
}

export interface Finding {
  file: string;
  line: number | null;
  severity: Severity;
  text: string;
}

/** A minor finding as stored (`TaskView.minors`, `WaveView.minors`): never starts a round, kept with its review's round. */
export interface MinorFinding {
  round: number;
  file: string;
  line: number | null;
  text: string;
  /** The key of the wave's task whose review found it; absent for a task's own view and the wave's own reviews. */
  task?: string;
}

export function minorFindings(round: number, findings: readonly Finding[]): MinorFinding[] {
  return findings.filter((finding) => finding.severity === "minor").map(({ file, line, text }) => ({ round, file, line, text }));
}

export interface ReviewData {
  round: number;
  status: ReviewStatus;
  approved: boolean;
  findings: Finding[];
  model: string | null;
  sessionFile: string | null;
  usage: Usage;
  wallMs: number;
}

export interface MergeData {
  ok: boolean;
  commit: string | null;
  error: string | null;
  depsSynced: boolean;
  /** A landing in a checkout whose uncommitted changes did not apply back after it: the conflicting paths (the changes stay in `git stash list`); absent otherwise. */
  stashConflicts?: string[];
}

/**
 * Written right before the step of a merge that cannot be undone, so a session that dies during it can tell on resume
 * whether the merge landed: `commit` is the commit the main branch moves to, `before` where it was.
 */
export interface MergeIntentData {
  commit: string;
  before: string;
}

/** What the coder asked the supervisor with `factory_ask_supervisor`. */
export interface QuestionData {
  text: string;
}

export interface StateData {
  state: State;
  round: number;
  reason: string;
}

/**
 * Wall time by key of the closed spans (ms); `since`: when the open span began. Computed while folding, never stored.
 * A task's gate time moves from the state it ran in to `gates`.
 */
export type Spent<K extends string> = { since: string; ms: Partial<Record<K, number>> };

/** Closes the open span at `at` and counts it for `key`. */
export function closeSpan<K extends string>(spent: Spent<K>, key: K, at: string): Spent<K> {
  return { since: at, ms: { ...spent.ms, [key]: (spent.ms[key] ?? 0) + Date.parse(at) - Date.parse(spent.since) } };
}

/** A task's wall time by state until `now`: the open span counts for its state, for `blocked` when its runner died, for none once final. */
export function spentUntil(snapshot: Snapshot, interrupted: boolean, now: string): Spent<State | "gates">["ms"] {
  return isFinal(snapshot.state) ? snapshot.spent.ms : closeSpan(snapshot.spent, interrupted ? "blocked" : snapshot.state, now).ms;
}

/** The shape of `Snapshot` in a cached session summary (`cache/sessions`): a cache of another version is read again. Raise it with every change of Snapshot. */
export const SNAPSHOT_VERSION = 2;

/** What the extension knows about its task: rebuilt from the session's entries, updated with every entry it writes. */
export interface Snapshot {
  task: Task;
  state: State;
  round: number;
  /**
   * First round of the current run. `start`, `message` and `retry` each open a run with a fresh `maxRounds` budget, so
   * does a `conflict` round opened on a task at rest (in place of the `message` or `retry` round).
   */
  runFirstRound: number;
  reason: string;
  /** The timestamp of the last `factory-state` entry, null before one. */
  at: string | null;
  /** Written by a merge that has not recorded its `factory-merge` entry yet. */
  mergeIntent: MergeIntentData | null;
  /** Why the current round failed: its failed gate (`<argv> (exit N)` and output tail) or failed merge; a new round clears it. */
  failure: string | null;
  /** The last review, null before one. */
  review: Pick<ReviewData, "round" | "status" | "approved" | "findings"> | null;
  /** The minor findings of every review, oldest first. */
  minors: MinorFinding[];
  /** The `flaky` names of the gate records, in order, each once. */
  flaky: string[];
  /** The commit the last successful merge landed for the task (`MergeData.commit`). */
  mergedCommit: string | null;
  /** The last successful merge's `MergeData.stashConflicts`. */
  stashConflicts?: string[];
  /** The coder's commit message for the next merge (`factory-commit-message`), null when the task title is used; a successful merge clears it. */
  commitMessage: CommitMessage | null;
  /** The coder's open question while the task is `waiting_answer`, else absent. */
  question?: string;
  /** The wall time spent so far (`Spent`). */
  spent: Spent<State | "gates">;
}

export const FEEDBACK_TYPE = "factory-feedback";
/** The `custom_message` that asks the coder for the commit message once the last round passed. */
export const COMMIT_ASK_TYPE = "factory-commit-ask";
/** The prompt of `/factory retry`. */
export const RETRY_PROMPT = "Continue the task. If a problem was reported above, fix it. Then stop.";
const MERGE_FAILED_PROMPT_START = "The merge of the task failed: ";
export const OUTPUT_TAIL_CHARS = 4000;

/** The data of each `custom` entry the extension writes, by its `customType`. */
export interface EntryData {
  "factory-task": Task;
  "factory-round": RoundData;
  "factory-gate": GateData;
  "factory-review": ReviewData;
  "factory-merge-intent": MergeIntentData;
  "factory-merge": MergeData;
  "factory-state": StateData;
  "factory-commit-message": CommitMessage;
  "factory-question": QuestionData;
}

export type EntryType = keyof EntryData;

export interface CustomEntry<K extends EntryType> {
  type: "custom";
  customType: K;
  data: EntryData[K];
}

export type EntryDraft = { [K in EntryType]: CustomEntry<K> }[EntryType];

export interface FeedbackDraft {
  type: "custom_message";
  customType: typeof FEEDBACK_TYPE;
  content: string;
  display: true;
  details: { round: number; trigger: Trigger };
}

export interface CommitAskDraft {
  type: "custom_message";
  customType: typeof COMMIT_ASK_TYPE;
  content: string;
  display: true;
  details: { round: number };
}

export type Draft = EntryDraft | FeedbackDraft | CommitAskDraft;

const RUN_TRIGGERS: readonly Trigger[] = ["start", "message", "retry"];

type Reducer<K extends EntryType> = (snapshot: Snapshot | undefined, data: EntryData[K], at: string) => Snapshot | undefined;

/** A failed gate as `<argv> (exit N)` and its output tail; null for a passed one. */
function failedGateText(gate: GateData): string | null {
  if (gate.exitCode === 0 && !gate.killed) return null;
  const tail = gate.outputTail.trimEnd();
  return `${gate.argv.join(" ")} (${gate.killed ? "killed" : `exit ${String(gate.exitCode)}`})${tail === "" ? "" : `\n${tail}`}`;
}

const REDUCERS: { [K in EntryType]: Reducer<K> } = {
  "factory-task": (_snapshot, task, at) => ({ task, state: "running", round: 0, runFirstRound: 1, reason: "", at: null, mergeIntent: null, failure: null, review: null, minors: [], flaky: [], mergedCommit: null, commitMessage: null, spent: { since: at, ms: {} } }),
  "factory-round": (snapshot, { round, trigger }) => {
    if (!snapshot) return undefined;
    const opensRun = RUN_TRIGGERS.includes(trigger) || (trigger === "conflict" && snapshot.state !== "running" && snapshot.state !== "merging");
    return { ...snapshot, round, runFirstRound: opensRun ? round : snapshot.runFirstRound, failure: null };
  },
  "factory-gate": (snapshot, gate) => {
    if (!snapshot) return undefined;
    const { since, ms } = snapshot.spent;
    const spent = { since, ms: { ...ms, [snapshot.state]: (ms[snapshot.state] ?? 0) - gate.durationMs, gates: (ms.gates ?? 0) + gate.durationMs } };
    return { ...snapshot, failure: failedGateText(gate) ?? snapshot.failure, flaky: [...new Set([...snapshot.flaky, ...(gate.flaky ?? [])])], spent };
  },
  "factory-review": (snapshot, { round, status, approved, findings }) =>
    snapshot && { ...snapshot, review: { round, status, approved, findings }, minors: [...snapshot.minors, ...minorFindings(round, findings)] },
  "factory-merge-intent": (snapshot, mergeIntent) => snapshot && { ...snapshot, mergeIntent },
  "factory-merge": (snapshot, { ok, error, commit, stashConflicts }) =>
    snapshot && {
      ...snapshot,
      mergeIntent: null,
      failure: ok ? null : (snapshot.failure ?? error),
      mergedCommit: ok && commit ? commit : snapshot.mergedCommit,
      // A message is the merge's own: a follow-up run on the done task gets asked for a new one.
      commitMessage: ok ? null : snapshot.commitMessage,
      ...(ok ? { stashConflicts } : {}),
    },
  "factory-state": (snapshot, { state, round, reason }, at) =>
    snapshot && { ...snapshot, state, round, reason, at, mergeIntent: null, question: state === "waiting_answer" ? snapshot.question : undefined, spent: closeSpan(snapshot.spent, snapshot.state, at) },
  "factory-commit-message": (snapshot, commitMessage) => snapshot && { ...snapshot, commitMessage },
  "factory-question": (snapshot, { text }) => snapshot && { ...snapshot, question: text },
};

export function isEntryType(value: string): value is EntryType {
  return Object.hasOwn(REDUCERS, value);
}

export function applyEntry<K extends EntryType>(snapshot: Snapshot | undefined, customType: K, data: EntryData[K], at = new Date().toISOString()): Snapshot | undefined {
  const reduce: Reducer<K> = REDUCERS[customType];
  return reduce(snapshot, data, at);
}

/** The task of a session branch, or undefined when the branch holds no `factory-task` entry. Unknown `factory-*` entries are skipped. */
export function rebuild(entries: Iterable<{ type?: unknown }>): Snapshot | undefined {
  let snapshot: Snapshot | undefined;
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    const { customType, data, timestamp } = entry as { customType?: unknown; data?: unknown; timestamp?: string };
    if (typeof customType === "string" && isEntryType(customType)) snapshot = applyEntry(snapshot, customType, data as EntryData[EntryType], timestamp ?? "");
  }
  return snapshot;
}

/** The prompt of `/factory retry` after a failed merge: no message the coder saw holds the merge's error. */
export function mergeFailedPrompt(error: string): string {
  return `${MERGE_FAILED_PROMPT_START}${error}\nFix the cause, then stop.`;
}

/** The text parts of a message's content (a string, or parts of which only `text` ones count), joined by newlines. */
export function messageText(message: { content?: unknown }): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.flatMap((part) => (part?.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("\n");
}

/** A user message the plugin sent itself: a `/factory` command or the prompt of `/factory retry`. */
export function isFactoryPrompt(text: string): boolean {
  return text.trimStart().startsWith("/factory") || text === RETRY_PROMPT || text.startsWith(MERGE_FAILED_PROMPT_START);
}

/**
 * The user's messages to the task of a session branch after its request, in order: the user `message` entries after
 * the `factory-task` entry but the first (the request `/factory start` sends), `/factory` commands and the prompts of
 * `/factory retry`. Feedback is a `custom_message` entry and never one of them.
 */
export function followUpMessages(entries: Iterable<{ type: string }>): string[] {
  let messages: string[] | undefined;
  let requestSeen = false;
  for (const entry of entries) {
    const { customType, message } = entry as { customType?: unknown; message?: { role?: unknown; content?: unknown } };
    if (entry.type === "custom" && customType === "factory-task") {
      messages = [];
      requestSeen = false;
    }
    if (!messages || entry.type !== "message" || message?.role !== "user") continue;
    const text = messageText(message);
    if (!requestSeen) {
      requestSeen = true;
      continue;
    }
    if (isFactoryPrompt(text)) continue;
    messages.push(text);
  }
  return messages ?? [];
}

export function roundsUsed(snapshot: Snapshot): number {
  return snapshot.round - snapshot.runFirstRound + 1;
}

export function customDraft<K extends EntryType>(customType: K, data: EntryData[K]): CustomEntry<K> {
  return { type: "custom", customType, data };
}

export function stateDraft(state: State, round: number, reason: string): CustomEntry<"factory-state"> {
  return customDraft("factory-state", { state, round, reason });
}

export function feedbackDraft(round: number, trigger: Trigger, content: string): FeedbackDraft {
  return { type: "custom_message", customType: FEEDBACK_TYPE, content, display: true, details: { round, trigger } };
}

/** Exit code of a hook or gate whose environment is broken (missing packages, tools, services): not the coder's to fix. */
export const INFRA_EXIT = 75;

export function passed(result: CommandResult): boolean {
  return result.exitCode === 0 && !result.killed;
}

export function gateData(round: number, phase: GatePhase, argv: string[], result: CommandResult, flaky: string[] | null = null): GateData {
  const data: GateData = {
    round,
    phase,
    argv,
    exitCode: result.exitCode,
    killed: result.killed,
    durationMs: result.durationMs,
    outputTail: result.output.slice(-OUTPUT_TAIL_CHARS),
  };
  if (flaky !== null) data.flaky = flaky;
  return data;
}

/** `approved` is never the reviewer's own claim: it follows from the severities. Only a blocker or major finding rejects. */
export function approvedFrom(status: ReviewStatus, findings: Finding[]): boolean {
  return status === "ok" && findings.every((finding) => finding.severity === "minor");
}

export function commandFeedback(round: number, argv: string[], result: CommandResult): string {
  const how = result.exitCode === null ? "was killed" : `failed (exit ${result.exitCode})`;
  return `Round ${round}: \`${argv.join(" ")}\` ${how}. Fix the cause, then stop.\n\n${result.output.slice(-OUTPUT_TAIL_CHARS)}`;
}

export function protectedFeedback(round: number, paths: string[]): string {
  const list = paths.map((path) => `- ${path}`).join("\n");
  return `Round ${round}: the change touches protected paths, which a task must not modify:\n${list}\nRestore them to their original state, then stop.`;
}

/**
 * The task branch does not rebase cleanly onto `branch`: the conflicting files and how to resolve them. `leftOpen`: a
 * rebase is still in progress in the task worktree, the coder finishes it.
 */
export function conflictFeedback(round: number, branch: string, files: string[], leftOpen: boolean): string {
  const list = files.map((path) => `- ${path}`).join("\n");
  const steps = leftOpen
    ? "A rebase is still in progress in the task worktree. Resolve the conflicts, `git add` the files and run `GIT_EDITOR=true git rebase --continue` until the rebase is done, then stop."
    : `Run \`git rebase refs/heads/${branch}\`, resolve the conflicts, \`git add\` the files, run \`GIT_EDITOR=true git rebase --continue\` until the rebase is done, then stop.`;
  return `Round ${round}: the task branch conflicts with ${branch}. Conflicting files:\n${list || "- (none listed)"}\n${steps}`;
}

/** The next round's feedback: the blocker and major findings only, minor ones never reach the coder as a round. */
export function reviewFeedback(round: number, findings: Finding[]): string {
  return `Round ${round}: the review found problems. Fix every blocker and major finding, then stop.\n\n${rejectingLines(findings)}`;
}

/** The blocker and major findings, one line each. */
export function rejectingLines(findings: readonly Finding[]): string {
  return findings
    .filter((finding) => finding.severity !== "minor")
    .map((finding) => `- [${finding.severity}] ${finding.file}${finding.line === null ? "" : `:${finding.line}`}: ${finding.text}`)
    .join("\n");
}

/** The roles a task runs a model for. */
export const ROLES = ["coder", "reviewer"] as const;

/** The payload of `/factory start <json>`, which `launchTask` wrote from resolved settings. Throws on a wrong one. */
export function parseStartPayload(text: string): StartPayload {
  const raw = JSON.parse(text) as Partial<StartPayload> | null;
  if (typeof raw?.request !== "string" || raw.request.trim() === "" || typeof raw.title !== "string" || raw.title.trim() === "" || !raw.settings) throw new Error("the payload needs a request, a title and settings");
  const { request, title, settings, prefix } = raw;
  return { request, title, settings, ...(prefix?.trim() ? { prefix } : {}) };
}
