/**
 * Where a wave's files lie, and the poke that makes its runner look at it again.
 * - A wave's home holds what stays after a removal: `wave.jsonl`, `reviews/`, `sessions/`; `wavesDir()` holds what
 *   runs: the link to the home, the runner's log, lock, log lock and poke marker
 * - `pokeWave` writes the marker first: a live runner that holds the lock sees it and looks again before it ends
 * - Imports nothing outside node built-ins and the plain plugin modules: a task's runner pokes its wave when it ends
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { factoryHome } from "./settings.ts";
import { lockFile, lockRunner, startRunner } from "./lock.ts";
import { stopProcesses, type RunnerEnv } from "./spawn.ts";
import { memoryStoreRoot } from "./store.ts";
import { isBusy } from "./util.ts";

// `import.meta.dirname`, not Bun's `import.meta.dir`: inside Pi the latter is not this directory.
export const WAVE_RUNNER_PATH = join(import.meta.dirname, "wave-runner.ts");
/** Set on a wave task's runner: the wave it pokes when it ends with the task at rest. */
export const TASK_WAVE_ENV = "FACTORY_TASK_WAVE";

/** Wave ids have the shape of task ids (`crypto.randomUUID`): never a path separator. */
const WAVE_ID = /^[0-9a-f-]{36}$/;

export function isWaveId(id: string): boolean {
  return WAVE_ID.test(id);
}

export function wavesDir(): string {
  return join(factoryHome(), "waves");
}

/** A new wave's home: `<store>/run/waves/<tag>/<id 8>` when its plan's store exists, else `<factory home>/homes/<tag>/<id 8>`. */
export function waveHome(wave: { id: string; tag: string; plan: string | null }): string {
  const store = wave.plan ? join(memoryStoreRoot(), wave.plan) : null;
  const root = store !== null && existsSync(store) ? join(store, "run", "waves") : join(factoryHome(), "homes");
  return join(root, wave.tag, wave.id.slice(0, 8));
}

/** The wave's entry in `wavesDir()`: a link to its home. */
export function waveDir(id: string): string {
  return join(wavesDir(), id);
}

export function wavePath(id: string): string {
  return join(waveDir(id), "wave.jsonl");
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
  return join(waveDir(id), "reviews");
}

/** Takes the wave runner's lock for this process: a `busy` FactoryError while a live runner holds it. */
export async function lockWave(id: string): Promise<void> {
  await lockFile(waveLockPath(id), `wave ${id.slice(0, 8)} has a runner`);
}

/**
 * Makes the wave's runner look at the wave: the marker, then a new runner with `env` (default `process.env`) unless a
 * live one holds the wave's lock. Resolves with true when it started a runner.
 */
export async function pokeWave(id: string, env: RunnerEnv = process.env): Promise<boolean> {
  if (!isWaveId(id)) throw new Error(`${id} is not a wave id`);
  await mkdir(wavesDir(), { recursive: true });
  // The marker first: a runner that holds the lock now looks for it after it let the lock go.
  await writeFile(wavePokePath(id), "", "utf8");
  try {
    await lockWave(id);
  } catch (error) {
    if (isBusy(error)) return false;
    throw error;
  }
  await startRunner({ lock: waveLockPath(id), argv: [WAVE_RUNNER_PATH, id], env, log: waveLogPath(id), cwd: import.meta.dirname });
  return true;
}

/** The wave's live runner: the holder of its lock (`lockRunner`), named by the wave id; as a list. */
export async function liveWaveRunners(id: string): Promise<number[]> {
  const pid = isWaveId(id) ? await lockRunner(waveLockPath(id), id) : null;
  return pid === null ? [] : [pid];
}

/** Ends the wave's runners (SIGTERM: the runner cancels its commands and lets the lock go). */
export function stopWaveRunners(id: string): Promise<void> {
  return stopProcesses(() => liveWaveRunners(id), `the runner of wave ${id}`);
}

export async function clearPoke(id: string): Promise<void> {
  await rm(wavePokePath(id), { force: true });
}
