/**
 * The factory core, the one module clients import: `ACTIONS` and `callAction`, plain JSON in and out. The actions
 * come from the features (`features.ts`); this module checks the params and runs the handler.
 * - Runners an action starts get the caller's `env` (default `process.env`): the host passes one without its secrets
 * - Imports only Bun, `node:` modules and plugin modules that do the same: the deployed plugin has no `node_modules`
 */
import { oneLine, type Handler, type Params } from "./core-shared.ts";
import type { ActionSpec, Feature } from "./feature.ts";
import { FEATURES } from "./features.ts";
import { errorText, FactoryError, isRecord } from "./util.ts";

export { oneLine } from "./core-shared.ts";
export { FactoryError, type FactoryErrorCode, type FactoryErrorDetail } from "./util.ts";
export type { ActionSpec } from "./feature.ts";
export type { TaskActionName, TaskView, TimelineEntry, TimelineKind } from "./core-tasks.ts";
export { noticeInputs, pokeQueuedAfter, startQueuedWave, sessionWave, startWaveTasks, waveBranchName, waveReviewWorktree, waveTaskViews, type WaveActionName } from "./core-waves.ts";

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

/** The params checked against the action's schema: top-level keys, an `enum`, an array's item type; unknown keys dropped. */
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
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) throw new FactoryError("invalid", `${name}: ${key} must be one of ${schema.enum.join(", ")}`);
    const items = isRecord(schema.items) ? String(schema.items.type) : undefined;
    if (items !== undefined && !(value as unknown[]).every(TYPE_CHECKS[items])) throw new FactoryError("invalid", `${name}: ${key} must hold ${items}s`);
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
    throw new FactoryError("failed", oneLine(errorText(error)));
  }
}
