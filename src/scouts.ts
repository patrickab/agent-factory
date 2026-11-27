/**
 * Scouts: read-only explorers of a caller's working directory that write the map (memory-store `map/`) and report.
 *
 * - A scout's record is a directory of its own, `scouts/<caller key>/<id>/` under the factory home: `scout.json` (the
 *   declaration: caller, concern, questions, store, commit, model), `events.jsonl` (append-only: `state`, `runner`
 *   with its pid, `usage` with the running totals), `report.md`, `written.jsonl` (the `map_write` calls,
 *   `scout-map.ts`), `prompt.md`, `runner.log` and `session/` (the child's Pi session)
 * - The caller is a task (a coder in its worktree), a wave (its reviewer in the review worktree) or a session (a
 *   supervisor, `origin`); grouping by caller keeps a task's cost sum to its own scouts' files
 * - A scout's state is the first final `state` event (`done`, `failed`, `cancelled`), else the last one (`queued`,
 *   `running`): a runner's late `done` never undoes a cancel. Its usage is the last `usage` event, killed or not
 * - `startScout` writes the record and spawns `scout-runner.ts` detached (`spawn.ts`); the runner queues while four
 *   scouts of the caller run (`SCOUT_LIMIT`). `cancelScouts` cancels a caller's scouts: event first, then the signal
 * - Imports only Bun, `node:` and plain plugin modules
 */
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { factoryHome } from "./settings.ts";
import { onPath, ownRunner, signalRunner, spawnDetached, type RunnerEnv } from "./spawn.ts";
import { messageText } from "./state.ts";
import { cents, ifMissing, isRecord, readJsonl } from "./util.ts";

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
export type ScoutUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };

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
  | { at: string; kind: "usage"; usage: ScoutUsage };

/** A scout as clients see it. `running`: its runner lives. `interrupted`: not final, its runner gone. */
export interface ScoutView extends Omit<ScoutDeclaration, "cwd"> {
  state: ScoutState;
  error: string | null;
  running: boolean;
  interrupted: boolean;
  usage: ScoutUsage | null;
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

/** The scout directories of `caller`, or of every caller. */
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

function numberOr0(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseUsage(value: unknown): ScoutUsage | null {
  if (!isRecord(value)) return null;
  return { input: numberOr0(value.input), output: numberOr0(value.output), cacheRead: numberOr0(value.cacheRead), cacheWrite: numberOr0(value.cacheWrite), cost: numberOr0(value.cost) };
}

export interface ScoutFold {
  state: ScoutState;
  error: string | null;
  pid: number | null;
  usage: ScoutUsage | null;
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
    if (event.kind === "usage") fold.usage = parseUsage(event.usage) ?? fold.usage;
  }
  return fold;
}

export async function readScout(dir: string): Promise<{ declaration: ScoutDeclaration; fold: ScoutFold }> {
  const declaration = JSON.parse(await readFile(join(dir, "scout.json"), "utf8")) as ScoutDeclaration;
  const events = await readJsonl(join(dir, "events.jsonl"));
  return { declaration, fold: foldScout(events) };
}

/** How often a process that is not (yet) readable as the scout's runner is looked at again, and how long between. */
const ALIVE_RETRIES = 10;
const ALIVE_RETRY_MS = 25;

/** Whether process `pid` exists and is not a zombie. */
async function processExists(pid: number): Promise<boolean> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
  // `<pid> (<comm>) <state> …`: the state follows the last `)`.
  return stat !== "" && stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
}

/**
 * Whether `pid` is the live runner of the scout in `dir` (its command line names the directory, invariant 16's marker).
 * The spawn's pid may name the spawner's fork before its `execve` (its command line the spawner's, or empty mid-exec;
 * longer under load): while the process exists it is looked at again for a moment before it counts as no runner, so a
 * waiter does not take a starting scout for an interrupted one.
 */
export async function scoutRunnerAlive(pid: number | null, dir: string): Promise<boolean> {
  if (pid === null) return false;
  for (let attempt = 0; ; attempt++) {
    const argv = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
    if (argv.split("\0").includes(dir)) return ownRunner(pid);
    if (attempt >= ALIVE_RETRIES || !(await processExists(pid))) return false;
    await Bun.sleep(ALIVE_RETRY_MS);
  }
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
  const running = await scoutRunnerAlive(fold.pid, dir);
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
export async function scoutUsage(caller: ScoutCaller): Promise<ScoutUsage | null> {
  let sum: ScoutUsage | null = null;
  for (const dir of await scoutDirs(caller)) {
    const usage = await readScout(dir).then(
      ({ fold }) => fold.usage,
      () => null,
    );
    sum = addScoutUsage(sum, usage);
  }
  return sum;
}

/** `a` plus `b`, null when both are. */
export function addScoutUsage(a: ScoutUsage | null, b: ScoutUsage | null): ScoutUsage | null {
  if (b === null) return a;
  if (a === null) return { ...b };
  return { ...a, input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, cost: a.cost + b.cost };
}

/** How many of `caller`'s scouts run now: state `running` with a live runner. */
export async function runningScouts(caller: ScoutCaller): Promise<number> {
  let count = 0;
  for (const dir of await scoutDirs(caller)) {
    const scout = await readScout(dir).catch(() => undefined);
    if (scout?.fold.state === "running" && (scout.fold.pid === null || (await scoutRunnerAlive(scout.fold.pid, dir)))) count += 1;
  }
  return count;
}

const STOP_WAIT_MS = 5_000;

async function stopScoutRunner(dir: string, pid: number | null): Promise<void> {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (!(await scoutRunnerAlive(pid, dir))) return;
    signalRunner(pid as number, signal);
    const deadline = Date.now() + STOP_WAIT_MS;
    while (Date.now() < deadline && (await scoutRunnerAlive(pid, dir))) await Bun.sleep(50);
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
  for (;;) {
    const argv = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
    if (argv.split("\0").includes(dir)) return true;
    if (!(await processExists(pid)) || Date.now() >= deadline) return false;
    await Bun.sleep(ALIVE_RETRY_MS);
  }
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
  for (const key of ["FACTORY_TASK_SESSION", "FACTORY_TASK_LOCK", "FACTORY_TASK_WAVE", "FACTORY_WAVE_LOCK"]) delete runnerEnv[key];
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
  usage: ScoutUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
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
    const usage = event.message.usage;
    if (!isRecord(usage)) return false;
    this.usage.input += numberOr0(usage.input);
    this.usage.output += numberOr0(usage.output);
    this.usage.cacheRead += numberOr0(usage.cacheRead);
    this.usage.cacheWrite += numberOr0(usage.cacheWrite);
    this.usage.cost += isRecord(usage.cost) ? numberOr0(usage.cost.total) : 0;
    return true;
  }
}
