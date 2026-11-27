/**
 * The factory's own list of tasks, kept outside any Pi session: one JSON file per task, `<factoryHome>/tasks/<id>.json`.
 * - The task lock `<id>.lock`: whoever checks a task's state and then acts on it holds it, and a spawned runner holds
 *   it until it exits. It holds `<pid> <start time>`: a holder that no longer runs leaves a stale lock the next
 *   `lockTask` takes over
 * - `lockRunner` is the one rule of a runner's life: the process the lock names runs with the runner's id among its
 *   arguments
 */
import { link, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { factoryHome } from "./settings.ts";
import { errorText, FactoryError, ifMissing, isBusy, writeAtomic } from "./util.ts";

export interface TaskRecord {
  id: string;
  /** The primary checkout's absolute path. */
  repo: string;
  worktree: string;
  /** The task's own branch, checked out in `worktree`. */
  branch: string;
  title: string;
  /** Pi's `--session-id`: the session file in `sessionDir` has it in its name. */
  sessionId: string;
  sessionDir: string;
  /** ISO timestamp. */
  createdAt: string;
  /** Who or what the task belongs to: segments joined by `/` (`isTaskTag`), a group is a prefix of them. */
  tag: string;
  /** A memory_store path the task works from; the factory only stores it. */
  plan: string | null;
  /** The wave the task belongs to (`waves.start`, `waves.add`), null for a task outside one. */
  wave: string | null;
  /** The Pi session that started the task (a wave's task: the wave's), notified when it needs attention; null otherwise. */
  origin: string | null;
  /**
   * A wave's task with contracts (`contracts.ts`): each contract's stamp (its hash and its facts' hashes) as the task
   * last saw it. Absent: no contracts.
   */
  contracts?: Record<string, ContractStamp>;
  /** Contract follow-ups `contracts.apply` left for the task's next coder turn (it was not running). */
  contractNotes?: string[];
}

/** A contract as a task saw it: the hash of the whole and of each fact (by its path in the store). */
export type ContractStamp = { hash: string; facts: Record<string, string> };

/** The shape of `crypto.randomUUID()`: a task id never holds a path separator. */
const TASK_ID = /^[0-9a-f-]{36}$/;
const TAG = /^[A-Za-z0-9._@+-]+(\/[A-Za-z0-9._@+-]+)*$/;

export function isTaskTag(tag: string): boolean {
  return TAG.test(tag);
}

/** Whether `tag` is `group` or lies under it: `a` holds `a/b`, not `ab`. */
export function tagInGroup(tag: string, group: string): boolean {
  return tag === group || tag.startsWith(`${group}/`);
}

/** The tag of a task started without one: the system user's name. */
export function systemUser(): string {
  try {
    return userInfo().username;
  } catch {
    // No passwd entry (a container with an arbitrary uid): the login the environment names.
    return process.env.USER ?? process.env.LOGNAME ?? "user";
  }
}

export function tasksDir(): string {
  return join(factoryHome(), "tasks");
}

function taskPath(id: string): string {
  return join(tasksDir(), `${id}.json`);
}

/** Where the detached runner of a task writes its stdout and stderr. */
export function taskLogPath(id: string): string {
  return join(tasksDir(), `${id}.log`);
}

export function taskLockPath(id: string): string {
  return join(tasksDir(), `${id}.lock`);
}

export async function writeTask(record: TaskRecord): Promise<void> {
  await writeAtomic(taskPath(record.id), `${JSON.stringify(record, null, 2)}\n`);
}

/** The record in `<id>.json`. Throws an `Error` naming the file when `id` is no task id or the file is invalid. */
export async function readTask(id: string): Promise<TaskRecord> {
  const path = taskPath(id);
  if (!TASK_ID.test(id)) throw new Error(`${path}: ${id} is not a task id`);
  try {
    const record = JSON.parse(await readFile(path, "utf8")) as TaskRecord;
    if (record.id !== id) throw new Error(`id ${String(record.id)} is not the file's name`);
    return record;
  } catch (error) {
    throw new Error(`${path}: ${errorText(error)}`);
  }
}

/** Every task, oldest first; only those of `repo` when given. Files that are no valid task record are skipped. */
export async function listTasks(repo?: string): Promise<TaskRecord[]> {
  const records: TaskRecord[] = [];
  for (const name of await ifMissing(readdir(tasksDir()), [])) {
    if (!name.endsWith(".json")) continue;
    const record = await readTask(name.slice(0, -".json".length)).catch(() => undefined);
    if (record !== undefined && (repo === undefined || record.repo === repo)) records.push(record);
  }
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The record of the task whose Pi session is `sessionId`. */
export async function sessionTask(sessionId: string): Promise<TaskRecord | undefined> {
  return (await listTasks()).find((task) => task.sessionId === sessionId);
}

/** Removes the record, its runner log and its lock. The worktree, branch and session file stay. */
export async function removeTask(id: string): Promise<void> {
  await rm(taskPath(id), { force: true });
  await rm(taskLogPath(id), { force: true });
  await rm(taskLockPath(id), { force: true });
}

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

/** Whether process `pid` runs with `id` as one of its arguments: a runner's command line names what it runs. */
export async function runnerAlive(pid: number | null, id: string): Promise<boolean> {
  if (pid === null) return false;
  return (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).split("\0").includes(id);
}

/** The runner holding the lock file `path` (`runnerAlive` with `id`): its pid, else null. */
export async function lockRunner(path: string, id: string): Promise<number | null> {
  const pid = Number((await readFile(path, "utf8").catch(() => "")).split(" ")[0]);
  return pid > 0 && (await runnerAlive(pid, id)) ? pid : null;
}

/** Takes the task's lock for this process. Throws a `busy` FactoryError of one sentence while a live process holds it. */
export async function lockTask(id: string): Promise<void> {
  await lockFile(taskLockPath(id), `task ${id.slice(0, 8)} is busy: another factory action or its runner holds it, try again once it has ended`);
}

/** Takes the lock file `path` for this process (a task's, a wave's). Throws the FactoryError `busy` (code `busy`) while a live process holds it. */
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

/** Runs `act` holding the lock file `path`, waiting up to `waitMs` for another holder; then the FactoryError `busy`. */
export async function withLock<T>(path: string, busy: string, waitMs: number, act: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await lockFile(path, busy);
      break;
    } catch (error) {
      if (!isBusy(error) || Date.now() > deadline) throw error;
      await Bun.sleep(20);
    }
  }
  try {
    return await act();
  } finally {
    await unlockFile(path);
  }
}

/** Passes the lock this process holds to the process `pid` (a runner it spawned), which removes it when it exits. */
export async function handTaskLock(id: string, pid: number): Promise<void> {
  await handLockFile(taskLockPath(id), pid);
}

/** `handTaskLock` by the lock file's path (a runner knows only `FACTORY_TASK_LOCK`); only while this process holds it. */
export async function handLockFile(path: string, pid: number): Promise<void> {
  const text = await readFile(path, "utf8").catch(() => "");
  if (text.split(" ")[0] === String(process.pid)) await writeAtomic(path, await lockOwner(pid));
}

/** Removes the task's lock if this process holds it; a lock handed to a runner stays. */
export async function unlockTask(id: string): Promise<void> {
  await unlockFile(taskLockPath(id));
}

/** Removes the lock file `path` if this process holds it. */
export async function unlockFile(path: string): Promise<void> {
  const text = await readFile(path, "utf8").catch(() => "");
  if (text.split(" ")[0] === String(process.pid)) await rm(path, { force: true });
}
