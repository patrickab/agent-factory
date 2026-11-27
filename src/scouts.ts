/**
 * Scouts: read-only explorers of a caller's working directory that write the map (memory-store `map/`) and report.
 * - A scout is a directory `scouts/<caller key>/<id>/` under the factory home; grouping by caller (a task, a wave or a
 *   session) keeps a task's cost sum to its own scouts' files
 * - Its state is the first final `state` event, else the last one: a runner's late `done` never undoes a cancel. Its
 *   usage is the last `usage` event, killed or not
 * - Imports only Bun, `node:` and plain plugin modules
 */
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { factoryHome } from "./settings.ts";
import { onPath, signalRunner, spawnDetached, type RunnerEnv } from "./spawn.ts";
import { runnerAlive } from "./tasks.ts";
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

export type ScoutEvent =
  | { at: string; kind: "state"; state: ScoutState; error?: string }
  | { at: string; kind: "runner"; pid: number }
  | { at: string; kind: "usage"; usage: Usage };

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
  pid: number | null;
  usage: Usage | null;
}

/** The scout's state, its runner's pid and its usage from its events (unknown keys and torn lines dropped). */
export function foldScout(events: Record<string, unknown>[]): ScoutFold {
  const fold: ScoutFold = { state: "queued", error: null, pid: null, usage: null };
  let final = false;
  for (const event of events) {
    if (event.kind === "state" && !final && typeof event.state === "string") {
      fold.state = event.state as ScoutState;
      fold.error = typeof event.error === "string" ? event.error : null;
      final = FINAL_SCOUT_STATES.includes(fold.state);
    }
    if (event.kind === "runner" && typeof event.pid === "number") fold.pid = event.pid;
    if (event.kind === "usage") fold.usage = event.usage as Usage;
  }
  return fold;
}

export async function readScout(dir: string): Promise<{ declaration: ScoutDeclaration; fold: ScoutFold }> {
  const declaration = JSON.parse(await readFile(join(dir, "scout.json"), "utf8")) as ScoutDeclaration;
  const events = await readJsonl(join(dir, "events.jsonl"));
  return { declaration, fold: foldScout(events) };
}

/** How often the starter looks whether the spawned runner exec'd. */
const EXEC_POLL_MS = 25;

/** Whether process `pid` exists and is not a zombie. */
async function processExists(pid: number): Promise<boolean> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
  // `<pid> (<comm>) <state> …`: the state follows the last `)`.
  return stat !== "" && stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
}

/** The paths `written.jsonl` names, in order, each once. */
async function writtenPaths(dir: string): Promise<string[]> {
  const paths = (await readJsonl(join(dir, "written.jsonl"))).flatMap((line) => (typeof line.path === "string" ? [line.path] : []));
  return [...new Set(paths)];
}

/** The scout's view; `usage.cost` in cents. */
export async function scoutView(dir: string): Promise<ScoutView> {
  const { declaration, fold } = await readScout(dir);
  const { cwd: _cwd, ...rest } = declaration;
  const running = await runnerAlive(fold.pid, dir);
  const final = FINAL_SCOUT_STATES.includes(fold.state);
  const reportPath = join(dir, "report.md");
  const report = fold.state === "done" ? await readFile(reportPath, "utf8").catch(() => null) : null;
  return {
    ...rest,
    state: fold.state,
    error: fold.error,
    running,
    // Before the starter recorded the runner's pid the scout is still starting, not interrupted.
    interrupted: !final && fold.pid !== null && !running,
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

/** How many of `caller`'s scouts run now: state `running` with a live runner. */
export async function runningScouts(caller: ScoutCaller): Promise<number> {
  let count = 0;
  for (const dir of await scoutDirs(caller)) {
    const scout = await readScout(dir).catch(() => undefined);
    if (scout?.fold.state === "running" && (scout.fold.pid === null || (await runnerAlive(scout.fold.pid, dir)))) count += 1;
  }
  return count;
}

const STOP_WAIT_MS = 5_000;

async function stopScoutRunner(dir: string, pid: number | null): Promise<void> {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (!(await runnerAlive(pid, dir))) return;
    signalRunner(pid as number, signal);
    const deadline = Date.now() + STOP_WAIT_MS;
    while (Date.now() < deadline && (await runnerAlive(pid, dir))) await Bun.sleep(50);
  }
}

/** Cancels the scout in `dir` unless it ended: the `cancelled` event, then its runner (and the child) stopped. */
export async function cancelScout(dir: string): Promise<void> {
  const { fold } = await readScout(dir);
  if (FINAL_SCOUT_STATES.includes(fold.state)) return;
  await appendScoutEvent(dir, { kind: "state", state: "cancelled" });
  await stopScoutRunner(dir, fold.pid);
}

/** Cancels every scout of `caller` that has not ended (a cancelled task or wave). */
export async function cancelScouts(caller: ScoutCaller): Promise<void> {
  for (const dir of await scoutDirs(caller)) await cancelScout(dir).catch(() => undefined);
}

/** How long the starter waits for the spawned runner to exec (its command line to name the scout's directory). */
const EXEC_WAIT_MS = 30_000;

/**
 * Whether the spawned `pid` became the runner of `dir` (its command line names `dir`): false once the process is gone
 * or after `EXEC_WAIT_MS`. A pid recorded before its exec is the spawner's fork, which a waiter under load would take
 * for an interrupted scout.
 */
async function execed(pid: number, dir: string): Promise<boolean> {
  const deadline = Date.now() + EXEC_WAIT_MS;
  while (!(await runnerAlive(pid, dir))) {
    if (!(await processExists(pid)) || Date.now() >= deadline) return false;
    await Bun.sleep(EXEC_POLL_MS);
  }
  return true;
}

/**
 * Writes the scout's record (`queued`) and spawns its runner detached; resolves with its directory. The runner's pid
 * is recorded once it exec'd (`execed`): until then the scout counts as starting, never as interrupted.
 */
export async function startScout(declaration: ScoutDeclaration, env: RunnerEnv = process.env): Promise<string> {
  const bun = onPath("bun");
  if (bun === null) throw new Error("bun is not on PATH: the scout's runner needs it");
  const dir = scoutDir(declaration.caller, declaration.id);
  await writeScoutDeclaration(dir, declaration);
  await appendScoutEvent(dir, { kind: "state", state: "queued" });
  const runnerEnv: RunnerEnv = { ...env, [SCOUT_ID_ENV]: declaration.id };
  for (const key of ["FACTORY_TASK_SESSION", "FACTORY_TASK_LOCK", "FACTORY_TASK_WAVE"]) delete runnerEnv[key];
  const pid = await spawnDetached([bun, SCOUT_RUNNER_PATH, dir], runnerEnv, join(dir, "runner.log"), import.meta.dirname);
  if (pid === undefined) {
    await appendScoutEvent(dir, { kind: "state", state: "failed", error: "its runner did not start" });
    throw new Error("the scout's runner did not start");
  }
  // A runner that ended before its exec was seen (fast, or it failed) still gets its pid: its own events tell the rest.
  await execed(pid, dir);
  await appendScoutEvent(dir, { kind: "runner", pid });
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
