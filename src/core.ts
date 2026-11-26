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
 * - The actions come from the features (`features.ts`): each registers its specs, handlers and views (`feature.ts`)
 * - Cut by area, this module keeps `ACTIONS`, the params check and `callAction`, and re-exports what clients import:
 *   `core-shared.ts` (`FactoryError`, the params' helpers), `core-settings.ts` (models, repos, branches, settings,
 *   config), `core-tasks.ts` (`tasks.*`, `TaskView`), `core-wait.ts` (`tasks.wait`), `core-waves.ts` (`waves.*`,
 *   `WaveView`, what the wave's runner asks)
 */
import { FactoryError, oneLine, type Handler, type Params } from "./core-shared.ts";
import type { ActionSpec, Feature } from "./feature.ts";
import { FEATURES } from "./features.ts";
import { TaskBusyError } from "./tasks.ts";
import { errorText, isRecord } from "./util.ts";

export { FactoryError, oneLine, type FactoryErrorCode, type FactoryErrorDetail } from "./core-shared.ts";
export type { ActionSpec } from "./feature.ts";
export type { TaskActionName, TaskView, TimelineEntry, TimelineKind } from "./core-tasks.ts";
export { noticeInputs, pokeQueuedAfter, queueLook, startQueuedWave, startWaveTasks, taskWave, waveBranchName, waveMergeRefusal, waveReviewsEach, waveReviewWorktree, waveTaskViews, type WaveActionName } from "./core-waves.ts";

/** Every feature's actions (`features.ts`), in the features' order. Two features naming one action fail on load. */
export const ACTIONS = Object.freeze(
  FEATURES.reduce<Record<string, ActionSpec>>((actions, feature) => {
    for (const [name, spec] of Object.entries(feature.actions)) {
      if (Object.hasOwn(actions, name)) throw new Error(`two features register the action ${name}`);
      actions[name] = spec;
    }
    return actions;
  }, {}),
) as Readonly<Record<ActionName, ActionSpec>>;

/** The name of an action of a feature in `FEATURES`. */
export type ActionName = (typeof FEATURES)[number] extends infer F ? (F extends Feature<infer A> ? A : never) : never;

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
 * Every action's handler, from the features. Assembled on the first call, not on load: a handler module may import a
 * module that imports this one, and may not have finished when this one runs.
 */
function handlersByName(): Record<ActionName, Handler> {
  handlers ??= Object.assign({}, ...FEATURES.map((feature) => feature.handlers)) as Record<ActionName, Handler>;
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
