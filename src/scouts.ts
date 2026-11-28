/**
 * Scouts: read-only explorers of a caller's working directory that write the map (memory-store `map/`) and report.
 * - A scout is a directory `scouts/<caller key>/<id>/` under the factory home; grouping by caller (a task, a wave or a
 *   session) keeps a task's cost sum to its own scouts' files
 * - Its state is the first final `state` event, else the last one: a runner's late `done` never undoes a cancel. Its
 *   usage is the last `usage` event, killed or not
 * - Its runner holds the pid lock `<dir>/lock` (`lock.ts`); the starter holds it before the declaration exists, so a
 *   scout without a live holder of its lock is not starting
 * - Imports only Bun, `node:` and plain plugin modules
 */
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lockFile, lockHeld, lockRunner, startRunner, unlockFile } from "./lock.ts";
import { factoryHome } from "./settings.ts";
import { stopProcesses, type RunnerEnv } from "./spawn.ts";
import { messageText } from "./state.ts";
import { addUsage, cents, ifMissing, isRecord, NO_USAGE, piUsage, readJsonl, type Usage } from "./util.ts";

export const SCOUT_LIMIT = 4;
// `import.meta.dirname`, not Bun's `import.meta.dir`: inside Pi the latter is not this directory.
export const SCOUT_RUNNER_PATH = join(import.meta.dirname, "scout-runner.ts");
export const SCOUT_EXTENSION_PATH = join(import.meta.dirname, "pi", "scout-map-write.ts");
/** Set on a scout's runner and child: a scout starts no scout. */
export const SCOUT_ID_ENV = "FACTORY_SCOUT_ID";

export type ScoutCallerKind = "task" | "wave" | "session";
/** `id`: the task's, the wave's, or the session's (null for a caller without one: the CLI). */
export type ScoutCaller = { kind: ScoutCallerKind; id: string | null };
export type ScoutState = "queued" | "running" | "done" | "failed" | "cancelled";

export const FINAL_SCOUT_STATES: readonly ScoutState[] = ["done", "failed", "cancelled"];

export interface ScoutDeclaration {
  id: string;
  caller: ScoutCaller;
  /** The primary checkout of `cwd`. */
  repo: string;
  /** Where the scout explores: the caller's working directory. */
  cwd: string;
  concern: string;
  questions: string[];
  /** The memory-store the scout reads and writes `map/` of. */
  store: string;
  /** `HEAD` of `cwd` when the scout started: the stamp of its facts. */
  commit: string;
  /** `provider/model`, null for Pi's default. */
  model: string | null;
  createdAt: string;
}

export type ScoutEvent = { at: string; kind: "state"; state: ScoutState; error?: string } | { at: string; kind: "usage"; usage: Usage };

/** A scout as clients see it. `running`: its runner lives. `interrupted`: not final, its runner gone. */
export interface ScoutView extends Omit<ScoutDeclaration, "cwd"> {
  state: ScoutState;
  error: string | null;
  running: boolean;
  interrupted: boolean;
  usage: Usage | null;
  /** The report, null before the scout is done. */
  report: string | null;
  reportPath: string | null;
  /** The map paths it wrote so far, in order, each once. */
  written: string[];
}

export function scoutsDir(): string {
  return join(factoryHome(), "scouts");
}

/** The caller's directory name: `<kind>-<id URI-encoded>` (`none` for a session without id). */
export function callerKey(caller: ScoutCaller): string {
  return `${caller.kind}-${encodeURIComponent(caller.id ?? "none")}`;
}

export function scoutDir(caller: ScoutCaller, id: string): string {
  return join(scoutsDir(), callerKey(caller), id);
}

/** The scout runner's pid lock. */
export function scoutLockPath(dir: string): string {
  return join(dir, "lock");
}

async function listNames(dir: string): Promise<string[]> {
  return (await ifMissing(readdir(dir), [])).sort();
}

export async function scoutDirs(caller?: ScoutCaller): Promise<string[]> {
  const keys = caller === undefined ? await listNames(scoutsDir()) : [callerKey(caller)];
  const dirs: string[] = [];
  for (const key of keys) {
    for (const name of await listNames(join(scoutsDir(), key))) if (!name.includes(".")) dirs.push(join(scoutsDir(), key, name));
  }
  return dirs;
}

export async function writeScoutDeclaration(dir: string, declaration: ScoutDeclaration): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "scout.json"), `${JSON.stringify(declaration)}\n`, { flag: "wx" });
}

/** An event before its time is set. */
export type NewScoutEvent = ScoutEvent extends infer E ? (E extends ScoutEvent ? Omit<E, "at"> : never) : never;

export async function appendScoutEvent(dir: string, event: NewScoutEvent): Promise<void> {
  await appendFile(join(dir, "events.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

export interface ScoutFold {
  state: ScoutState;
  error: string | null;
  usage: Usage | null;
}

/** The scout's state and its usage from its events (unknown keys and torn lines dropped). */
export function foldScout(events: Record<string, unknown>[]): ScoutFold {
  const fold: ScoutFold = { state: "queued", error: null, usage: null };
  let final = false;
  for (const event of events) {
    if (event.kind === "state" && !final && typeof event.state === "string") {
      fold.state = event.state as ScoutState;
      fold.error = typeof event.error === "string" ? event.error : null;
      final = FINAL_SCOUT_STATES.includes(fold.state);
    }
    if (event.kind === "usage") fold.usage = event.usage as Usage;
  }
  return fold;
}

export async function readScout(dir: string): Promise<{ declaration: ScoutDeclaration; fold: ScoutFold }> {
  const declaration = JSON.parse(await readFile(join(dir, "scout.json"), "utf8")) as ScoutDeclaration;
  const events = await readJsonl(join(dir, "events.jsonl"));
  return { declaration, fold: foldScout(events) };
}

/** The paths `written.jsonl` names, in order, each once. */
async function writtenPaths(dir: string): Promise<string[]> {
  const paths = (await readJsonl(join(dir, "written.jsonl"))).flatMap((line) => (typeof line.path === "string" ? [line.path] : []));
  return [...new Set(paths)];
}

/** The scout's view; `usage.cost` in cents. Its lock is read before its events: a runner records its end before it exits. */
export async function scoutView(dir: string): Promise<ScoutView> {
  const running = await lockHeld(scoutLockPath(dir));
  const { declaration, fold } = await readScout(dir);
  const { cwd: _cwd, ...rest } = declaration;
  const reportPath = join(dir, "report.md");
  const report = fold.state === "done" ? await readFile(reportPath, "utf8").catch(() => null) : null;
  return {
    ...rest,
    state: fold.state,
    error: fold.error,
    running,
    interrupted: !FINAL_SCOUT_STATES.includes(fold.state) && !running,
    usage: fold.usage === null ? null : { ...fold.usage, cost: cents(fold.usage.cost) },
    report,
    reportPath: report === null ? null : reportPath,
    written: await writtenPaths(dir),
  };
}

/** The unrounded usage of all of `caller`'s scouts (cancelled and killed ones too), null without one. */
export async function scoutUsage(caller: ScoutCaller): Promise<Usage | null> {
  let sum: Usage | null = null;
  for (const dir of await scoutDirs(caller)) {
    const usage = await readScout(dir).then(
      ({ fold }) => fold.usage,
      () => null,
    );
    sum = addUsage(sum, usage);
  }
  return sum;
}

/** How many of `caller`'s scouts run now: state `running` with a live holder of the lock. */
export async function runningScouts(caller: ScoutCaller): Promise<number> {
  let count = 0;
  for (const dir of await scoutDirs(caller)) {
    const scout = await readScout(dir).catch(() => undefined);
    if (scout?.fold.state === "running" && (await lockHeld(scoutLockPath(dir)))) count += 1;
  }
  return count;
}

/** Cancels the scout in `dir` unless it ended: the `cancelled` event, then its runner (and the child) stopped. */
export async function cancelScout(dir: string): Promise<void> {
  const { fold } = await readScout(dir);
  if (FINAL_SCOUT_STATES.includes(fold.state)) return;
  await appendScoutEvent(dir, { kind: "state", state: "cancelled" });
  await stopProcesses(async () => {
    const pid = await lockRunner(scoutLockPath(dir), dir);
    return pid === null ? [] : [pid];
  }, `the runner of scout ${dir}`);
}

/** Cancels every scout of `caller` that has not ended (a cancelled task or wave). */
export async function cancelScouts(caller: ScoutCaller): Promise<void> {
  for (const dir of await scoutDirs(caller)) await cancelScout(dir).catch(() => undefined);
}

/** Writes the scout's record (`queued`) under its lock and starts its runner (`startRunner`); resolves with its directory. */
export async function startScout(declaration: ScoutDeclaration, env: RunnerEnv = process.env): Promise<string> {
  const dir = scoutDir(declaration.caller, declaration.id);
  await lockFile(scoutLockPath(dir), `scout ${declaration.id.slice(0, 8)} is busy`);
  await writeScoutDeclaration(dir, declaration).then(() => appendScoutEvent(dir, { kind: "state", state: "queued" })).catch(async (error: unknown) => {
    await unlockFile(scoutLockPath(dir));
    throw error;
  });
  await startRunner({ lock: scoutLockPath(dir), argv: [SCOUT_RUNNER_PATH, dir], env: { ...env, [SCOUT_ID_ENV]: declaration.id }, log: join(dir, "runner.log"), cwd: import.meta.dirname }).catch(
    async (error: unknown) => {
      await appendScoutEvent(dir, { kind: "state", state: "failed", error: "its runner did not start" });
      throw error;
    },
  );
  return dir;
}

/** The report of the child's `--mode json` stdout lines: the running usage totals and the last assistant text. */
export class ScoutOutput {
  usage = NO_USAGE;
  lastText = "";

  /** Reads one stdout line; true when it changed the usage. */
  line(line: string): boolean {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return false;
    }
    if (!isRecord(event) || event.type !== "message_end" || !isRecord(event.message) || event.message.role !== "assistant") return false;
    const text = messageText(event.message).trim();
    if (text !== "") this.lastText = text;
    const usage = piUsage(event.message.usage);
    this.usage = addUsage(this.usage, usage);
    return usage !== null;
  }
}
