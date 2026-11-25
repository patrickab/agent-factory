/**
 * The factory core: every factory feature as one action over plain JSON. Clients (the `factory` tool, pi-host, a UI)
 * import only this module and render what it returns.
 *
 * - Provides `ACTIONS` (name -> summary, JSON schema of the params, whether it changes anything) and `callAction`
 * - Every failure is a `FactoryError` of one sentence with a code: `invalid` (the params), `not_found` (repo, branch,
 *   task), `busy` (another action or a runner holds the task), `refused` (the task's state or work forbids it),
 *   `failed` (anything else)
 * - A `repo` param is a path inside the repository, relative to the caller's `cwd` (absolute without one); an action
 *   that needs one and gets none uses `cwd`. The repository is its primary checkout. A task `id` may be a unique prefix
 * - The models a task or repository may use are one user-level list (`models.ts`): `models.get`/`models.set`.
 *   `tasks.start` and `settings.set` refuse a model not on it, and anything while it is empty; reads never check it
 * - `hostOnly` actions are for the host (pi-host), never offered to an agent: `tasks.import`
 * - `tasks.wait` polls the watched tasks and waves until they rest (no runner lives and the state is a resting one, or
 *   it is interrupted; a wave: `merged`, `cancelled`) or one needs attention (a task resting and not `done`; a wave
 *   `rejected`, `blocked`, `waiting_approve` or interrupted): a supervisor's completion signal
 * - The wave actions (`waves.*`) build on `waves.ts` (the log and its fold) and `wave-poke.ts` (the runner): a stage
 *   change is a compare-and-append on the log, then a poke; `WaveView.actions` holds the same predicates
 * - Runners an action starts get the caller's `env` (default `process.env`): the host passes one without its secrets
 * - A task that checks its state and then acts on it holds the task lock (`tasks.ts`) from the check on; a runner it
 *   spawns takes the lock over until it exits. `cancel` stops a live runner first: two Pi processes never share a session
 * - Reads a task's session file for its state, settings, usage (assistant messages plus recorded reviews) and
 *   timeline (by byte offset, so a client polls with `next`)
 * - Imports only Bun, `node:` modules and plugin modules that do the same: the deployed plugin has no `node_modules`
 */
import { existsSync, realpathSync } from "node:fs";
import { readFile, stat, truncate, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { parseFactoryYaml } from "./config.ts";
import { initDraft } from "./draft.ts";
import { diffFileCounts, git, primaryCheckout, snapshotTree, treeDiff, uncommittedFiles, type FileCounts } from "./git.ts";
import {
  defaultBranch,
  deleteTask,
  launchTask,
  LaunchRefusedError,
  liveRunners,
  localBranchExists,
  messageTask,
  MessageRefusedError,
  sendCommand,
  stopRunners,
  taskInboxPath,
  unmergedWork,
  type RunnerEnv,
  type UnmergedWork,
  worktreePath,
} from "./launch.ts";
import { inboxReadPath, readFactoryStates, sessionFilePath, taskMainBranch } from "./runner.ts";
import { loadModels, requireModels, saveModels } from "./models.ts";
import type { NoticeWave } from "./notify.ts";
import { runCommand } from "./run.ts";
import {
  DEFAULT_SETTINGS,
  factoryHome,
  loadSettings,
  modelChoice,
  parseStoredSettings,
  registeredRepos,
  resolveRepoSettings,
  resolveModels,
  resolveSettings,
  saveSettings,
  unregisterRepo,
  type ResolvedModels,
  type ResolvedSettings,
  type StoredSettings,
} from "./settings.ts";
import { COMMIT_ASK_TYPE, isFactoryPrompt, messageText, normalizeModels, parseSettingsFields, RESTING_STATES, type Finding, type Settings, type State } from "./state.ts";
import { isTaskTag, listTasks, lockTask, parseTaskRecord, tagInGroup, TaskBusyError, taskLogPath, unlockTask, writeTask, type TaskRecord } from "./tasks.ts";
import { errorText, isRecord } from "./util.ts";
import {
  appendWaveEvent,
  appendWaveEvents,
  createWave,
  foldWave,
  listWaves,
  lockWave,
  parseWaveOverrides,
  readWave,
  removeWave,
  RESTING_WAVE_STAGES,
  reviewBegan,
  startableKeys,
  stuckKeys,
  unreachableKeys,
  unlockWave,
  validateTaskSpecs,
  waveCounts,
  waveTaskState,
  type NewWaveEvent,
  type WaveDeclaration,
  type WaveFile,
  type WaveFold,
  type WaveOverrides,
  type WaveStage,
  type WaveTaskEntry,
  type WaveView,
} from "./waves.ts";
import { liveWaveRunners, pokeWave, stopWaveRunners } from "./wave-poke.ts";

export type FactoryErrorCode = "invalid" | "not_found" | "busy" | "refused" | "failed";

/** `{force: true}`: a refused `tasks.remove` that `force: true` would carry out. */
export type FactoryErrorDetail = { force: true };

export class FactoryError extends Error {
  readonly code: FactoryErrorCode;
  readonly detail: FactoryErrorDetail | undefined;
  constructor(code: FactoryErrorCode, message: string, detail?: FactoryErrorDetail) {
    super(message);
    this.name = "FactoryError";
    this.code = code;
    this.detail = detail;
  }
}

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
  /** Coder messages and reviews together; `input` is uncached input tokens. Null before either. */
  usage: { input: number; output: number; cost: number } | null;
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

type Schema = Record<string, unknown>;

export interface ActionSpec {
  summary: string;
  params: { type: "object"; required: string[]; properties: Record<string, Schema> };
  mutates: boolean;
  /** For the host only: never offered to an agent. */
  hostOnly: boolean;
}

const SHORT_ID_CHARS = 8;

const REPO: Schema = { type: "string", description: "A path inside the git repository. Default: the current directory" };
const ID: Schema = { type: "string", description: "The task id or a unique prefix of it" };
const WAVE_ID: Schema = { type: "string", description: "The wave id or a unique prefix of it" };
/** One task of `waves.start` / `waves.add`. */
const WAVE_TASK_ITEM: Schema = {
  type: "object",
  required: ["key", "title", "request"],
  properties: {
    key: { type: "string" },
    title: { type: "string" },
    request: { type: "string" },
    after: { type: "array", items: { type: "string" } },
    model: { type: "string", description: "This task's coder model (provider/model on the factory models list); default the wave's coder model" },
  },
};
const TAG: Schema = { type: "string", description: "A task tag: segments of A-Z a-z 0-9 . _ @ + - joined by /" };
const TAG_FILTER: Schema = { type: "string", description: "Only the tasks whose tag is this one or lies under it (a holds a/b, not ab)" };
const WAIT_TIMEOUT_MS = { default: 600_000, minimum: 1_000, maximum: 3_600_000 };
const SETTINGS_PROPERTIES: Record<string, Schema> = {
  merge: { type: "string", enum: ["auto", "review"], description: "auto: merge a passed round. review: wait for approve" },
  maxRounds: { type: "integer", minimum: 1, maximum: 20 },
  review: { type: "boolean", description: "Run the reviewer on every round" },
  branch: { type: "string", description: "The branch the task starts from and merges into" },
  models: {
    type: "object",
    properties: { coder: { type: "string", description: "provider/model" }, reviewer: { type: "string", description: "provider/model" } },
  },
};

const REMOTE: Schema = { type: "boolean", description: "Push a wave's branch, open its pull/merge request on the origin's forge (gh, glab), comment the reviews, push the target after the merge" };

function spec(summary: string, properties: Record<string, Schema>, required: string[], mutates: boolean, hostOnly = false): ActionSpec {
  return { summary, params: { type: "object", required, properties }, mutates, hostOnly };
}

export const ACTIONS = {
  "models.get": spec("The factory models: the provider/model ids tasks and repository settings may use", {}, [], false),
  "models.set": spec(
    "Replace the factory models",
    { models: { type: "array", items: { type: "string" }, description: "provider/model ids" } },
    ["models"],
    true,
  ),
  "repos.list": spec("The registered repositories (those with a settings file)", {}, [], false),
  "repos.add": spec("Register a repository: give it a settings file", { repo: REPO }, ["repo"], true),
  "repos.remove": spec("Unregister a repository: remove its settings file", { repo: REPO }, ["repo"], true),
  "branches.list": spec("The repository's local branches, its default one and which hold a committed factory.yaml", { repo: REPO }, ["repo"], false),
  "settings.get": spec("The repository's stored settings, them resolved over the defaults, and the defaults", { repo: REPO }, ["repo"], false),
  "settings.set": spec(
    "Replace the repository's stored settings",
    { repo: REPO, settings: { type: "object", description: "The stored settings", properties: { ...SETTINGS_PROPERTIES, preview: { type: "boolean" }, remote: REMOTE } } },
    ["repo", "settings"],
    true,
  ),
  "config.get": spec(
    "The repository's factory.yaml (the working copy, or committed on branch) and a draft when it has none",
    { repo: REPO, branch: { type: "string", description: "Read factory.yaml as committed on this branch" } },
    ["repo"],
    false,
  ),
  "config.write": spec(
    "Check factory.yaml text and write it into a registered repository's checkout (not committed)",
    {
      repo: REPO,
      text: { type: "string", description: "The factory.yaml text" },
      overwrite: { type: "boolean", description: "Replace an existing factory.yaml" },
    },
    ["repo", "text"],
    true,
  ),
  "tasks.list": spec("Every task, or the repository's", { repo: { type: "string", description: "Only the tasks of this repository" }, tag: TAG_FILTER }, [], false),
  "tasks.get": spec("One task", { id: ID }, ["id"], false),
  "tasks.import": spec(
    "Register a task another store kept: its record as the core writes them; an existing id stays unchanged. The worktree must be a linked worktree of repo (its primary checkout) on branch",
    {
      record: {
        type: "object",
        description: "id, repo, worktree, branch, title, sessionId, sessionDir, createdAt: non-empty strings; optional tag (default the system user), plan (string or null). A wave field is dropped: an imported task belongs to no wave",
      },
    },
    ["record"],
    true,
    true,
  ),
  "tasks.timeline": spec(
    "A task's session as entries; poll with since = the last answer's next",
    { id: ID, since: { type: "integer", minimum: 0, description: "The cursor an earlier answer returned as next" } },
    ["id"],
    false,
  ),
  "tasks.diff": spec("A task's worktree against where it branched off its target", { id: ID }, ["id"], false),
  "tasks.start": spec(
    "Start a task in its own worktree; answers once its runner is spawned",
    {
      repo: REPO,
      title: { type: "string", description: "A short title of the task" },
      request: { type: "string", description: "The full, self-contained task for the coder" },
      overrides: { type: "object", description: "Settings over the repository's stored ones", properties: SETTINGS_PROPERTIES },
      tag: { ...TAG, description: `${String(TAG.description)}. Default: the system user` },
      plan: { type: "string", description: "The memory_store path of the plan the task works from (only stored)" },
    },
    ["repo", "title", "request"],
    true,
  ),
  "tasks.wait": spec(
    "Wait until the watched tasks and waves rest or one needs attention, or the timeout passes. A task rests with no runner in waiting_approve, waiting_answer, blocked, done or cancelled, or interrupted; it needs attention resting and not done (a cancelled task of a watched wave left the wave and needs none). A wave rests merged or cancelled; it needs attention rejected, blocked, waiting_approve, interrupted, or building with tasks that can never start (a task they wait for was cancelled or removed) while none of its tasks runs; its tasks resting while it builds, reviews or merges is not the end. Answers {tasks, waves, attention: task and wave ids, timedOut}",
    {
      ids: { type: "array", items: { type: "string" }, description: "Watch these tasks (ids or unique prefixes); give exactly one of ids, tag and wave" },
      tag: {
        ...TAG_FILTER,
        description: "Watch the tasks and the waves whose tag is this one or lies under it, those started during the wait too; give exactly one of ids, tag and wave",
      },
      wave: { type: "string", description: "Watch this wave (id or unique prefix) and its tasks; give exactly one of ids, tag and wave" },
      ignore: { type: "array", items: { type: "string" }, description: "Task or wave ids (or prefixes) left out of the watched ones" },
      timeoutMs: { type: "integer", minimum: WAIT_TIMEOUT_MS.minimum, maximum: WAIT_TIMEOUT_MS.maximum, description: `Default: ${WAIT_TIMEOUT_MS.default}` },
    },
    [],
    false,
  ),
  "tasks.approve": spec("Merge a task waiting for approve", { id: ID }, ["id"], true),
  "tasks.retry": spec("Another round on a blocked, cancelled or interrupted task", { id: ID }, ["id"], true),
  "tasks.cancel": spec("Stop a task", { id: ID }, ["id"], true),
  "tasks.remove": spec(
    "Delete a task's worktree, branch and record",
    { id: ID, force: { type: "boolean", description: "Also drop commits its target branch lacks and uncommitted changes" } },
    ["id"],
    true,
  ),
  "tasks.message": spec(
    "Send a task a message: a resting task runs new rounds, a task in waiting_answer gets it as the answer to its question (same round), a running coder gets it as a follow-up",
    { id: ID, text: { type: "string", description: "The message" } },
    ["id", "text"],
    true,
  ),
  "waves.start": spec(
    "Declare a wave: a set of tasks on one new branch (<target>-<tag with / as ->) off the target, the factory starts each task once the tasks it waits for (after) are done; answers {wave}",
    {
      repo: REPO,
      tag: { ...TAG, description: "The wave's tag (its tasks carry it): segments of A-Z a-z 0-9 . _ @ + - joined by /" },
      title: { type: "string", description: "A short title of the wave" },
      request: { type: "string", description: "The reviewer's instructions for the wave's whole diff" },
      tasks: {
        type: "array",
        description:
          "The wave's tasks: key unique in the wave (A-Z a-z 0-9 . _ -), title, request (full and self-contained for the coder), after: keys this task waits for, model: this task's coder model (provider/model on the factory models list; default the wave's coder model, the reviewer's stays the wave's)",
        items: WAVE_TASK_ITEM,
      },
      plan: { type: "string", description: "The memory_store path of the plan the wave works from (only stored)" },
      overrides: { type: "object", description: "Settings over the repository's stored ones: branch = the target, merge = the wave's (review: wait for approve)", properties: { ...SETTINGS_PROPERTIES, remote: REMOTE } },
    },
    ["repo", "tag", "title", "request", "tasks"],
    true,
  ),
  "waves.add": spec(
    "Add tasks to a wave (after may name its existing keys); a rejected, blocked, reviewing or waiting_approve wave builds again. Pending tasks that can never start (a task they wait for was cancelled or removed) are dropped: they count as cancelled. Answers {wave}",
    {
      id: WAVE_ID,
      tasks: { type: "array", description: "Tasks as for waves.start: key, title, request, after?, model? (this task's coder model, on the factory models list)", items: WAVE_TASK_ITEM },
    },
    ["id", "tasks"],
    true,
  ),
  "waves.get": spec("One wave: declaration, stage, tasks with state and usage, counts, reviews, merge, usage. Answers {wave}", { id: WAVE_ID }, ["id"], false),
  "waves.list": spec(
    "Every wave, or the repository's, or those under a tag. Answers {waves}",
    { repo: { type: "string", description: "Only the waves of this repository" }, tag: { type: "string", description: "Only the waves whose tag is this one or lies under it" } },
    [],
    false,
  ),
  "waves.timeline": spec(
    "A wave's events; poll with since = the last answer's next. Answers {events, next}",
    { id: WAVE_ID, since: { type: "integer", minimum: 0, description: "The cursor an earlier answer returned as next" } },
    ["id"],
    false,
  ),
  "waves.retry": spec(
    "Run a blocked or interrupted wave again: a blocked wave with tasks not started or not finished builds again (starts them), else review and merge from the rebase on; an interrupted one resumes from its log. Answers {wave}",
    { id: WAVE_ID },
    ["id"],
    true,
  ),
  "waves.approve": spec("Merge a wave waiting for approve (its merge setting is review). Answers {wave}", { id: WAVE_ID }, ["id"], true),
  "waves.cancel": spec("Stop a wave: cancel its tasks that are not done or cancelled, stop its runner; its branch stays. Answers {wave}", { id: WAVE_ID }, ["id"], true),
  "waves.remove": spec(
    "Delete a wave's record, its tasks (as tasks.remove does) and a review worktree a block left (one holding uncommitted changes only with force); its branch only when the wave is merged. Refused while the wave or one of its tasks runs. Answers {removed: id}",
    { id: WAVE_ID, force: { type: "boolean", description: "Also drop commits its target branch lacks and uncommitted changes" } },
    ["id"],
    true,
  ),
} satisfies Record<string, ActionSpec>;

export type ActionName = keyof typeof ACTIONS;

type Params = Record<string, unknown>;

/**
 * `cwd`: where relative `repo` params start. `signal`: aborts a `tasks.start` before its runner is spawned. `env`: the
 * environment of every runner the action starts (default `process.env`). `origin`: the calling Pi session's id
 * (`tasks.start` and `waves.start` record it); the CLI and MCP give none.
 */
export interface CallOptions {
  cwd?: string;
  signal?: AbortSignal;
  env?: Record<string, string>;
  origin?: string;
}

interface CallContext {
  cwd: string | undefined;
  signal: AbortSignal | undefined;
  env: RunnerEnv | undefined;
  origin: string | undefined;
}

function isActionName(name: string): name is ActionName {
  return Object.hasOwn(ACTIONS, name);
}

const TYPE_CHECKS: Record<string, (value: unknown) => boolean> = {
  string: (value) => typeof value === "string",
  boolean: (value) => typeof value === "boolean",
  integer: (value) => typeof value === "number" && Number.isInteger(value),
  object: (value) => isRecord(value),
  array: (value) => Array.isArray(value),
};

/** The params checked against the action's schema (top-level keys only; unknown keys are dropped). */
function checkParams(name: ActionName, raw: unknown, cwd: string | undefined): Params {
  if (raw !== undefined && raw !== null && !isRecord(raw)) throw new FactoryError("invalid", `${name} needs its params as an object`);
  const { required, properties } = ACTIONS[name].params as ActionSpec["params"];
  const given: Params = { ...(raw ?? {}) };
  if (given.repo === undefined && required.includes("repo") && cwd !== undefined) given.repo = cwd;
  const params: Params = {};
  for (const [key, schema] of Object.entries(properties)) {
    const value = given[key];
    if (value === undefined || value === null) {
      if (required.includes(key)) throw new FactoryError("invalid", `${name} needs ${key}`);
      continue;
    }
    const type = String(schema.type);
    if (!TYPE_CHECKS[type](value)) throw new FactoryError("invalid", `${name}: ${key} must be ${type === "integer" || type === "array" ? `an ${type}` : `a ${type}`}`);
    if (typeof schema.minimum === "number" && (value as number) < schema.minimum) throw new FactoryError("invalid", `${name}: ${key} must be at least ${schema.minimum}`);
    if (typeof schema.maximum === "number" && (value as number) > schema.maximum) throw new FactoryError("invalid", `${name}: ${key} must be at most ${schema.maximum}`);
    params[key] = value;
  }
  return params;
}

function shortId(record: TaskRecord): string {
  return record.id.slice(0, SHORT_ID_CHARS);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value !== "string" || value.trim() === "" ? undefined : value;
}

/** `repo` resolved against `cwd`; a relative one without `cwd` is `invalid`. */
function repoPath(repo: string, cwd: string | undefined): string {
  if (isAbsolute(repo)) return repo;
  if (cwd === undefined) throw new FactoryError("invalid", `repo ${repo} must be an absolute path (the call has no cwd)`);
  return resolve(cwd, repo);
}

/** The primary checkout of the repository `repo` is in. */
async function primaryOf(repo: string, cwd: string | undefined): Promise<string> {
  const path = repoPath(repo, cwd);
  try {
    return (await primaryCheckout(runCommand, path)).primary;
  } catch {
    throw new FactoryError("not_found", `${path} is not inside a git repository`);
  }
}

/** The task whose id is `id` or starts with it. */
async function findTask(id: unknown): Promise<TaskRecord> {
  const wanted = nonEmpty(id)?.trim();
  if (wanted === undefined) throw new FactoryError("invalid", "the id of a task must not be empty");
  const tasks = await listTasks();
  const exact = tasks.find((task) => task.id === wanted);
  if (exact) return exact;
  const matches = tasks.filter((task) => task.id.startsWith(wanted));
  if (matches.length === 0) throw new FactoryError("not_found", `no task has an id starting with "${wanted}"`);
  if (matches.length > 1) {
    throw new FactoryError("invalid", `"${wanted}" matches ${matches.length} tasks (${matches.map((task) => task.id).join(", ")}), give more of the id`);
  }
  return matches[0];
}

async function branchHasConfig(repo: string, branch: string): Promise<boolean> {
  return (await runCommand(["git", "cat-file", "-e", `refs/heads/${branch}:factory.yaml`], { cwd: repo })).exitCode === 0;
}

/** The blob `object` (`<ref>:<path>`) as git stores it, not trimmed. */
async function committedText(repo: string, object: string): Promise<string> {
  const result = await runCommand(["git", "cat-file", "blob", object], { cwd: repo, maxStdoutChars: 4_000_000 });
  if (result.exitCode !== 0 || result.killed || result.stdoutTruncated) throw new Error(`git cat-file blob ${object} failed (exit ${result.exitCode})`);
  return result.stdout;
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

async function taskView(record: TaskRecord, knownWaveStage?: WaveStage): Promise<TaskView> {
  const sessionPath = (await sessionFilePath(record.sessionDir, record.sessionId)) ?? null;
  const entries = sessionPath === null ? [] : parseEntries(await readFile(sessionPath, "utf8"));
  let last: { state: State; round: number; reason: string; at: string } | null = null;
  let settings: Settings | null = null;
  let question: string | null = null;
  let usage: TaskView["usage"] = null;
  const addUsage = (input: unknown, output: unknown, cost: unknown) => {
    usage ??= { input: 0, output: 0, cost: 0 };
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
    if (review && isRecord(review.usage)) addUsage(review.usage.input, review.usage.output, review.usage.cost);
    const message = assistantMessage(entry);
    if (message && isRecord(message.usage)) {
      const { input, output, cost } = message.usage;
      addUsage(input, output, isRecord(cost) ? cost.total : undefined);
    }
  }
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
    usage,
    ...taskOutcome(entries, last?.state === "blocked"),
  };
  const waveStage = await taskWaveStage(record, knownWaveStage);
  const continuable = waveStage === null || waveStage === "building";
  return { ...view, actions: taskActions(view, record.kind === "merge_request", continuable, keptByWave(view, waveStage)) };
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
const FINAL_STATES: readonly State[] = ["done", "cancelled"];

/** A live runner holds it, or its state is `running`/`merging` with a live runner. */
function isActive(view: Omit<TaskView, "actions">): boolean {
  return view.running || (view.state !== null && !RESTING_STATES.includes(view.state) && !view.interrupted);
}

/** The check of `requireRemovable` as a predicate: it neither runs nor waits for an answer. */
function removable(view: Omit<TaskView, "actions">): boolean {
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
function rests(view: TaskView): boolean {
  return !view.running && (view.interrupted || (view.state !== null && RESTING_STATES.includes(view.state)));
}

/** It rests and waits for someone: every resting state but `done`. */
function needsAttention(view: TaskView): boolean {
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
async function withTaskLock<T>(record: TaskRecord, check: (view: TaskView) => Promise<void>, act: (view: TaskView) => Promise<T>): Promise<T> {
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

/** A tag param, `invalid` unless it is segments joined by `/` (`isTaskTag`). */
function tagParam(name: ActionName, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isTaskTag(value)) throw new FactoryError("invalid", `${name}: tag ${JSON.stringify(value)} is not segments of A-Z a-z 0-9 . _ @ + - joined by /`);
  return value;
}

/** An array param of non-empty strings, `invalid` otherwise. */
function stringsParam(name: ActionName, key: string, value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const strings = value as unknown[];
  if (strings.some((item) => nonEmpty(item) === undefined)) throw new FactoryError("invalid", `${name}: ${key} must hold non-empty strings`);
  return (strings as string[]).map((item) => item.trim());
}

/** The tasks of `repo` (every repository's without), only those in the tag group `tag` when given. */
async function tasksIn(repo: string | undefined, tag: string | undefined): Promise<TaskRecord[]> {
  const records = await listTasks(repo);
  return tag === undefined ? records : records.filter((record) => tagInGroup(record.tag, tag));
}

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
 * No runner lives and nothing moves the wave on by itself: its stage is a resting one, it is interrupted, or it builds
 * stuck (`stuckKeys`: tasks that can never start and nothing else running), where its runner rests too.
 */
function waveRests({ view, stuck }: WaveLook): boolean {
  return view.interrupted || (!view.running && (stuck || RESTING_WAVE_STAGES.includes(view.stage)));
}

/**
 * It waits for the supervisor (invariant 8): resting `rejected`, `blocked`, `waiting_approve` or interrupted, or stuck
 * while it builds (whether or not its runner has rested yet).
 */
function waveNeedsAttention(look: WaveLook): boolean {
  return look.stuck || (waveRests(look) && (look.view.interrupted || WAVE_ATTENTION_STAGES.includes(look.view.stage)));
}

/**
 * One cheap look at the watched waves (their logs, the polled states of a building wave's tasks, a runner lookup only
 * for a wave that does not rest): `attention` when one may need it (a resting stage that asks for it, a building wave
 * stuck, or no runner where one should live), `busy` when one still moves (a runner builds, reviews or merges it).
 * `stateOf` is a started task's state, `undefined` when its record is gone (it counts as cancelled).
 */
async function pollWaves(files: WaveFile[], stateOf: (taskId: string) => Promise<State | null | undefined>): Promise<{ attention: boolean; busy: boolean }> {
  let attention = false;
  let busy = false;
  for (const file of files) {
    const fold = foldWave(file.declaration, file.events);
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
type Watched = () => Promise<{ records: TaskRecord[]; waves: WaveFile[] }>;

type WaitAnswer = { tasks: TaskView[]; waves: WaveView[]; attention: string[]; timedOut: boolean };

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
    const waves = await pollWaves(files, async (taskId) => {
      const record = byId.get(taskId);
      return record === undefined ? undefined : polledState(record, cache);
    });
    const states = (await Promise.all(records.map((record) => polledState(record, cache)))).map((state, index) => (leftWave(records[index], state) ? "done" : state));
    if (timedOut || waves.attention || (await waitMayEnd(records, states, waves.busy))) {
      const tasks = await Promise.all(records.map((record) => taskView(record)));
      const looks = await Promise.all(files.map(waveLook));
      const waveViews = looks.map((look) => look.view);
      const attention = [
        ...tasks.filter((view) => needsAttention(view) && !(view.state === "cancelled" && view.wave !== null && waveIds.has(view.wave))).map((view) => view.id),
        ...looks.filter(waveNeedsAttention).map((look) => look.view.id),
      ];
      // The views are read after the poll: a task or wave that moved on in between is polled again.
      if ((tasks.every(rests) && looks.every(waveRests)) || attention.length > 0) return { tasks, waves: waveViews, attention, timedOut: false };
      if (timedOut) return { tasks, waves: waveViews, attention, timedOut: true };
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
async function cancelTask(record: TaskRecord, env: RunnerEnv | undefined): Promise<void> {
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
function requireRemovable(view: TaskView): void {
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
async function droppedWork(record: TaskRecord, force: boolean): Promise<string | null> {
  const target = await taskMainBranch(record.sessionDir, record.sessionId);
  const work = await unmergedWork(record, target);
  const dropsWork = work.commits > 0 || work.dirty;
  if (dropsWork && !force) {
    const changes = work.dirty ? " and uncommitted changes in its worktree" : "";
    throw new FactoryError("refused", `task ${shortId(record)} has ${unmergedText(work, target)}${changes}, give force: true to remove it anyway`, { force: true });
  }
  return dropsWork ? `${unmergedText(work, target)}${work.dirty ? " and uncommitted changes" : ""}` : null;
}

async function settingsOf(repo: string): Promise<{ stored: StoredSettings; resolved: ResolvedSettings; defaults: ResolvedSettings }> {
  const stored = await loadSettings(repo);
  const fallback = await defaultBranch(repo).catch(() => undefined);
  const branch = stored.branch ?? fallback;
  if (branch === undefined) throw new FactoryError("refused", `${repo} has no default branch (origin/HEAD, main and master do not exist locally)`);
  return { stored, resolved: resolveRepoSettings(stored, {}, branch), defaults: { ...DEFAULT_SETTINGS, models: resolveModels([]), branch: fallback ?? branch } };
}

/** The models a wave's `specs` run with: `big` for coders and the reviewer, `small` only when a task asks for it. */
function wantedModels(models: ResolvedModels, specs: readonly WaveTaskEntry[]): Record<string, string> {
  const { coder, reviewer, small } = models;
  return specs.some((spec) => spec.model === "small") ? { coder, reviewer, small } : { coder, reviewer };
}

/** `requireModels` as a `refused` error. */
async function requireFactoryModels(models: Record<string, string | undefined>): Promise<void> {
  try {
    await requireModels(models);
  } catch (error) {
    throw new FactoryError("refused", errorText(error));
  }
}

function storedSettingsParam(raw: unknown, prefix: string): StoredSettings {
  try {
    return parseStoredSettings(raw);
  } catch (error) {
    throw new FactoryError("invalid", `${prefix}${errorText(error)}`);
  }
}

// ---- waves ----

export type WaveActionName = "waves.add" | "waves.retry" | "waves.approve" | "waves.cancel" | "waves.remove";

/** Stages nothing leaves. */
const WAVE_FINAL_STAGES: readonly WaveStage[] = ["merged", "cancelled"];

/** Stages a wave takes no tasks in: `merging` too, whose rebased branch is in the merge queue. */
const WAVE_ADD_REFUSED: readonly WaveStage[] = ["merged", "cancelled", "merging"];

/** The wave branch of `tag` on `target`: `<target>-<tag with "/" as "-">`. */
export function waveBranchName(target: string, tag: string): string {
  return `${target}-${tag.replaceAll("/", "-")}`;
}

/** The wave's review worktree (`wave-runner.ts`): one per wave, next to the tasks' worktrees. */
export function waveReviewWorktree(declaration: Pick<WaveDeclaration, "id" | "repo">): string {
  return worktreePath(declaration.repo, `wave-${declaration.id.slice(0, SHORT_ID_CHARS)}-review`);
}

/**
 * The wave of the task in the Pi session `sessionId` (files in `sessionDir`), null outside one. Only sessions the
 * factory keeps (under its home) are looked up.
 */
export async function taskWave(sessionDir: string, sessionId: string): Promise<string | null> {
  const sessions = join(factoryHome(), "sessions") + sep;
  if (!resolve(sessionDir).startsWith(sessions)) return null;
  return (await listTasks()).find((task) => task.sessionId === sessionId)?.wave ?? null;
}

/**
 * Why the merge of the task in the Pi session `sessionId` (files in `sessionDir`) must not land now, null when it may
 * (invariant 2): a task of a wave whose review began (`reviewBegan`) would bring commits onto the wave's branch that
 * its gates and reviewer never saw, or that are lost once it merged. The plugin asks right before a task merges, so
 * no path (an action, a `/factory` command typed into the session, a resume) gets past it. Only sessions the factory
 * keeps (under its home) are looked up; a task outside a wave merges as before.
 */
export async function waveMergeRefusal(sessionDir: string, sessionId: string): Promise<string | null> {
  const sessions = join(factoryHome(), "sessions") + sep;
  if (!resolve(sessionDir).startsWith(sessions)) return null;
  const record = (await listTasks()).find((task) => task.sessionId === sessionId);
  if (record === undefined || record.wave === null) return null;
  const short = record.wave.slice(0, SHORT_ID_CHARS);
  let file: WaveFile;
  try {
    file = await readWave(record.wave);
  } catch (error) {
    if (error instanceof FactoryError && error.code === "not_found") return `its wave ${short} is removed: nothing more reaches its branch`;
    throw error;
  }
  if (!reviewBegan(file.events)) return null;
  const { stage, branch } = foldWave(file.declaration, file.events);
  return `its wave ${short} is ${stage}, its review began: nothing more reaches its branch ${branch} (the reviewed tree is what merges); give the work to the wave with waves.add`;
}

/**
 * Refuses a task outside a wave whose target is the branch of a wave not merged or cancelled (invariant 13): the wave
 * would neither wait for it nor watch it, and its gates and reviewer would see a change none of its tasks made.
 */
async function requireNoOpenWaveBranch(repo: string, target: string): Promise<void> {
  for (const file of await listWaves()) {
    if (file.declaration.repo !== repo || file.declaration.branch !== target) continue;
    const { stage, id } = foldWave(file.declaration, file.events);
    if (WAVE_FINAL_STAGES.includes(stage)) continue;
    throw new FactoryError(
      "refused",
      `${target} is the branch of wave ${id.slice(0, SHORT_ID_CHARS)}, which is ${stage}: only the wave's own tasks reach it; give the work to the wave with waves.add`,
    );
  }
}

/** The wave whose id is `id` or starts with it. */
async function findWave(id: unknown): Promise<WaveFile> {
  const wanted = nonEmpty(id)?.trim();
  if (wanted === undefined) throw new FactoryError("invalid", "the id of a wave must not be empty");
  const waves = await listWaves();
  const exact = waves.find((wave) => wave.declaration.id === wanted);
  if (exact) return exact;
  const matches = waves.filter((wave) => wave.declaration.id.startsWith(wanted));
  if (matches.length === 0) throw new FactoryError("not_found", `no wave has an id starting with "${wanted}"`);
  if (matches.length > 1) throw new FactoryError("invalid", `"${wanted}" matches ${matches.length} waves, give more of the id`);
  return matches[0];
}

/** Runs `act`, a `TaskBusyError` (the wave's log lock stayed taken) as `busy`. */
async function busyAsFactoryError<T>(act: () => Promise<T>): Promise<T> {
  try {
    return await act();
  } catch (error) {
    if (error instanceof TaskBusyError) throw new FactoryError("busy", error.message);
    throw error;
  }
}

/** Pokes the wave's runner (`wave-poke.ts`); a runner that cannot start is `failed`. */
async function pokeWaveRunner(id: string, env?: RunnerEnv): Promise<void> {
  try {
    await pokeWave(id, env);
  } catch (error) {
    throw new FactoryError("failed", `wave ${id.slice(0, SHORT_ID_CHARS)}: its runner did not start (${oneLine(errorText(error))}); a later poke tries again`);
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
 * The views of the wave's started tasks by key. A started task whose record is gone (removed) counts as `cancelled`:
 * it never finishes.
 */
export async function waveTaskViews(fold: WaveFold): Promise<{ states: Map<string, string | null>; views: Map<string, TaskView> }> {
  const records = new Map((await listTasks()).map((record) => [record.id, record]));
  const states = new Map<string, string | null>();
  const views = new Map<string, TaskView>();
  await Promise.all(
    fold.tasks.map(async (task) => {
      if (task.taskId === null) return;
      const record = records.get(task.taskId);
      if (record === undefined) {
        states.set(task.key, "cancelled");
        return;
      }
      const view = await taskView(record, fold.stage);
      views.set(task.key, view);
      states.set(task.key, view.state);
    }),
  );
  return { states, views };
}

function addUsage(sum: WaveView["usage"], usage: WaveView["usage"]): WaveView["usage"] {
  if (usage === null) return sum;
  return { input: (sum?.input ?? 0) + usage.input, output: (sum?.output ?? 0) + usage.output, cost: (sum?.cost ?? 0) + usage.cost };
}

/**
 * A wave as `tasks.wait` judges it: its view, and whether it builds stuck (`stuckKeys`): tasks that can never start
 * while nothing else moves it. A stuck wave rests (its runner does too) and needs attention; it is not interrupted.
 */
type WaveLook = { view: WaveView; stuck: boolean };

/** The wave as clients see it: its fold, its tasks' states and usage, whether its runner lives. */
async function waveView(file: WaveFile): Promise<WaveView> {
  return (await waveLook(file)).view;
}

async function waveLook(file: WaveFile): Promise<WaveLook> {
  const full = foldWave(file.declaration, file.events);
  const { overrides: _overrides, ...fold } = full;
  const { states, views } = await waveTaskViews(full);
  const running = (await liveWaveRunners(fold.id)).length > 0;
  const stuck = fold.stage === "building" && stuckKeys(full, states).length > 0;
  const interrupted = !RESTING_WAVE_STAGES.includes(fold.stage) && !running && !stuck;
  let usage: WaveView["usage"] = null;
  const tasks = fold.tasks.map((task) => {
    const taskUsage = views.get(task.key)?.usage ?? null;
    usage = addUsage(usage, taskUsage);
    return { key: task.key, title: task.title, after: task.after, model: task.model, taskId: task.taskId, sessionId: task.sessionId, state: waveTaskState(task, states), usage: taskUsage };
  });
  for (const review of fold.reviews) usage = addUsage(usage, review.usage);
  // The predicates of the wave actions' own checks, as one list for clients.
  const allowed: Record<WaveActionName, boolean> = {
    "waves.add": !WAVE_ADD_REFUSED.includes(fold.stage),
    "waves.retry": fold.stage === "blocked" || interrupted,
    "waves.approve": fold.stage === "waiting_approve",
    "waves.cancel": !WAVE_FINAL_STAGES.includes(fold.stage),
    // `tasks.remove` of a task maybe only with force, as for the task itself; its done tasks go with the wave.
    "waves.remove": !running && [...views.values()].every(removable),
  };
  const actions = (Object.keys(allowed) as WaveActionName[]).filter((name) => allowed[name]);
  return { view: { ...fold, running, interrupted, tasks, counts: waveCounts(full, states), usage, actions }, stuck };
}

/**
 * What notifications (`notify.ts`) judge for the Pi session `origin`: the views of the tasks it started and of the
 * waves it declared, a wave with whether it builds stuck and its log. Only those records are read.
 */
export async function noticeInputs(origin: string): Promise<{ tasks: TaskView[]; waves: NoticeWave[] }> {
  const records = (await listTasks()).filter((record) => record.origin === origin);
  const files = (await listWaves()).filter((file) => file.declaration.origin === origin);
  const tasks = await Promise.all(records.map((record) => taskView(record)));
  const waves = await Promise.all(files.map(async (file) => ({ ...(await waveLook(file)), events: file.events })));
  return { tasks, waves };
}

/**
 * The scheduler: starts every pending task of the wave whose `after` tasks are all `done`, through `launchTask` with
 * the wave's branch as target, its tag, plan and id, and records a `task` event for each. Only the wave's runner calls
 * it, holding the runner's lock: no task starts twice. A record of this wave no `task` event names (a runner died
 * between the launch and its event) is adopted for the first pending task of its title instead of a second launch.
 * Nothing starts unless the wave is `building`. Resolves with the started keys; a launch that fails throws (`refused`
 * or `failed`) after the tasks started before it are recorded. `signal` (the runner stops): no further launch, the
 * running one is undone (`launchTask`), and it resolves with the keys started before.
 */
export async function startWaveTasks(id: string, env?: RunnerEnv, signal?: AbortSignal): Promise<string[]> {
  const { declaration, events } = await readWave(id);
  const fold = foldWave(declaration, events);
  if (fold.stage !== "building") return [];
  const { states } = await waveTaskViews(fold);
  const { maxRounds, review } = declaration.overrides;
  // The wave's models only (a declaration before `small` existed: over the defaults), the reviewer named, so the
  // repository's stored settings never reach a task the wave starts.
  const { small, big, reviewer } = resolveModels([declaration.overrides.models]);
  // A wave's task always merges into the wave branch by itself; `merge` of the overrides is the wave's.
  const overrides: StoredSettings = { models: { small, big, reviewer }, maxRounds, review, merge: "auto", branch: declaration.branch };
  const named = new Set(fold.tasks.map((task) => task.taskId));
  const orphans = (await listTasks()).filter((record) => record.wave === id && !named.has(record.id));
  const started: string[] = [];
  for (const key of startableKeys(fold, states)) {
    if (signal?.aborted) break;
    const task = fold.tasks.find((candidate) => candidate.key === key);
    if (task === undefined) continue;
    const orphan = orphans.findIndex((record) => record.title === task.title);
    let record: TaskRecord;
    if (orphan >= 0) {
      [record] = orphans.splice(orphan, 1);
    } else {
      try {
        // The task's size picks its coder's model of the wave's; the reviewer's stays the wave's.
        record = await launchTask({ repo: declaration.repo, title: task.title, request: task.request, overrides, size: task.model, tag: declaration.tag, plan: declaration.plan, wave: id, origin: declaration.origin, env, signal });
      } catch (error) {
        if (signal?.aborted) break;
        const why = `starting its task ${key} failed: ${oneLine(errorText(error))}`;
        throw new FactoryError(error instanceof LaunchRefusedError ? "refused" : "failed", why);
      }
    }
    await appendWaveEvent(id, { kind: "task", key, taskId: record.id, sessionId: record.sessionId });
    started.push(key);
  }
  return started;
}

const HANDLERS: Record<ActionName, (params: Params, context: CallContext) => Promise<unknown>> = {
  "models.get": async () => ({ models: await loadModels() }),

  "models.set": async (params) => {
    try {
      await saveModels(params.models as string[]);
    } catch (error) {
      // A file system error (it has a code) is `failed`; a wrong id is the caller's.
      if ((error as NodeJS.ErrnoException).code !== undefined) throw error;
      throw new FactoryError("invalid", `models.set: ${errorText(error)}`);
    }
    return { models: await loadModels() };
  },

  "repos.list": async () => ({ repos: await registeredRepos() }),

  "repos.add": async (params, { cwd }) => {
    const repo = await primaryOf(params.repo as string, cwd);
    if (!(await registeredRepos()).includes(repo)) await saveSettings(repo, {});
    return { repo, repos: await registeredRepos() };
  },

  "repos.remove": async (params, { cwd }) => {
    // A registered path is removed as it is: the repository may be gone from disk.
    const path = repoPath(params.repo as string, cwd);
    const repo = (await registeredRepos()).includes(path) ? path : await primaryOf(path, cwd);
    if (!(await unregisterRepo(repo))) throw new FactoryError("not_found", `${repo} is not registered`);
    return { repos: await registeredRepos() };
  },

  "branches.list": async (params, { cwd }) => {
    const repo = await primaryOf(params.repo as string, cwd);
    const refs = (await git(runCommand, repo, ["for-each-ref", "--format=%(refname)", "refs/heads"])).split("\n").filter((ref) => ref !== "");
    const fallback = await defaultBranch(repo).catch(() => undefined);
    const branches = [];
    for (const ref of refs) {
      const name = ref.slice("refs/heads/".length);
      branches.push({ name, default: name === fallback, hasConfig: await branchHasConfig(repo, name) });
    }
    return { branches };
  },

  "settings.get": async (params, { cwd }) => settingsOf(await primaryOf(params.repo as string, cwd)),

  "settings.set": async (params, { cwd }) => {
    const repo = await primaryOf(params.repo as string, cwd);
    const settings = storedSettingsParam(params.settings, "settings.");
    await requireFactoryModels(settings.models ?? {});
    await saveSettings(repo, settings);
    return settingsOf(repo);
  },

  "config.get": async (params, { cwd }) => {
    const repo = await primaryOf(params.repo as string, cwd);
    const branch = params.branch as string | undefined;
    let text: string | null;
    if (branch !== undefined) {
      if (!(await localBranchExists(repo, branch))) throw new FactoryError("not_found", `${repo} has no local branch ${branch}`);
      text = (await branchHasConfig(repo, branch)) ? await committedText(repo, `refs/heads/${branch}:factory.yaml`) : null;
    } else {
      text = await readFile(join(repo, "factory.yaml"), "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
    }
    if (text !== null) return { exists: true, text, draft: null, source: [] };
    const draft = initDraft(repo);
    return { exists: false, text: null, draft: draft.text, source: draft.source === "" ? [] : draft.source.split(", ") };
  },

  "config.write": async (params, { cwd }) => {
    const repo = await primaryOf(params.repo as string, cwd);
    if (!(await registeredRepos()).includes(repo)) throw new FactoryError("not_found", `${repo} is not registered, add it with repos.add first`);
    const text = params.text as string;
    try {
      parseFactoryYaml(text);
    } catch (error) {
      throw new FactoryError("invalid", errorText(error));
    }
    const path = join(repo, "factory.yaml");
    if (params.overwrite !== true && existsSync(path)) throw new FactoryError("refused", `${path} exists, give overwrite: true to replace it`);
    await writeFile(path, text, "utf8");
    return { path };
  },

  "tasks.list": async (params, { cwd }) => {
    const tag = tagParam("tasks.list", params.tag);
    const repo = params.repo === undefined ? undefined : await primaryOf(params.repo as string, cwd);
    return { tasks: await Promise.all((await tasksIn(repo, tag)).map((record) => taskView(record))) };
  },

  "tasks.wait": async (params, { signal }) => {
    const ids = stringsParam("tasks.wait", "ids", params.ids);
    const tag = tagParam("tasks.wait", params.tag);
    const wave = params.wave as string | undefined;
    if ([ids, tag, wave].filter((given) => given !== undefined).length !== 1) throw new FactoryError("invalid", "tasks.wait needs exactly one of ids, tag and wave");
    const ignore = stringsParam("tasks.wait", "ignore", params.ignore) ?? [];
    const timeoutMs = (params.timeoutMs as number | undefined) ?? WAIT_TIMEOUT_MS.default;
    if (ids !== undefined) {
      // Ids are resolved once: a prefix that turns ambiguous later must not end the wait.
      const records = await Promise.all(ids.map(findTask));
      return waitForTasks(async () => ({ records, waves: [] }), ignore, timeoutMs, signal);
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
    try {
      return taskView(await launchTask({ repo, title, request, overrides, tag, plan, origin: origin ?? null, signal, env }));
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

  "waves.start": async (params, { cwd, env, origin }) => {
    const tag = tagParam("waves.start", params.tag);
    const title = nonEmpty(params.title);
    const request = nonEmpty(params.request);
    if (tag === undefined) throw new FactoryError("invalid", "waves.start needs a tag");
    if (title === undefined) throw new FactoryError("invalid", "waves.start needs a title that is not empty");
    if (request === undefined) throw new FactoryError("invalid", "waves.start needs a request (the reviewer's instructions) that is not empty");
    if (params.plan !== undefined && nonEmpty(params.plan) === undefined) throw new FactoryError("invalid", "waves.start: plan must not be empty");
    const specs = validateTaskSpecs(params.tasks);
    let target: string | undefined;
    let overrides: WaveOverrides;
    try {
      const fields = parseSettingsFields((params.overrides ?? {}) as Params, "overrides.");
      target = fields.branch;
      overrides = parseWaveOverrides(params.overrides ?? {});
    } catch (error) {
      throw new FactoryError("invalid", `waves.start: ${errorText(error)}`);
    }
    const repo = await primaryOf(params.repo as string, cwd);
    if (!(await registeredRepos()).includes(repo)) throw new FactoryError("not_found", `${repo} is not registered, add it with repos.add first`);
    const stored = await loadSettings(repo);
    // Resolved once, here: the wave's tasks, review and merge read only the declaration.
    const { merge, maxRounds, review, models } = resolveSettings(stored, overrides, "");
    overrides = { merge, maxRounds, review, models: modelChoice(models), remote: overrides.remote ?? stored.remote ?? DEFAULT_SETTINGS.remote };
    await requireFactoryModels(wantedModels(models, specs));
    target ??= stored.branch ?? (await defaultBranch(repo).catch(() => undefined));
    if (target === undefined) throw new FactoryError("refused", `${repo} has no default branch (origin/HEAD, main and master do not exist locally)`);
    if (!(await localBranchExists(repo, target))) throw new FactoryError("not_found", `${repo} has no local branch ${target}`);
    if (!(await branchHasConfig(repo, target))) {
      throw new FactoryError("refused", `${repo}: branch ${target} has no factory.yaml (write one with /factory init or the config.write action, and commit it)`);
    }
    const branch = waveBranchName(target, tag);
    if ((await runCommand(["git", "check-ref-format", "--branch", branch], { cwd: repo })).exitCode !== 0) {
      throw new FactoryError("invalid", `waves.start: ${branch} (target and tag) is no valid branch name`);
    }
    if (await localBranchExists(repo, branch)) throw new FactoryError("refused", `${repo}: the wave branch ${branch} exists already (another wave of tag ${tag} on ${target}?)`);
    const base = await git(runCommand, repo, ["rev-parse", "--verify", `refs/heads/${target}^{commit}`]);
    await git(runCommand, repo, ["branch", branch, base]);
    const declaration: WaveDeclaration = {
      id: crypto.randomUUID(),
      repo,
      tag,
      plan: (params.plan as string | undefined) ?? null,
      title,
      request,
      branch,
      target,
      base,
      origin: origin ?? null,
      createdAt: new Date().toISOString(),
      overrides,
    };
    // Declared in full or not at all: a step that fails leaves no branch, no record (and no task a runner started).
    try {
      await createWave(declaration);
      await busyAsFactoryError(() => appendWaveEvent(declaration.id, { kind: "tasks", tasks: specs }));
      await pokeWaveRunner(declaration.id, env);
    } catch (error) {
      await undoWaveStart(declaration).catch(() => undefined);
      throw error;
    }
    return { wave: await waveView(await readWave(declaration.id)) };
  },

  "waves.add": async (params, { env }) => {
    const file = await findWave(params.id);
    const { id } = file.declaration;
    // Task states only move on: pending tasks that can never start now never will (a cancel is final).
    const current = foldWave(file.declaration, file.events);
    const { states } = await waveTaskViews(current);
    // The models list is read before the log lock; the specs are checked again under it. `waves.start` checked the big
    // model; the small one only when an added task is the first to ask for it.
    if (validateTaskSpecs(params.tasks, current.tasks).some((spec) => spec.model === "small")) {
      await requireFactoryModels({ small: resolveModels([file.declaration.overrides.models]).small });
    }
    // Checked and appended under the log lock: a runner's stage change after it loses, never the added tasks.
    await busyAsFactoryError(() =>
      appendWaveEvents(id, (fold) => {
        if (WAVE_ADD_REFUSED.includes(fold.stage)) throw new FactoryError("refused", `wave ${id.slice(0, SHORT_ID_CHARS)} is ${fold.stage}, it takes no more tasks`);
        const tasks = validateTaskSpecs(params.tasks, fold.tasks);
        // The supervisor acts on a wave whose pending tasks can never start: they leave it (count as cancelled).
        const dropped = unreachableKeys(fold, states);
        const events: NewWaveEvent[] = [{ kind: "tasks", tasks, ...(dropped.length > 0 ? { dropped } : {}) }];
        if (fold.stage !== "building") events.push({ kind: "stage", stage: "building", reason: null });
        return events;
      }),
    );
    await pokeWaveRunner(id, env);
    return { wave: await waveView(await readWave(id)) };
  },

  "waves.get": async (params) => ({ wave: await waveView(await findWave(params.id)) }),

  "waves.list": async (params, { cwd }) => {
    const tag = tagParam("waves.list", params.tag);
    const repo = params.repo === undefined ? undefined : await primaryOf(params.repo as string, cwd);
    const files = (await listWaves(repo)).filter((file) => tag === undefined || tagInGroup(file.declaration.tag, tag));
    return { waves: await Promise.all(files.map(waveView)) };
  },

  "waves.timeline": async (params) => {
    const { events } = await findWave(params.id);
    const since = (params.since as number | undefined) ?? 0;
    if (since > events.length) throw new FactoryError("invalid", `since ${since} is past the wave's last event (${events.length})`);
    return { events: events.slice(since), next: events.length };
  },

  "waves.retry": async (params, { env }) => {
    const file = await findWave(params.id);
    const view = await waveView(file);
    const { id } = view;
    if (!view.actions.includes("waves.retry")) throw new FactoryError("refused", `wave ${id.slice(0, SHORT_ID_CHARS)} is ${waveStageText(view)}, retry needs blocked or interrupted`);
    // Blocked with tasks not started or not finished (a launch failed): build again, the runner starts them. Blocked
    // otherwise: review and merge again from the rebase. Interrupted: the runner resumes the stage the log holds.
    if (view.stage === "blocked") {
      const unfinished = view.tasks.some((task) => task.state !== "done" && task.state !== "cancelled");
      await moveWave(id, "blocked", unfinished ? "building" : "reviewing", "retry needs blocked or interrupted");
    }
    await pokeWaveRunner(id, env);
    return { wave: await waveView(await readWave(id)) };
  },

  "waves.approve": async (params, { env }) => {
    const { id } = (await findWave(params.id)).declaration;
    await moveWave(id, "waiting_approve", "merging", "approve needs waiting_approve");
    await pokeWaveRunner(id, env);
    return { wave: await waveView(await readWave(id)) };
  },

  "waves.cancel": async (params, { env }) => {
    const { id } = (await findWave(params.id)).declaration;
    // The stage first: a runner (or a poke from a task's runner) that looks now sees the wave rest and starts nothing.
    await busyAsFactoryError(() =>
      appendWaveEvents(id, (fold) => {
        if (WAVE_FINAL_STAGES.includes(fold.stage)) throw new FactoryError("refused", `wave ${id.slice(0, SHORT_ID_CHARS)} is ${fold.stage} already`);
        return [{ kind: "stage", stage: "cancelled", reason: null }];
      }),
    );
    await stopWaveRunners(id);
    const failures: string[] = [];
    for (const record of await waveRecords(id)) {
      const view = await taskView(record);
      if (view.state !== null && FINAL_STATES.includes(view.state)) continue;
      try {
        await cancelTask(record, env);
      } catch (error) {
        failures.push(`${shortId(record)}: ${oneLine(errorText(error))}`);
      }
    }
    if (failures.length > 0) throw new FactoryError("failed", `wave ${id.slice(0, SHORT_ID_CHARS)} is cancelled, but cancelling its tasks failed (${failures.join("; ")}); cancel them with tasks.cancel`);
    return { wave: await waveView(await readWave(id)) };
  },

  "waves.remove": async (params) => {
    const { declaration } = await findWave(params.id);
    const { id, repo, branch } = declaration;
    const short = id.slice(0, SHORT_ID_CHARS);
    // The runner's lock for the whole removal: no poke starts a runner meanwhile.
    try {
      await lockWave(id);
    } catch (error) {
      if (error instanceof TaskBusyError) throw new FactoryError("refused", `wave ${short} has a runner, cancel it first`);
      throw error;
    }
    try {
      if ((await liveWaveRunners(id)).length > 0) throw new FactoryError("refused", `wave ${short} has a runner, cancel it first`);
      const file = await readWave(id);
      const { stage } = foldWave(file.declaration, file.events);
      const records = await waveRecords(id);
      // Every refusal before anything is deleted.
      for (const record of records) {
        try {
          requireRemovable(await taskView(record));
          await droppedWork(record, params.force === true);
        } catch (error) {
          if (error instanceof FactoryError) throw new FactoryError(error.code, `wave ${short}: ${error.message}`, error.detail);
          throw error;
        }
      }
      // A review worktree a block left behind: removed with the wave, unless it holds somebody's work (without force).
      const review = waveReviewWorktree(declaration);
      const hasReview = existsSync(review);
      if (hasReview && params.force !== true && (await uncommittedFiles(runCommand, review))) {
        throw new FactoryError("refused", `wave ${short}: its review worktree ${review} holds uncommitted changes, commit or remove them there, or give force: true to remove it anyway`, {
          force: true,
        });
      }
      for (const record of records) {
        await withTaskLock(
          record,
          async (view) => requireRemovable(view),
          async () => {
            await droppedWork(record, params.force === true);
            await deleteTask(record);
          },
        );
      }
      // Before the branch: `git branch -D` refuses a branch a worktree has checked out.
      if (hasReview) {
        const removed = await runCommand(["git", "worktree", "remove", ...(params.force === true ? ["--force"] : []), review], { cwd: repo });
        if (removed.exitCode !== 0) throw new FactoryError("failed", `wave ${short}: removing its review worktree ${review} failed: ${oneLine(removed.output)}`);
      }
      // Only a merged wave's branch: the target has all of it. Any other branch may hold work nobody merged.
      if (stage === "merged" && (await localBranchExists(repo, branch))) {
        const deleted = await runCommand(["git", "branch", "-D", branch], { cwd: repo });
        if (deleted.exitCode !== 0) throw new FactoryError("failed", `wave ${short}: deleting its branch ${branch} failed: ${oneLine(deleted.output)}`);
      }
      await removeWave(id);
      return { removed: id };
    } finally {
      await unlockWave(id).catch(() => undefined);
    }
  },
};

/** The wave's stage, `interrupted (<stage> ...)` when no runner drives it. */
function waveStageText(view: WaveView): string {
  return view.interrupted ? `interrupted (${view.stage}, no runner)` : view.stage;
}

/** Appends the stage `to` when the wave is at `from` (compare-and-append), else `refused` naming `what`. */
async function moveWave(id: string, from: WaveStage, to: WaveStage, what: string): Promise<void> {
  await busyAsFactoryError(() =>
    appendWaveEvents(id, (fold) => {
      if (fold.stage !== from) throw new FactoryError("refused", `wave ${id.slice(0, SHORT_ID_CHARS)} is ${fold.stage}, ${what}`);
      return [{ kind: "stage", stage: to, reason: null }];
    }),
  );
}

/** The records of the wave's tasks (those it started and that were not removed). */
async function waveRecords(id: string): Promise<TaskRecord[]> {
  return (await listTasks()).filter((record) => record.wave === id);
}

/** Undoes a `waves.start` that failed midway: its runner, any task it started, its record and its branch. */
async function undoWaveStart(declaration: WaveDeclaration): Promise<void> {
  await stopWaveRunners(declaration.id).catch(() => undefined);
  for (const record of await waveRecords(declaration.id)) await deleteTask(record).catch(() => undefined);
  await removeWave(declaration.id);
  await runCommand(["git", "branch", "-D", declaration.branch], { cwd: declaration.repo });
}

/** One sentence: a multi-line error (git output) on one line. */
export function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

/** Runs the action `name` with `params` (`CallOptions`). Resolves with plain JSON, rejects with a `FactoryError`. */
export async function callAction(name: string, params: unknown, options: CallOptions = {}): Promise<unknown> {
  const { cwd, signal, env, origin } = options;
  if (!isActionName(name)) throw new FactoryError("invalid", `unknown action "${name}"`);
  const checked = checkParams(name, params, cwd);
  try {
    return await HANDLERS[name](checked, { cwd, signal, env, origin });
  } catch (error) {
    if (error instanceof FactoryError) throw error;
    if (error instanceof TaskBusyError) throw new FactoryError("busy", error.message);
    throw new FactoryError("failed", oneLine(errorText(error)));
  }
}
