/**
 * The archive of a wave's or task's files (contract archive-1): its log, reviews, coder sessions and scouts copied
 * out before anything is deleted, so its history and cost survive a removal. A copy: the live files stay where they are.
 *
 * - A wave: `<archive root>/<tag>/<first 8 of the id>/` with `wave.jsonl`, `reviews/`, `tasks/<key>.jsonl`,
 *   `scouts/<kind>-<id>/` (the wave's and its tasks' scout directories) and `index.json`
 * - A task outside a wave: `<archive root>/tasks/<tag>/<first 8 of the id>/` with `session.jsonl`, `scouts/task-<id>/`
 *   and `index.json`
 *
 * Every file is written to a temp name and renamed, its mtime kept; a file whose size and mtime match is left alone,
 * so archiving again replaces only what grew. Pruning is deleting a directory under the root: nothing refers to it.
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { sessionFilePath } from "./runner.ts";
import { addScoutUsage, callerKey, readScout, scoutsDir, type ScoutCaller, type ScoutUsage } from "./scouts.ts";
import { factoryHome } from "./settings.ts";
import { readTask, type TaskRecord } from "./tasks.ts";
import { wavePath, waveReviewsDir } from "./wave-poke.ts";
import { isRecord } from "./util.ts";
import type { WaveFold } from "./waves.ts";

const SHORT = 8;

/** Where memory-store keeps its stores: `MEMORY_STORE_ROOT`, else `~/.pi/memory_store`. */
export function memoryStoreRoot(): string {
  return process.env.MEMORY_STORE_ROOT || join(homedir(), ".pi", "memory_store");
}

/** `<store root>/<plan>/run/sessions` when the plan's store directory exists, else `<factory home>/archive`. */
export function archiveRoot(plan: string | null): string {
  if (plan !== null && plan !== "") {
    const store = join(memoryStoreRoot(), plan);
    if (existsSync(store)) return join(store, "run", "sessions");
  }
  return join(factoryHome(), "archive");
}

/** The archive directory of a wave. */
export function waveArchiveDir(fold: Pick<WaveFold, "id" | "tag" | "plan">): string {
  return join(archiveRoot(fold.plan), fold.tag, fold.id.slice(0, SHORT));
}

/** The archive directory of a task outside a wave. */
export function taskArchiveDir(record: Pick<TaskRecord, "id" | "tag" | "plan">): string {
  return join(archiveRoot(record.plan), "tasks", record.tag, record.id.slice(0, SHORT));
}

/** Copies `src` to `dest` (temp name, rename, mtime kept) unless `dest` has its size and mtime. False: `src` is gone. */
async function copyKept(src: string, dest: string): Promise<boolean> {
  let from;
  try {
    from = await stat(src);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!from.isFile()) return false;
  const to = await stat(dest).catch(() => undefined);
  if (to !== undefined && to.size === from.size && Math.abs(to.mtimeMs - from.mtimeMs) < 1) return true;
  await mkdir(dirname(dest), { recursive: true });
  const temp = `${dest}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await copyFile(src, temp);
    await utimes(temp, from.atime, from.mtime);
    await rename(temp, dest);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return true;
}

/** Every regular file under `src`, copied to the same place under `dest`. A missing `src` copies nothing. */
async function copyTree(src: string, dest: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(src, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await copyTree(join(src, entry.name), join(dest, entry.name));
    else if (entry.isFile()) await copyKept(join(src, entry.name), join(dest, entry.name));
  }
}

/** Writes `index.json` unless it holds the same fields already (its `archivedAt` aside): again is a no-op. */
async function writeIndex(dir: string, fields: Record<string, unknown>): Promise<void> {
  const path = join(dir, "index.json");
  try {
    const { archivedAt: _at, ...old } = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    if (JSON.stringify(old) === JSON.stringify(fields)) return;
  } catch {
    // None yet, or unreadable: written anew.
  }
  const { id, tag, repo, plan, origin, ...rest } = fields;
  const index = { id, tag, repo, plan, origin, archivedAt: new Date().toISOString(), ...rest };
  await mkdir(dir, { recursive: true });
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** Pi's sessions folder of a repository, as `launch.ts` names it: the fallback for a task whose record is gone. */
function sessionsDirOf(repo: string): string {
  return join(factoryHome(), "sessions", `--${resolve(repo).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

async function copyScouts(caller: ScoutCaller, dest: string): Promise<void> {
  await copyTree(join(scoutsDir(), callerKey(caller)), join(dest, "scouts", callerKey(caller)));
}

/**
 * Archives a wave: its log, its reviews, each started task's session file and scouts, its own scouts and an index.
 * Answers the archive directory. Throws on any failure: the callers decide (a merge logs it, a removal refuses).
 */
export async function archiveWave(fold: WaveFold): Promise<string> {
  const dir = waveArchiveDir(fold);
  await mkdir(dir, { recursive: true });
  await copyKept(wavePath(fold.id), join(dir, "wave.jsonl"));
  await copyTree(waveReviewsDir(fold.id), join(dir, "reviews"));
  const tasks: Record<string, { id: string; sessionId: string | null }> = {};
  for (const task of fold.tasks) {
    const taskId = task.taskId ?? null;
    if (taskId === null) continue;
    const record = await readTask(taskId).catch(() => undefined);
    const sessionId = record?.sessionId ?? task.sessionId;
    tasks[task.key] = { id: taskId, sessionId };
    if (sessionId !== null) {
      const session = await sessionFilePath(record?.sessionDir ?? sessionsDirOf(fold.repo), sessionId);
      if (session !== undefined) await copyKept(session, join(dir, "tasks", `${task.key}.jsonl`));
    }
    await copyScouts({ kind: "task", id: taskId }, dir);
  }
  await copyScouts({ kind: "wave", id: fold.id }, dir);
  await writeIndex(dir, { id: fold.id, tag: fold.tag, repo: fold.repo, plan: fold.plan, origin: fold.origin, tasks });
  return dir;
}

/** Archives a task outside a wave: its session file, its scouts and an index. Answers the archive directory. */
export async function archiveTask(record: TaskRecord): Promise<string> {
  const dir = taskArchiveDir(record);
  await mkdir(dir, { recursive: true });
  const session = await sessionFilePath(record.sessionDir, record.sessionId);
  if (session !== undefined) await copyKept(session, join(dir, "session.jsonl"));
  await copyScouts({ kind: "task", id: record.id }, dir);
  await writeIndex(dir, { id: record.id, tag: record.tag, repo: record.repo, plan: record.plan, origin: record.origin, sessionId: record.sessionId });
  return dir;
}

/** What `index.json` of an archived wave says (`archiveWave`). */
export interface WaveArchiveIndex {
  id: string;
  tag: string;
  repo: string;
  plan: string | null;
  origin: string | null;
  archivedAt: string;
  tasks: Record<string, { id: string; sessionId: string | null }>;
}

/** How deep plan names nest under the store root (`team/plan`) while archive roots are looked for. */
const STORE_DEPTH = 3;

async function subdirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Every archive root there is: the factory home's, and `<store>/run/sessions` of every store that has one. */
export async function archiveRoots(): Promise<string[]> {
  const roots = [join(factoryHome(), "archive")];
  const walk = async (dir: string, depth: number): Promise<void> => {
    for (const name of await subdirs(dir)) {
      const store = join(dir, name);
      if ((await stat(join(store, "run", "sessions")).catch(() => undefined))?.isDirectory()) roots.push(join(store, "run", "sessions"));
      if (depth < STORE_DEPTH && name !== "run") await walk(store, depth + 1);
    }
  };
  await walk(memoryStoreRoot(), 1);
  return roots;
}

function parseWaveIndex(raw: unknown): WaveArchiveIndex | undefined {
  if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.tag !== "string" || typeof raw.repo !== "string" || !isRecord(raw.tasks)) return undefined;
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  return { id: raw.id, tag: raw.tag, repo: raw.repo, plan: text(raw.plan), origin: text(raw.origin), archivedAt: text(raw.archivedAt) ?? "", tasks: raw.tasks as WaveArchiveIndex["tasks"] };
}

/**
 * Every archived wave: its directory and its index, those of all archive roots. A directory with `index.json` and
 * `wave.jsonl` is one; an unreadable index is skipped. A wave archived under two roots (its plan's store appeared
 * later) counts once, the most recently archived.
 */
export async function archivedWaveDirs(): Promise<{ dir: string; index: WaveArchiveIndex }[]> {
  const found = new Map<string, { dir: string; index: WaveArchiveIndex }>();
  const walk = async (dir: string): Promise<void> => {
    const names = await readdir(dir).catch(() => [] as string[]);
    if (names.includes("index.json")) {
      if (!names.includes("wave.jsonl")) return;
      const index = parseWaveIndex(await readFile(join(dir, "index.json"), "utf8").then(JSON.parse, () => undefined));
      const known = index && found.get(index.id);
      if (index && (known === undefined || known.index.archivedAt < index.archivedAt)) found.set(index.id, { dir, index });
      return;
    }
    for (const name of await subdirs(dir)) await walk(join(dir, name));
  };
  for (const root of await archiveRoots()) await walk(root);
  return [...found.values()];
}

/** The unrounded usage of the caller's scouts as archived under `dir` (`scouts/<kind>-<id>/`), null without one. */
export async function archivedScoutUsage(dir: string, caller: ScoutCaller): Promise<ScoutUsage | null> {
  const callerDir = join(dir, "scouts", callerKey(caller));
  let sum: ScoutUsage | null = null;
  for (const name of (await subdirs(callerDir)).sort()) {
    if (name.includes(".")) continue;
    sum = addScoutUsage(sum, await readScout(join(callerDir, name)).then(({ fold }) => fold.usage, () => null));
  }
  return sum;
}
