/**
 * Processes and the pid locks of the factory's runners (a task's, a wave's, a proof's, a scout's).
 * - A lock file holds `<pid> <start time>`: a holder that no longer runs leaves a stale lock the next `lockFile` takes
 *   over
 * - `startRunner` is the one way a runner starts: the caller holds the lock, the spawned runner gets it and removes it
 *   when it exits
 * - `lockRunner` is the one rule of a runner's life: the process the lock names runs with the runner's id among its
 *   arguments
 */
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { RUNNER_ONLY_ENV } from "./run.ts";
import { onPath, spawnDetached, type RunnerEnv } from "./spawn.ts";
import { FactoryError, isBusy, writeAtomic } from "./util.ts";

async function lockOwner(pid: number): Promise<string> {
  return `${pid} ${(await procStart(pid)) ?? "0"}\n`;
}

/** Start time of the running process `pid` from `/proc/<pid>/stat`, which a reused pid never repeats; null when it does not run. */
export async function procStart(pid: number): Promise<string | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    // The fields after the name in parentheses (which may hold spaces), start time is the 20th of them.
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

/** Liveness from `/proc`: the pid runs and its start time is `start`, which a reused pid never repeats. */
export async function procAlive(pid: number, start: string): Promise<boolean> {
  return (await procStart(pid)) === start;
}

/** Whether the lock file's holder still runs; a missing or unreadable file has none. */
export async function lockHeld(path: string): Promise<boolean> {
  const text = await readFile(path, "utf8").catch(() => "");
  const [pid = "", start = ""] = text.trim().split(" ");
  return pid !== "" && (await procAlive(Number(pid), start));
}

/** The runner holding the lock file `path`: its pid when that process runs with `id` among its arguments, else null. */
export async function lockRunner(path: string, id: string): Promise<number | null> {
  const pid = Number((await readFile(path, "utf8").catch(() => "")).split(" ")[0]);
  if (!(pid > 0)) return null;
  return (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).split("\0").includes(id) ? pid : null;
}

/** Takes the lock file `path` for this process. Throws the FactoryError `busy` (code `busy`) while a live process holds it. */
export async function lockFile(path: string, busy: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Written in full first, then linked: `link` fails on an existing lock, and no reader sees a half-written one.
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, await lockOwner(process.pid), "utf8");
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await link(temp, path);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (await lockHeld(path)) break;
      await rm(path, { force: true });
    }
  } finally {
    await rm(temp, { force: true });
  }
  throw new FactoryError("busy", busy);
}

/** Runs `act` holding the lock file `path`, waiting up to `waitMs` for another holder; then the FactoryError `busy`. An aborted `signal` ends the wait. */
export async function withLock<T>(path: string, busy: string, waitMs: number, act: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await lockFile(path, busy);
      break;
    } catch (error) {
      if (!isBusy(error) || Date.now() > deadline || signal?.aborted) throw error;
      await Bun.sleep(20);
    }
  }
  try {
    return await act();
  } finally {
    await unlockFile(path);
  }
}

/** Passes the lock file `path` to the process `pid` (a runner this process spawned); only while this process holds it. */
export async function handLockFile(path: string, pid: number): Promise<void> {
  const text = await readFile(path, "utf8").catch(() => "");
  if (text.split(" ")[0] === String(process.pid)) await writeAtomic(path, await lockOwner(pid));
}

/** Removes the lock file `path` if this process holds it; a lock handed to a runner stays. */
export async function unlockFile(path: string): Promise<void> {
  const text = await readFile(path, "utf8").catch(() => "");
  if (text.split(" ")[0] === String(process.pid)) await rm(path, { force: true });
}

/**
 * Starts `bun <argv>` detached in `cwd` (`spawnDetached`), output appended to `log`, with `env` less the runner-only
 * variables plus `vars`, and hands it the lock file `lock`, which the caller holds. A runner that does not start
 * releases the lock and throws.
 */
export async function startRunner(runner: { lock: string; argv: string[]; env: RunnerEnv; vars?: RunnerEnv; log: string; cwd: string }): Promise<void> {
  let pid: number | undefined;
  try {
    const bun = onPath("bun");
    if (bun === null) throw new Error("bun is not on PATH: the factory's runners need it");
    const env = { ...runner.env };
    for (const key of RUNNER_ONLY_ENV) delete env[key];
    pid = await spawnDetached([bun, ...runner.argv], { ...env, ...runner.vars }, runner.log, runner.cwd);
    if (pid === undefined) throw new Error("the runner did not start");
  } catch (error) {
    await unlockFile(runner.lock);
    throw error;
  }
  await handLockFile(runner.lock, pid);
}
