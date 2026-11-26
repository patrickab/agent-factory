/**
 * Where a wave's files lie, and the poke that makes its runner look at it again.
 *
 * - `wavesDir()` under the factory home: `<id>.jsonl` (the log), `<id>.log` (the runner's output), `<id>.lock` (the
 *   runner's lock: one runner per wave), `<id>.log.lock` (held around one read-check-append of the log), `<id>.poke`
 *   (the poke marker) and `<id>.reviews/` (the reviewer's sessions and patch files)
 * - `pokeWave`: writes the marker, then starts `bun wave-runner.ts <id>` detached and hands it the wave's lock, unless
 *   a live runner holds that lock: that runner sees the marker and looks again before it ends (invariant 6)
 * - `liveWaveRunners`/`stopWaveRunners`: a wave's runner processes, found by `pgrep -f` on the whole wave id argument,
 *   only those with the caller's marker (`ownRunner` of `spawn.ts`, invariant 16)
 * - Imports nothing outside node built-ins and the plain plugin modules: a task's runner pokes its wave when it ends
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "./run.ts";
import { factoryHome } from "./settings.ts";
import { onPath, ownRunners, signalRunner, spawnDetached, type RunnerEnv } from "./spawn.ts";
import { handLockFile, lockFile, TaskBusyError, unlockFile } from "./tasks.ts";
import { outputTail } from "./util.ts";

// `import.meta.dirname`, not Bun's `import.meta.dir`: inside Pi the latter is not this directory.
export const WAVE_RUNNER_PATH = join(import.meta.dirname, "wave-runner.ts");
/** Set on a wave task's runner: the wave it pokes when it ends with the task at rest. */
export const TASK_WAVE_ENV = "FACTORY_TASK_WAVE";
/** Set on a wave runner a poke started: the wave's lock is handed to it right after the spawn. */
export const WAVE_LOCK_ENV = "FACTORY_WAVE_LOCK";
/** A task runner's own variables, which a poke (from that runner) never passes on to the wave runner. */
const TASK_RUNNER_ENV = ["FACTORY_TASK_SESSION", "FACTORY_TASK_LOCK", TASK_WAVE_ENV];
const STOP_WAIT_MS = 10_000;

/** Wave ids have the shape of task ids (`crypto.randomUUID`): never a path separator. */
const WAVE_ID = /^[0-9a-f-]{36}$/;

export function isWaveId(id: string): boolean {
  return WAVE_ID.test(id);
}

export function wavesDir(): string {
  return join(factoryHome(), "waves");
}

export function wavePath(id: string): string {
  return join(wavesDir(), `${id}.jsonl`);
}

/** Where the detached runner of a wave writes its stdout and stderr. */
export function waveLogPath(id: string): string {
  return join(wavesDir(), `${id}.log`);
}

/** The wave runner's lock: whoever holds it is the wave's one runner. */
export function waveLockPath(id: string): string {
  return join(wavesDir(), `${id}.lock`);
}

/** Held around one read-check-append of the wave's log (`appendWaveEvents`): appends never interleave. */
export function waveLogLockPath(id: string): string {
  return join(wavesDir(), `${id}.log.lock`);
}

/** The poke marker: present while a poke has not been looked at yet. */
export function wavePokePath(id: string): string {
  return join(wavesDir(), `${id}.poke`);
}

/** The reviewer's sessions and patch files of the wave. */
export function waveReviewsDir(id: string): string {
  return join(wavesDir(), `${id}.reviews`);
}

/**
 * Makes the wave's runner look at the wave: the marker, then a new runner with `env` (default `process.env`) unless a
 * live one holds the wave's lock. Resolves with true when it started a runner.
 */
export async function pokeWave(id: string, env: RunnerEnv = process.env): Promise<boolean> {
  if (!isWaveId(id)) throw new Error(`${id} is not a wave id`);
  const bun = onPath("bun");
  if (bun === null) throw new Error("bun is not on PATH: the wave runner needs it");
  await mkdir(wavesDir(), { recursive: true });
  // The marker first: a runner that holds the lock now looks for it after it let the lock go.
  await writeFile(wavePokePath(id), "", "utf8");
  try {
    await lockFile(waveLockPath(id), `wave ${id.slice(0, 8)} has a runner`);
  } catch (error) {
    if (error instanceof TaskBusyError) return false;
    throw error;
  }
  let pid: number | undefined;
  try {
    const runnerEnv: RunnerEnv = { ...env, [WAVE_LOCK_ENV]: "1" };
    for (const key of TASK_RUNNER_ENV) delete runnerEnv[key];
    pid = await spawnDetached([bun, WAVE_RUNNER_PATH, id], runnerEnv, waveLogPath(id), import.meta.dirname);
  } finally {
    if (pid === undefined) await unlockFile(waveLockPath(id));
  }
  if (pid !== undefined) await handLockFile(waveLockPath(id), pid);
  return pid !== undefined;
}

/**
 * The live runner processes (`runner.ts`, `wave-runner.ts`) with the caller's marker at one moment, with their
 * arguments: one scan of `/proc` serves the looks of a whole listing (`waves.list`) instead of a `pgrep` per task and
 * wave.
 */
export type RunnerSnapshot = readonly { pid: number; args: string[] }[];

export async function runnerSnapshot(): Promise<RunnerSnapshot> {
  const pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name)).map(Number);
  const found = await Promise.all(pids.map(async (pid) => ({ pid, args: (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).split("\0").filter((arg) => arg !== "") })));
  const runners = found.filter(({ pid, args }) => pid !== process.pid && args.some((arg) => arg.endsWith("runner.ts")));
  const own = new Set(await ownRunners(runners.map(({ pid }) => pid)));
  return runners.filter(({ pid }) => own.has(pid));
}

/**
 * The pids of the wave's live runners with the caller's marker, found by their command line (`wave-runner.ts <id>`, the
 * whole id); among `snapshot` when given.
 */
export async function liveWaveRunners(id: string, snapshot?: RunnerSnapshot): Promise<number[]> {
  if (!isWaveId(id)) return [];
  if (snapshot !== undefined) return snapshot.filter(({ args }) => args.length >= 2 && args[args.length - 1] === id && args[args.length - 2].endsWith("wave-runner.ts")).map(({ pid }) => pid);
  const result = await runCommand(["pgrep", "-f", `wave-runner\\.ts ${id}$`], { cwd: "/", maxStdoutChars: 10_000 });
  // Exit 1 is "no match"; anything else (pgrep missing or failing) would hide a live runner.
  if (result.exitCode === 1) return [];
  if (result.exitCode !== 0) throw new Error(`pgrep, which finds a wave's runner, failed (exit ${result.exitCode}): ${outputTail(result.output)}`);
  return ownRunners(result.stdout.split("\n").filter((line) => line.trim() !== "").map(Number));
}

/**
 * Waits up to `waitMs` for the wave's runners to end, sending `signal` to each one it has not signalled yet: a task's
 * runner that ends meanwhile pokes the wave and may start a fresh runner, which must be stopped too.
 */
async function runnersEnded(id: string, waitMs: number, signal: NodeJS.Signals): Promise<boolean> {
  const signalled = new Set<number>();
  const deadline = Date.now() + waitMs;
  for (;;) {
    const pids = await liveWaveRunners(id);
    if (pids.length === 0) return true;
    if (Date.now() > deadline) return false;
    for (const pid of pids.filter((pid) => !signalled.has(pid))) {
      signalled.add(pid);
      signalRunner(pid, signal);
    }
    await Bun.sleep(100);
  }
}

/** Ends the wave's runners: SIGTERM (the runner cancels its commands and lets the lock go), SIGKILL when that is not enough. */
export async function stopWaveRunners(id: string): Promise<void> {
  if (await runnersEnded(id, STOP_WAIT_MS, "SIGTERM")) return;
  if (!(await runnersEnded(id, STOP_WAIT_MS, "SIGKILL"))) throw new Error(`the runner of wave ${id} does not end`);
}

/** Removes the wave's poke marker. */
export async function clearPoke(id: string): Promise<void> {
  await rm(wavePokePath(id), { force: true });
}
