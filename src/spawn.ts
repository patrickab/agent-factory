/**
 * The detached spawn of a factory runner, in its own process group, its output appended to a log file.
 * - `runnerSpawn` is the one place that decides a systemd user scope (when `systemd-run` is on PATH)
 * - A scope whose `systemd-run` fails at once is not a runner: the plain detached spawn takes its place, so the lock
 *   is never handed to a dead pid
 * - Imports nothing outside node built-ins: a task's runner imports it
 */
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";

/** The environment of the runners a caller starts (`process.env` when it gives none). */
export type RunnerEnv = Record<string, string | undefined>;

/** `Bun.which` reads the PATH the process started with unless it is given the current one. */
export function onPath(binary: string): string | null {
  return Bun.which(binary, { PATH: process.env.PATH ?? "" });
}

/** What a systemd user scope needs to reach the user manager; copied from the host when `env` lacks it. */
const SYSTEMD_USER_ENV = ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];

/**
 * The argv and environment of a runner. With `systemdRun` (on PATH) and the user manager reachable (`XDG_RUNTIME_DIR`)
 * it runs in a transient user scope of its own (`--collect`: unloaded even when it failed), outside the caller's
 * process group and control group: a restart of the service or the terminal the caller lived in leaves it. Else the
 * command as it is (detached by `spawnDetached`). `systemd-run --scope` execs the command, so the spawned pid and its
 * command line are the runner's (`runnerAlive` finds it).
 */
function runnerSpawn(command: string[], env: RunnerEnv, hostEnv: RunnerEnv, systemdRun: string | null): { argv: string[]; env: RunnerEnv } {
  if (systemdRun === null || (env.XDG_RUNTIME_DIR ?? hostEnv.XDG_RUNTIME_DIR) === undefined) return { argv: command, env };
  const scopeEnv = { ...env };
  for (const key of SYSTEMD_USER_ENV) if (scopeEnv[key] === undefined && hostEnv[key] !== undefined) scopeEnv[key] = hostEnv[key];
  return { argv: [systemdRun, "--user", "--scope", "--quiet", "--collect", "--", ...command], env: scopeEnv };
}

/** How long a scoped spawn must live to count: `systemd-run` that cannot reach the user manager exits sooner. */
const SCOPE_GRACE_MS = 250;
const SCOPE_POLL_MS = 5;

function startChild(argv: string[], env: RunnerEnv, logPath: string, cwd: string): Promise<ChildProcess> {
  const log = openSync(logPath, "a");
  try {
    const child = spawn(argv[0], argv.slice(1), { cwd, detached: true, env, stdio: ["ignore", log, log] });
    return new Promise<ChildProcess>((resolveSpawn, reject) => {
      child.once("spawn", () => resolveSpawn(child));
      child.once("error", reject);
    });
  } finally {
    closeSync(log);
  }
}

/** Whether `pid` still runs `systemdRun` (as argv[0], or argv[1] under a script's interpreter); "" argv when unreadable. */
function stillRuns(pid: number, systemdRun: string): { readable: boolean; still: boolean } {
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    return { readable: argv[0] !== "", still: argv[0] === systemdRun || argv[1] === systemdRun };
  } catch {
    return { readable: false, still: false };
  }
}

/**
 * Whether the scope `child` (`systemd-run` at `systemdRun`) fails before it execs the runner: it exits with a failure
 * within `SCOPE_GRACE_MS` while its pid still runs `systemd-run`. Resolves as soon as the pid runs anything else, so a
 * working scope costs no wait; still `systemd-run` at the deadline counts as working (the fallback would run it twice).
 */
async function scopeFails(child: ChildProcess, systemdRun: string): Promise<boolean> {
  const deadline = Date.now() + SCOPE_GRACE_MS;
  for (;;) {
    const { readable, still } = stillRuns(child.pid ?? 0, systemdRun);
    if (readable && !still) return false;
    if (child.exitCode !== null || child.signalCode !== null) return child.exitCode !== 0;
    if (Date.now() >= deadline) return false;
    await new Promise((resolveTick) => setTimeout(resolveTick, SCOPE_POLL_MS));
  }
}

/**
 * Starts `command` (through `runnerSpawn`) detached in `cwd` with `env`, output appended to `logPath`. Resolves with its pid. A scoped spawn that fails before it execs the runner (`scopeFails`) is
 * replaced by the plain one. `systemdRun`: for tests.
 */
export async function spawnDetached(
  command: string[],
  env: RunnerEnv,
  logPath: string,
  cwd: string,
  systemdRun: string | null = onPath("systemd-run"),
): Promise<number | undefined> {
  const runner = runnerSpawn(command, env, process.env, systemdRun);
  let child = await startChild(runner.argv, runner.env, logPath, cwd);
  if (systemdRun !== null && runner.argv !== command && (await scopeFails(child, systemdRun))) child = await startChild(command, env, logPath, cwd);
  child.unref();
  return child.pid;
}

/** Signals a runner's process group (it leads one), else the runner alone. */
export function signalRunner(pid: number, signal: NodeJS.Signals): void {
  // A runner leads its own process group, Pi is in it. Every command the plugin starts has a group of its own
  // (`run.ts`), so a Pi killed with SIGKILL leaves those running.
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, signal);
      return;
    } catch {
      // not a group leader, or gone already
    }
  }
}

/**
 * Ends the runners `find` lists: SIGTERM, SIGKILL after 10 s, an error after 10 s more. Each pass signals the ones it
 * has not yet: a runner that appears meanwhile (a task's runner that ends pokes its wave) is stopped too.
 */
export async function stopProcesses(find: () => Promise<number[]>, what: string): Promise<void> {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const signalled = new Set<number>();
    const deadline = Date.now() + 10_000;
    for (;;) {
      const pids = await find();
      if (pids.length === 0) return;
      if (Date.now() > deadline) break;
      for (const pid of pids.filter((pid) => !signalled.has(pid))) {
        signalled.add(pid);
        signalRunner(pid, signal);
      }
      await Bun.sleep(100);
    }
  }
  throw new Error(`${what} does not end`);
}
