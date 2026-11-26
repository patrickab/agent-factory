/**
 * Test slots: every gate command of every repository this factory serves runs holding one of K slots, so test runs
 * share the machine instead of each taking all of it.
 *
 * - A slot is a lock file `<agent dir>/factory/slots/<n>.lock`, held by a `flock` child while its stdin is open: a
 *   holder that dies (crash, kill) frees its slot
 * - K = `FACTORY_SLOTS`, default max(1, cores / 4 rounded down). The slotted command gets `FACTORY_TEST_JOBS` = cores / K
 *   rounded down (min 1) unless the environment sets it, and `FACTORY_SLOT_HELD=1`. A process with `FACTORY_SLOT_HELD`
 *   set holds a slot already and takes none
 * - Waiting ends when `stop()` says so, as a killed result. A waiting process leaves a marker `waiting/<pid>.<uuid>`:
 *   `slotWaiting(pids)` tells a task's or a wave's view; a marker whose process died, or older than the start of the
 *   process that has its pid now (the pid was reused), is ignored and removed
 * - `runInSlot`: `factory slot -- <command...>`, for test runs outside the factory's gates
 */
import { constants } from "node:os";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandResult } from "./run.ts";
import { factoryHome } from "./settings.ts";

export const SLOTS_ENV = "FACTORY_SLOTS";
export const TEST_JOBS_ENV = "FACTORY_TEST_JOBS";
export const SLOT_HELD_ENV = "FACTORY_SLOT_HELD";
/** How often a waiting process tries the slots again. */
const POLL_MS = 1000;

export interface SlotPool {
  dir: string;
  /** K: how many slotted commands run at once. */
  count: number;
  cores: number;
  /** This process holds a slot already (`FACTORY_SLOT_HELD`): it takes none. */
  held: boolean;
  /** `FACTORY_TEST_JOBS` as the environment sets it, null when it does not. */
  jobs: string | null;
  pollMs: number;
}

type Env = Record<string, string | undefined>;

function positive(text: string | undefined): number | null {
  return text !== undefined && /^\d+$/.test(text.trim()) && Number(text) > 0 ? Number(text) : null;
}

export function slotsDir(): string {
  return join(factoryHome(), "slots");
}

/** K: `FACTORY_SLOTS` when a positive integer, else max(1, cores / 4 rounded down). */
export function slotCount(env: Env, cores: number): number {
  return positive(env[SLOTS_ENV]) ?? Math.max(1, Math.floor(cores / 4));
}

/** The pool this process's gates share, from `env`. */
export function slotPool(env: Env = process.env, cores: number = navigator.hardwareConcurrency): SlotPool {
  const jobs = env[TEST_JOBS_ENV];
  return { dir: slotsDir(), count: slotCount(env, cores), cores, held: (env[SLOT_HELD_ENV] ?? "") !== "", jobs: jobs === undefined || jobs === "" ? null : jobs, pollMs: POLL_MS };
}

/** What a slotted command gets added to its environment. */
export function slotEnv(pool: SlotPool): Record<string, string> {
  return { ...(pool.jobs === null ? { [TEST_JOBS_ENV]: String(Math.max(1, Math.floor(pool.cores / pool.count))) } : {}), [SLOT_HELD_ENV]: "1" };
}

/** Takes the lock `path` if it is free: its release, else null. */
async function tryLock(path: string): Promise<(() => Promise<void>) | null> {
  const child = Bun.spawn(["flock", "-n", path, "sh", "-c", "echo locked; read _"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const reader = child.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  if (value === undefined || !new TextDecoder().decode(value).startsWith("locked")) {
    child.kill();
    await child.exited;
    return null;
  }
  return async () => {
    child.stdin.end();
    await child.exited;
  };
}

/** Takes a free slot, waiting while none is: its release, or null when `stop()` ended the wait. */
export async function takeSlot(pool: SlotPool, stop: () => boolean = () => false): Promise<(() => Promise<void>) | null> {
  await mkdir(pool.dir, { recursive: true });
  let marker: string | null = null;
  try {
    for (;;) {
      for (let n = 0; n < pool.count; n++) {
        const release = await tryLock(join(pool.dir, `${n}.lock`));
        if (release !== null) return release;
      }
      if (stop()) return null;
      if (marker === null) {
        marker = join(pool.dir, "waiting", `${process.pid}.${crypto.randomUUID()}`);
        await mkdir(join(pool.dir, "waiting"), { recursive: true });
        await writeFile(marker, "", "utf8");
      }
      await Bun.sleep(pool.pollMs);
    }
  } finally {
    if (marker !== null) await rm(marker, { force: true });
  }
}

const KILLED: CommandResult = { exitCode: null, killed: true, timedOut: false, durationMs: 0, stdout: "", stdoutTruncated: false, output: "" };

/** Runs `run` holding a slot, with `slotEnv` for its command; a wait that `stop()` ends answers as a killed command. */
export async function withSlot(pool: SlotPool, stop: () => boolean, run: (env: Record<string, string>) => Promise<CommandResult>): Promise<CommandResult> {
  if (pool.held) return run({});
  const release = await takeSlot(pool, stop);
  if (release === null) return { ...KILLED };
  try {
    return await run(slotEnv(pool));
  } finally {
    await release();
  }
}

/** Whether process `pid` lives (one of another user counts as alive). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** When process `pid` started (ms since the epoch, at most a second early: the boot time is whole seconds), null when unknown. */
async function startedAt(pid: number): Promise<number | null> {
  try {
    const line = await readFile(`/proc/${pid}/stat`, "utf8");
    // The fields after the command name, which ends with the last `)`: state is field 3, starttime field 22.
    const ticks = Number(line.slice(line.lastIndexOf(")") + 2).split(" ")[19]);
    const boot = Number(/^btime (\d+)$/m.exec(await readFile("/proc/stat", "utf8"))?.[1]);
    if (!Number.isFinite(ticks) || !Number.isFinite(boot)) return null;
    return boot * 1000 + (ticks * 1000) / CLOCK_TICKS;
  } catch {
    return null;
  }
}

/** USER_HZ of `/proc/<pid>/stat`: 100 on every Linux architecture the factory runs on. */
const CLOCK_TICKS = 100;

/** Whether the marker `path` of `pid` is stale: its process is gone, or the pid's process started after the marker. */
async function staleMarker(path: string, pid: number): Promise<boolean> {
  if (!alive(pid)) return true;
  const started = await startedAt(pid);
  if (started === null) return false;
  const written = await stat(path).then((info) => info.mtimeMs, () => null);
  return written !== null && written < started;
}

/**
 * Whether one of `pids` waits for a slot now. A marker of `pids` that is stale (its process died waiting, or the pid
 * belongs to a process started after the marker) is ignored and removed.
 */
export async function slotWaiting(pids: readonly number[], dir: string = slotsDir()): Promise<boolean> {
  if (pids.length === 0) return false;
  const waiting = join(dir, "waiting");
  const names = await readdir(waiting).catch(() => [] as string[]);
  let found = false;
  for (const name of names) {
    const pid = Number(name.slice(0, name.indexOf(".")));
    if (!pids.includes(pid)) continue;
    if (await staleMarker(join(waiting, name), pid)) await rm(join(waiting, name), { force: true });
    else found = true;
  }
  return found;
}

/** `factory slot -- <command...>`: runs `argv` holding a slot (directly with `FACTORY_SLOT_HELD` set); its exit code. */
export async function runInSlot(argv: string[], pool: SlotPool = slotPool()): Promise<number> {
  let signal: NodeJS.Signals | null = null;
  let child: ReturnType<typeof Bun.spawn> | null = null;
  const forward = (received: NodeJS.Signals) => {
    signal ??= received;
    child?.kill(received);
  };
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const name of signals) process.on(name, forward);
  try {
    const release = pool.held ? async () => {} : await takeSlot(pool, () => signal !== null);
    if (release === null) return 128 + (constants.signals[signal ?? "SIGTERM"] ?? 15);
    try {
      child = Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"], env: { ...process.env, ...(pool.held ? {} : slotEnv(pool)) } });
      await child.exited;
      if (child.exitCode !== null) return child.exitCode;
      const code = child.signalCode === null ? undefined : constants.signals[child.signalCode as NodeJS.Signals];
      return 128 + (code ?? 15);
    } finally {
      await release();
    }
  } finally {
    for (const name of signals) process.off(name, forward);
  }
}
