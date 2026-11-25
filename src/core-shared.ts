/**
 * What every area of the core (`core.ts`) shares: the error clients see, the context a handler runs in, and the
 * helpers of the params (ids, repositories, tags).
 *
 * - `FactoryError`: one sentence with a code (`core.ts` names them); `oneLine` makes git's output one
 * - A `repo` param is a path inside the repository, relative to the caller's `cwd`; `primaryOf` is its primary checkout
 * - A `Handler` is one action's body: the checked params and the caller's context, resolving with plain JSON
 * - Imports no area module (only their types): every area module and `waves.ts` may import it
 */
import { isAbsolute, resolve } from "node:path";
import type { ActionName } from "./core.ts";
import { primaryCheckout } from "./git.ts";
import type { RunnerEnv } from "./launch.ts";
import { runCommand } from "./run.ts";
import { isTaskTag, type TaskRecord } from "./tasks.ts";

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

export const SHORT_ID_CHARS = 8;

export const WAIT_TIMEOUT_MS = { default: 600_000, minimum: 1_000, maximum: 3_600_000 };

export type Params = Record<string, unknown>;

export interface CallContext {
  cwd: string | undefined;
  signal: AbortSignal | undefined;
  env: RunnerEnv | undefined;
  origin: string | undefined;
}

export function shortId(record: TaskRecord): string {
  return record.id.slice(0, SHORT_ID_CHARS);
}

export function nonEmpty(value: unknown): string | undefined {
  return typeof value !== "string" || value.trim() === "" ? undefined : value;
}

/** `repo` resolved against `cwd`; a relative one without `cwd` is `invalid`. */
export function repoPath(repo: string, cwd: string | undefined): string {
  if (isAbsolute(repo)) return repo;
  if (cwd === undefined) throw new FactoryError("invalid", `repo ${repo} must be an absolute path (the call has no cwd)`);
  return resolve(cwd, repo);
}

/** The primary checkout of the repository `repo` is in. */
export async function primaryOf(repo: string, cwd: string | undefined): Promise<string> {
  const path = repoPath(repo, cwd);
  try {
    return (await primaryCheckout(runCommand, path)).primary;
  } catch {
    throw new FactoryError("not_found", `${path} is not inside a git repository`);
  }
}

/** A tag param, `invalid` unless it is segments joined by `/` (`isTaskTag`). */
export function tagParam(name: ActionName, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isTaskTag(value)) throw new FactoryError("invalid", `${name}: tag ${JSON.stringify(value)} is not segments of A-Z a-z 0-9 . _ @ + - joined by /`);
  return value;
}

/** An array param of non-empty strings, `invalid` otherwise. */
export function stringsParam(name: ActionName, key: string, value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const strings = value as unknown[];
  if (strings.some((item) => nonEmpty(item) === undefined)) throw new FactoryError("invalid", `${name}: ${key} must hold non-empty strings`);
  return (strings as string[]).map((item) => item.trim());
}

/** One sentence: a multi-line error (git output) on one line. */
export function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

/** One action's body (`core.ts` maps every action to one): the checked params, the caller's context. */
export type Handler = (params: Params, context: CallContext) => Promise<unknown>;
