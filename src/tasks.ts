/**
 * The factory's own list of tasks, kept outside any Pi session.
 *
 * - Provides `TaskRecord`, one JSON file per task in `<factoryHome>/tasks/<id>.json`, written atomically
 *   (`writeTask`), read back (`listTasks`) and removed with its runner log and lock (`removeTask`). Only a file named
 *   after the task id in it, of the shape `crypto.randomUUID` makes, counts as a task
 * - Provides the task lock `<id>.lock` (`lockTask`, `handTaskLock`, `unlockTask`): whoever checks a task's state and
 *   then acts on it (spawns a runner, deletes the task) holds it, and a spawned runner holds it until it exits. The
 *   file holds `<pid> <start time>` of its holder; a holder that no longer runs (`hostLiveness`) leaves a stale lock
 *   the next `lockTask` takes over; a lock a live process holds is a `TaskBusyError`
 */
import { link, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { hostLiveness, procStart } from "./queue.ts";
import { factoryHome } from "./settings.ts";
import { errorText, ifMissing, writeAtomic } from "./util.ts";

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

/** `lockTask` found the lock held by a live process. */
export class TaskBusyError extends Error {}

async function lockOwner(pid: number): Promise<string> {
  return `${pid} ${(await procStart(pid)) ?? "0"}\n`;
}

/** Whether the lock file's holder still runs; a missing or unreadable file has none. */
export async function lockHeld(path: string): Promise<boolean> {
  const text = await readFile(path, "utf8").catch(() => "");
  const [pid = "", start = ""] = text.trim().split(" ");
  return pid !== "" && (await hostLiveness(Number(pid), start));
}

/** Takes the task's lock for this process. Throws a `TaskBusyError` of one sentence while a live process holds it. */
export async function lockTask(id: string): Promise<void> {
  await lockFile(taskLockPath(id), `task ${id.slice(0, 8)} is busy: another factory action or its runner holds it, try again once it has ended`);
}

/** Takes the lock file `path` for this process (a task's, a wave's). Throws a `TaskBusyError` `busy` while a live process holds it. */
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
  throw new TaskBusyError(busy);
}

/** Runs `act` holding the lock file `path`, waiting up to `waitMs` for another holder; then a `TaskBusyError` `busy`. */
export async function withLock<T>(path: string, busy: string, waitMs: number, act: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await lockFile(path, busy);
      break;
    } catch (error) {
      if (!(error instanceof TaskBusyError) || Date.now() > deadline) throw error;
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

/** `handTaskLock` by the lock file's path (a runner knows only `FACTORY_TASK_LOCK`). */
export async function handLockFile(path: string, pid: number): Promise<void> {
  await writeAtomic(path, await lockOwner(pid));
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
