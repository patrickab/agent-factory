/**
 * The detached spawn of a factory runner, shared by a task's runner (`launch.ts`) and a wave's (`wave-poke.ts`).
 *
 * - `runnerSpawn`: the argv and environment, in a systemd user scope of its own when `systemd-run` is on PATH: the one
 *   place that decides it, for every runner
 * - `spawnDetached`: its own process group, detached, stdout and stderr appended to a log file; resolves with the pid
 * - Imports nothing outside node built-ins: a task's runner imports it
 */
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";

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
 * command line are the runner's (`liveRunners` finds it).
 */
export function runnerSpawn(command: string[], env: RunnerEnv, hostEnv: RunnerEnv, systemdRun: string | null): { argv: string[]; env: RunnerEnv } {
  if (systemdRun === null || (env.XDG_RUNTIME_DIR ?? hostEnv.XDG_RUNTIME_DIR) === undefined) return { argv: command, env };
  const scopeEnv = { ...env };
  for (const key of SYSTEMD_USER_ENV) if (scopeEnv[key] === undefined && hostEnv[key] !== undefined) scopeEnv[key] = hostEnv[key];
  return { argv: [systemdRun, "--user", "--scope", "--quiet", "--collect", "--", ...command], env: scopeEnv };
}

/** Starts `command` (through `runnerSpawn`) detached in `cwd` with `env`, output appended to `logPath`. Resolves with its pid. */
export async function spawnDetached(command: string[], env: RunnerEnv, logPath: string, cwd: string): Promise<number | undefined> {
  const log = openSync(logPath, "a");
  try {
    const runner = runnerSpawn(command, env, process.env, onPath("systemd-run"));
    const child = spawn(runner.argv[0], runner.argv.slice(1), { cwd, detached: true, env: runner.env, stdio: ["ignore", log, log] });
    await new Promise<void>((resolveSpawn, reject) => {
      child.once("spawn", () => resolveSpawn());
      child.once("error", reject);
    });
    child.unref();
    return child.pid;
  } finally {
    closeSync(log);
  }
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
