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
 * - Cut by area, this module keeps `ACTIONS`, the params check and `callAction`, and re-exports what clients import:
 *   `core-shared.ts` (`FactoryError`, the params' helpers), `core-settings.ts` (models, repos, branches, settings,
 *   config), `core-tasks.ts` (`tasks.*`, `TaskView`), `core-wait.ts` (`tasks.wait`), `core-waves.ts` (`waves.*`,
 *   `WaveView`, what the wave's runner asks)
 */
import { FactoryError, oneLine, WAIT_TIMEOUT_MS, type Handler, type Params } from "./core-shared.ts";
import { SETTINGS_HANDLERS } from "./core-settings.ts";
import { TASK_HANDLERS } from "./core-tasks.ts";
import { WAIT_HANDLERS } from "./core-wait.ts";
import { WAVE_HANDLERS } from "./core-waves.ts";
import { TaskBusyError } from "./tasks.ts";
import { errorText, isRecord } from "./util.ts";

export { FactoryError, oneLine, type FactoryErrorCode, type FactoryErrorDetail } from "./core-shared.ts";
export type { TaskActionName, TaskView, TimelineEntry, TimelineKind } from "./core-tasks.ts";
export { noticeInputs, startWaveTasks, taskWave, waveBranchName, waveMergeRefusal, waveReviewWorktree, waveTaskViews, type WaveActionName } from "./core-waves.ts";

type Schema = Record<string, unknown>;

export interface ActionSpec {
  summary: string;
  params: { type: "object"; required: string[]; properties: Record<string, Schema> };
  mutates: boolean;
  /** For the host only: never offered to an agent. */
  hostOnly: boolean;
}

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
    model: { type: "string", enum: ["small", "big"], description: "Which of the wave's two models this task's coder runs with: small for easy tasks; default big" },
  },
};
const TAG: Schema = { type: "string", description: "A task tag: segments of A-Z a-z 0-9 . _ @ + - joined by /" };
const TAG_FILTER: Schema = { type: "string", description: "Only the tasks whose tag is this one or lies under it (a holds a/b, not ab)" };
const SETTINGS_PROPERTIES: Record<string, Schema> = {
  merge: { type: "string", enum: ["auto", "review"], description: "auto: merge a passed round. review: wait for approve" },
  maxRounds: { type: "integer", minimum: 1, maximum: 20 },
  review: { type: "boolean", description: "Run the reviewer on every round" },
  branch: { type: "string", description: "The branch the task starts from and merges into" },
  models: {
    type: "object",
    properties: {
      coder: { type: "string", description: "provider/model; absent: Pi's session model" },
      big: { type: "string", description: "provider/model; the same as coder (either name sets both)" },
      small: { type: "string", description: "provider/model for a wave's easy tasks (model small)" },
      reviewer: { type: "string", description: "provider/model; absent: Pi's session model" },
    },
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
          "The wave's tasks: key unique in the wave (A-Z a-z 0-9 . _ -), title, request (full and self-contained for the coder), after: keys this task waits for, model: \"small\" or \"big\", which of the wave's models this task's coder runs with (default big; the reviewer's stays the wave's)",
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
      tasks: { type: "array", description: "Tasks as for waves.start: key, title, request, after?, model? (\"small\" or \"big\", default big)", items: WAVE_TASK_ITEM },
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

let handlers: Record<ActionName, Handler> | undefined;

/**
 * Every action's handler, from the area modules. Assembled on the first call, not on load: `waves.ts` imports this
 * module, so an area module loaded first may not have finished when this one runs.
 */
function handlersByName(): Record<ActionName, Handler> {
  handlers ??= { ...SETTINGS_HANDLERS, ...TASK_HANDLERS, ...WAIT_HANDLERS, ...WAVE_HANDLERS };
  return handlers;
}

/** Runs the action `name` with `params` (`CallOptions`). Resolves with plain JSON, rejects with a `FactoryError`. */
export async function callAction(name: string, params: unknown, options: CallOptions = {}): Promise<unknown> {
  const { cwd, signal, env, origin } = options;
  if (!isActionName(name)) throw new FactoryError("invalid", `unknown action "${name}"`);
  const checked = checkParams(name, params, cwd);
  try {
    return await handlersByName()[name](checked, { cwd, signal, env, origin });
  } catch (error) {
    if (error instanceof FactoryError) throw error;
    if (error instanceof TaskBusyError) throw new FactoryError("busy", error.message);
    throw new FactoryError("failed", oneLine(errorText(error)));
  }
}
