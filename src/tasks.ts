/**
 * The factory's own list of tasks, kept outside any Pi session: one JSON file per task, `<factoryHome>/tasks/<id>.json`.
 * - The task lock `<id>.lock` (`lock.ts`): whoever checks a task's state and then acts on it holds it, and a spawned
 *   runner holds it until it exits
 */
import { readdir, readFile, rm } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { lockFile } from "./lock.ts";
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
   * The `/factory start ...` command `launchTask` sent; a retry of a task without a state sends it again. Once Pi ran,
   * the session's first user message holds the same text.
   */
  start: string;
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

/** Every task record by its id. */
export async function tasksById(): Promise<Map<string, TaskRecord>> {
  return new Map((await listTasks()).map((record) => [record.id, record]));
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

/** Takes the task's lock for this process. Throws a `busy` FactoryError of one sentence while a live process holds it. */
export async function lockTask(id: string): Promise<void> {
  await lockFile(taskLockPath(id), `task ${id.slice(0, 8)} is busy: another factory action or its runner holds it, try again once it has ended`);
}
