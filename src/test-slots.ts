/**
 * Test slots: every gate command of every repository this factory serves runs holding one of K slots, so test runs
 * share the machine instead of each taking all of it.
 * - A slot is a lock file held by a `flock` child while its stdin is open: a holder that dies frees its slot
 * - K = `FACTORY_SLOTS`, default max(1, cores / 4); the command gets `FACTORY_TEST_JOBS` = cores / K and
 *   `FACTORY_SLOT_HELD=1`. A process with `FACTORY_SLOT_HELD` set holds a slot already and takes none
 * - A waiting process leaves a marker for `slotWaiting`; a marker whose process died (`procAlive`) is removed
 */
import { constants } from "node:os";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandResult } from "./run.ts";
import { factoryHome } from "./settings.ts";
import { procAlive, procStart } from "./tasks.ts";

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
        marker = join(pool.dir, "waiting", `${process.pid}-${(await procStart(process.pid)) ?? "0"}-${crypto.randomUUID()}`);
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

/** Whether one of `pids` waits for a slot now. A marker of `pids` whose process died waiting (`procAlive`) is ignored and removed. */
export async function slotWaiting(pids: readonly number[], dir: string = slotsDir()): Promise<boolean> {
  if (pids.length === 0) return false;
  const waiting = join(dir, "waiting");
  const names = await readdir(waiting).catch(() => [] as string[]);
  let found = false;
  for (const name of names) {
    const [pid = "", start = ""] = name.split("-");
    if (!pids.includes(Number(pid))) continue;
    if (!(await procAlive(Number(pid), start))) await rm(join(waiting, name), { force: true });
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
