/**
 * Files in step (sync/1): a merge onto a branch reaches the running tasks below it early, at the end of their coder
 * turn, instead of at their own merge.
 *
 * - Marks: when a task merges into its wave's branch (`taskLanded`, from `merge.ts`), and when a wave merges into its
 *   target (`waveLanded`, from `wave-runner.ts`), every task below that branch in `running`, `waiting_answer`,
 *   `merging`, `waiting_approve` or `reviewing` (`MARKED_STATES`: a coder turn may still come) gets a due mark in its sync log
 *   `<factoryHome>/sync/<task id>.jsonl` (append-only: `due` lines, and `done` lines that consume them). For a wave's
 *   merge, the branch of every other `building` wave on the same target is rebased onto it first (`rebaseBranch`:
 *   plumbing, no worktree; a conflict or a checkout of it leaves it as it is), then its tasks marked
 * - The sync (`syncTask`, from the task's own Pi at the end of a coder turn): the worktree's snapshot (HEAD, its tree with
 *   untracked files, the index bytes, the ref `refs/factory/sync/<task id>`), a three-way merge of the task's whole
 *   change (base: where the task sat on the branch the first mark found) onto the branch's tip, written into the
 *   worktree with conflict markers left in place, the branch moved to the tip. The task's change lies uncommitted on
 *   the tip: its base is the tip from then on. Any failure but a content conflict restores HEAD, worktree and index
 * - Marks, rewrites and syncs hold the merge lock (`<git common dir>/factory-merge.lock`), the one a merge moves its
 *   target under. A sync consumes its marks also when it fails
 * - Nothing piles up: a round that passed its gates drops the snapshot ref and the consumed lines of the log
 *   (`syncRoundPassed`); a removed task takes both with it (`removeSyncState`)
 */
import { existsSync, realpathSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { assertCheckoutReady, git, nulList, primaryCheckout, snapshotTree, stageTree, withScratchIndex } from "./git.ts";
import type { Exec } from "./run.ts";
import { lastFactoryState, sessionFilePath } from "./runner.ts";
import { sessionFiles } from "./session-files.ts";
import { factoryHome } from "./settings.ts";
import { FEEDBACK_TYPE, type Draft } from "./state.ts";
import { listTasks, type TaskRecord } from "./tasks.ts";
import { errorText, isRecord } from "./util.ts";
import { foldWave, listWaves, type WaveFile } from "./waves.ts";

/** How long a mark, a rewrite or a sync waits for the merge lock. */
const LOCK_WAIT_S = 60;
/** The custom type of the coder's follow-up and of the session entry of a sync. */
export const SYNC_TYPE = "factory-sync";
const SNAPSHOT_MESSAGE = "factory: the worktree before a sync";

/** One commit a merge landed: its subject and the files it changed. */
export interface LandedCommit {
  subject: string;
  files: string[];
}

/** A due sync: `branch` moved from `from` to `to` with `commits`. */
export interface DueMark {
  branch: string;
  from: string;
  to: string;
  commits: LandedCommit[];
}

export function syncLogPath(taskId: string): string {
  return join(factoryHome(), "sync", `${taskId}.jsonl`);
}

/** The ref that keeps the worktree's snapshot of the task's last sync. */
export function snapshotRef(taskId: string): string {
  return `refs/factory/sync/${taskId}`;
}

function parseMark(raw: Record<string, unknown>): DueMark | undefined {
  const { branch, from, to, commits } = raw;
  if (typeof branch !== "string" || typeof from !== "string" || typeof to !== "string" || !Array.isArray(commits)) return undefined;
  const parsed = commits.flatMap((commit): LandedCommit[] =>
    isRecord(commit) && typeof commit.subject === "string" && Array.isArray(commit.files) ? [{ subject: commit.subject, files: commit.files.filter((file): file is string => typeof file === "string") }] : [],
  );
  return { branch, from, to, commits: parsed };
}

/** The marks of the task's sync log no `done` line consumed yet, oldest first, and how many `due` lines it holds. */
async function readMarks(taskId: string): Promise<{ marks: DueMark[]; ats: (string | undefined)[]; upTo: number }> {
  const text = await readFile(syncLogPath(taskId), "utf8").catch(() => "");
  const due: (DueMark | undefined)[] = [];
  const times: (string | undefined)[] = [];
  let consumed = 0;
  for (const line of text.split("\n")) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(raw)) continue;
    if (raw.kind === "due") {
      due.push(parseMark(raw));
      times.push(typeof raw.at === "string" ? raw.at : undefined);
    }
    else if (raw.kind === "done" && typeof raw.due === "number") consumed = Math.max(consumed, raw.due);
  }
  const kept = due.flatMap((mark, index) => (index >= consumed && mark !== undefined ? [{ mark, at: times[index] }] : []));
  return { marks: kept.map((entry) => entry.mark), ats: kept.map((entry) => entry.at), upTo: due.length };
}

/** The marks of the task's sync log no `done` line consumed yet, oldest first. */
export async function pendingMarks(taskId: string): Promise<DueMark[]> {
  return (await readMarks(taskId)).marks;
}

async function appendLog(taskId: string, line: Record<string, unknown>): Promise<void> {
  await mkdir(join(factoryHome(), "sync"), { recursive: true });
  await appendFile(syncLogPath(taskId), `${JSON.stringify(line)}\n`, "utf8");
}

/** Consumes the first `upTo` `due` lines of the task's sync log. */
async function consume(taskId: string, upTo: number): Promise<void> {
  await appendLog(taskId, { kind: "done", due: upTo, at: new Date().toISOString() });
}

/** Removes a task's sync log and its snapshot ref in `repo` (with the task). Never throws. */
export async function removeSyncState(exec: Exec, repo: string, taskId: string): Promise<void> {
  await rm(syncLogPath(taskId), { force: true }).catch(() => undefined);
  await exec(["git", "update-ref", "-d", snapshotRef(taskId)], { cwd: repo }).catch(() => undefined);
}

/**
 * A round of the task passed its gates (worktree `root`): its snapshot ref goes, and its sync log keeps only the `due`
 * lines no `done` line consumed (none left: the log goes). Never throws.
 */
export async function syncRoundPassed(exec: Exec, root: string, taskId: string): Promise<void> {
  await dropSnapshot(exec, root, taskId).catch(() => undefined);
  try {
    const path = syncLogPath(taskId);
    if (!existsSync(path)) return;
    const { gitDir } = await primaryCheckout(exec, root);
    await withMergeLock(gitDir, async () => {
      const { marks, ats } = await readMarks(taskId);
      if (marks.length === 0) return void (await rm(path, { force: true }));
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, marks.map((mark, index) => `${JSON.stringify({ kind: "due", ...mark, at: ats[index] })}\n`).join(""), "utf8");
      await rename(temp, path);
    });
  } catch {
    // Kept as it is: the next passed round or the task's removal takes it.
  }
}

/**
 * Takes the merge lock of the repository whose git common dir is `gitDir` and holds it until the returned release is
 * called: a `flock` child that holds it while its stdin is open, so a dead holder lets it go.
 */
export async function holdMergeLock(gitDir: string): Promise<() => Promise<void>> {
  const lock = join(gitDir, "factory-merge.lock");
  const child = Bun.spawn(["flock", "-w", String(LOCK_WAIT_S), lock, "sh", "-c", "echo locked; read _"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const reader = child.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  if (value === undefined || !new TextDecoder().decode(value).startsWith("locked")) {
    child.kill();
    await child.exited;
    throw new Error(`the merge lock ${lock} stayed taken for ${LOCK_WAIT_S} s`);
  }
  return async () => {
    child.stdin.end();
    await child.exited;
  };
}

async function withMergeLock<T>(gitDir: string, act: () => Promise<T>): Promise<T> {
  const release = await holdMergeLock(gitDir);
  try {
    return await act();
  } finally {
    await release();
  }
}

/** The commits of `before..after`, oldest first, with the files each changed. */
export async function landedCommits(exec: Exec, repo: string, before: string, after: string): Promise<LandedCommit[]> {
  const log = await git(exec, repo, ["-c", "core.quotePath=false", "log", "--no-renames", "--format=%x1e%s", "--name-only", `${before}..${after}`]);
  return log
    .split("\x1e")
    .filter((chunk) => chunk.trim() !== "")
    .map((chunk) => {
      const [subject = "", ...files] = chunk.split("\n");
      return { subject, files: files.filter((file) => file !== "") };
    })
    .reverse();
}

function samePath(a: string, b: string): boolean {
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  return real(a) === real(b);
}

/** The states whose task is marked when a change lands below it: a coder turn may still follow, and its sync names it. */
export const MARKED_STATES: readonly string[] = ["running", "waiting_answer", "merging", "waiting_approve", "reviewing"];

/** The tasks of the wave `waveId` whose last state is one of `MARKED_STATES`, but the one on `exceptBranch`. */
async function markedTasks(waveId: string, exceptBranch?: string): Promise<TaskRecord[]> {
  const marked: TaskRecord[] = [];
  for (const record of await listTasks()) {
    if (record.wave !== waveId || record.branch === exceptBranch) continue;
    const state = (await lastFactoryState(record.sessionDir, record.sessionId).catch(() => undefined))?.state;
    if (state !== undefined && MARKED_STATES.includes(state)) marked.push(record);
  }
  return marked;
}

async function markTasks(tasks: TaskRecord[], mark: DueMark): Promise<void> {
  for (const task of tasks) await appendLog(task.id, { kind: "due", ...mark, at: new Date().toISOString() });
}

/** The open waves of the repository at `primary`, folded. */
async function openWaves(primary: string): Promise<{ file: WaveFile; stage: string; branch: string }[]> {
  const open: { file: WaveFile; stage: string; branch: string }[] = [];
  for (const file of await listWaves()) {
    if (!samePath(file.declaration.repo, primary)) continue;
    const { stage, branch } = foldWave(file.declaration, file.events);
    // A queued wave has no branch yet: no tasks running, nothing to rebase.
    if (branch !== null && stage !== "merged" && stage !== "cancelled") open.push({ file, stage, branch });
  }
  return open;
}

/**
 * A task merged into `target` (`before` to `after`): when `target` is an open wave's branch, the wave's other running
 * tasks get a due mark. A target that is no wave's branch marks nothing.
 */
export async function taskLanded(exec: Exec, root: string, taskBranch: string, target: string, before: string, after: string): Promise<void> {
  const { primary, gitDir } = await primaryCheckout(exec, root);
  const waves = (await openWaves(primary)).filter(({ branch }) => branch === target);
  if (waves.length === 0) return;
  const tasks = (await Promise.all(waves.map(({ file }) => markedTasks(file.declaration.id, taskBranch)))).flat();
  if (tasks.length === 0) return;
  const commits = await landedCommits(exec, primary, before, after);
  await withMergeLock(gitDir, () => markTasks(tasks, { branch: target, from: before, to: after, commits }));
}

/** Whether `ancestor` is an ancestor of (or is) `commit`. */
async function isAncestor(exec: Exec, cwd: string, ancestor: string, commit: string): Promise<boolean> {
  const result = await exec(["git", "merge-base", "--is-ancestor", ancestor, commit], { cwd });
  if (result.exitCode === 0 || result.exitCode === 1) return result.exitCode === 0 && !result.killed;
  throw new Error(`git merge-base --is-ancestor ${ancestor} ${commit}: ${result.output.trim()}`);
}

/** `git merge-tree --write-tree` of `theirs` onto `ours` from `base`: the tree and the conflicting paths. */
export async function mergeTrees(exec: Exec, cwd: string, base: string, ours: string, theirs: string): Promise<{ tree: string; conflicts: string[] }> {
  const result = await exec(["git", "merge-tree", "--write-tree", "-z", "--name-only", "--no-messages", `--merge-base=${base}`, ours, theirs], { cwd, maxStdoutChars: 4_000_000 });
  if (result.killed || (result.exitCode !== 0 && result.exitCode !== 1)) throw new Error(`git merge-tree: ${result.output.trim()}`);
  const [tree = "", ...paths] = nulList(result.stdout);
  return { tree, conflicts: result.exitCode === 1 ? [...new Set(paths)] : [] };
}

/**
 * The branch `branch` replayed onto `target`'s tip, one commit at a time with plumbing (author and message kept):
 * `{ old, new }`, or why it stays (`skip`): on the tip already, a merge commit, a conflict, checked out somewhere.
 * Writes no ref.
 */
export async function rebaseBranch(exec: Exec, repo: string, branch: string, target: string): Promise<{ old: string; new: string } | { skip: string }> {
  const worktrees = await git(exec, repo, ["worktree", "list", "--porcelain"]);
  if (worktrees.split("\n").includes(`branch refs/heads/${branch}`)) return { skip: `${branch} is checked out` };
  const old = await git(exec, repo, ["rev-parse", `refs/heads/${branch}`]);
  const tip = await git(exec, repo, ["rev-parse", `refs/heads/${target}`]);
  if (await isAncestor(exec, repo, tip, old)) return { skip: `${branch} is on ${target} already` };
  const base = await git(exec, repo, ["merge-base", old, tip]);
  if ((await git(exec, repo, ["rev-list", "--min-parents=2", `${base}..${old}`])) !== "") return { skip: `${branch} holds a merge commit` };
  let parent = tip;
  for (const commit of (await git(exec, repo, ["rev-list", "--reverse", `${base}..${old}`])).split("\n").filter(Boolean)) {
    const merged = await mergeTrees(exec, repo, `${commit}^`, parent, commit);
    if (merged.conflicts.length > 0) return { skip: `${branch} conflicts with ${target} on ${merged.conflicts.join(", ")}` };
    const [name = "", email = "", date = "", ...message] = (await git(exec, repo, ["show", "-s", "--format=%an%n%ae%n%ad%n%B", "--date=raw", commit])).split("\n");
    const env = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date };
    parent = await git(exec, repo, ["commit-tree", "--no-gpg-sign", merged.tree, "-p", parent, "-m", message.join("\n")], env);
  }
  return { old, new: parent };
}

/**
 * A wave merged into `target` (`before` to `after`): the branch of every other `building` wave of the repository on
 * `target` is rebased onto it, and that wave's running tasks get a due mark from the old branch tip to the new one with
 * the commits that landed on `target`. Returns what it did, for the wave runner's log.
 */
export async function waveLanded(exec: Exec, repo: string, waveId: string, target: string, before: string, after: string): Promise<string[]> {
  const { primary, gitDir } = await primaryCheckout(exec, repo);
  const waves = (await openWaves(primary)).filter(({ file, stage }) => file.declaration.id !== waveId && file.declaration.target === target && stage === "building");
  if (waves.length === 0) return [];
  const commits = await landedCommits(exec, primary, before, after);
  const done: string[] = [];
  for (const { file, branch } of waves) {
    const { id } = file.declaration;
    try {
      const rebased = await rebaseBranch(exec, primary, branch, target);
      if ("skip" in rebased) {
        done.push(`wave ${id.slice(0, 8)} stays: ${rebased.skip}`);
        continue;
      }
      // The new branch and the marks in one hold: a sync sees both or neither.
      const marked = await withMergeLock(gitDir, async () => {
        await git(exec, primary, ["update-ref", "-m", `factory: rebase ${branch} onto ${target}`, `refs/heads/${branch}`, rebased.new, rebased.old]);
        const tasks = await markedTasks(id);
        await markTasks(tasks, { branch, from: rebased.old, to: rebased.new, commits });
        return tasks.length;
      });
      done.push(`wave ${id.slice(0, 8)}: ${branch} rebased onto ${target}, ${marked} ${marked === 1 ? "task" : "tasks"} to sync`);
    } catch (error) {
      done.push(`wave ${id.slice(0, 8)} stays: ${errorText(error)}`);
    }
  }
  return done;
}

/** How a sync ended. `none`: nothing was due. `synced`: the worktree is on `tip` (`snapshot` null when it was already). */
export type SyncOutcome =
  | { kind: "none" }
  | { kind: "synced"; marks: DueMark[]; tip: string; snapshot: string | null; conflicts: string[] }
  | { kind: "failed"; marks: DueMark[]; error: string; restored: boolean };

class SyncError extends Error {
  constructor(
    message: string,
    readonly restored: boolean,
  ) {
    super(message);
  }
}

/** The worktree back to HEAD `head`, tree `tree` and the index bytes `index` (null: there was no index file). */
async function restore(exec: Exec, root: string, branch: string, head: string, tree: string, indexPath: string, index: Buffer | null): Promise<void> {
  await git(exec, root, ["update-ref", "-m", "factory: sync restored", `refs/heads/${branch}`, head]);
  await withScratchIndex(exec, root, async (env) => {
    const now = await stageTree(exec, root, env);
    if (now !== tree) await git(exec, root, ["read-tree", "-m", "-u", now, tree], env);
  });
  if (index === null) await rm(indexPath, { force: true });
  else await writeFile(indexPath, index);
}

async function applySync(exec: Exec, root: string, taskId: string, branch: string, target: string, from: string): Promise<{ tip: string; snapshot: string | null; conflicts: string[] }> {
  try {
    await assertCheckoutReady(exec, root, branch);
  } catch (error) {
    throw new SyncError(errorText(error), true);
  }
  const head = await git(exec, root, ["rev-parse", "HEAD"]);
  const tip = await git(exec, root, ["rev-parse", `refs/heads/${target}`]);
  if (await isAncestor(exec, root, tip, head)) return { tip: head, snapshot: null, conflicts: [] };
  const indexPath = await git(exec, root, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  const index = existsSync(indexPath) ? await readFile(indexPath) : null;
  const tree = await snapshotTree(exec, root);
  const snapshot = await git(exec, root, ["commit-tree", "--no-gpg-sign", tree, "-p", head, "-m", SNAPSHOT_MESSAGE]);
  await git(exec, root, ["update-ref", "-m", "factory: sync snapshot", snapshotRef(taskId), snapshot]);
  // Where the task sat on the branch before it moved: the old tip of a rewritten branch finds it in the old history.
  const known = (await exec(["git", "cat-file", "-e", `${from}^{commit}`], { cwd: root })).exitCode === 0;
  const base = await git(exec, root, ["merge-base", head, known ? from : tip]);
  const merged = await mergeTrees(exec, root, base, tip, snapshot);
  try {
    await withScratchIndex(exec, root, async (env) => {
      if ((await stageTree(exec, root, env)) !== tree) throw new Error("the worktree changed during the sync");
      await git(exec, root, ["read-tree", "-m", "-u", tree, merged.tree], env);
    });
    await git(exec, root, ["update-ref", "-m", `factory: sync onto ${target}`, `refs/heads/${branch}`, tip, head]);
    await git(exec, root, ["reset", "-q"]);
  } catch (error) {
    try {
      await restore(exec, root, branch, head, tree, indexPath, index);
    } catch (undo) {
      throw new SyncError(`${errorText(error)}; the restore failed too (the snapshot is ${snapshotRef(taskId)}): ${errorText(undo)}`, false);
    }
    throw new SyncError(errorText(error), true);
  }
  return { tip, snapshot, conflicts: merged.conflicts };
}

/**
 * The due sync of the task `record` in its worktree `root` onto `target`: none when nothing is due. Consumes the marks
 * it read, also when it fails; a failure leaves the worktree as it was (`restored`).
 */
export async function syncTask(exec: Exec, root: string, record: Pick<TaskRecord, "id" | "branch">, target: string): Promise<SyncOutcome> {
  const due = await readMarks(record.id);
  if (due.marks.length === 0) return { kind: "none" };
  let outcome: SyncOutcome | undefined;
  try {
    const { gitDir } = await primaryCheckout(exec, root);
    await withMergeLock(gitDir, async () => {
      const { marks, upTo } = await readMarks(record.id);
      if (marks.length === 0) return void (outcome = { kind: "none" });
      try {
        outcome = { kind: "synced", marks, ...(await applySync(exec, root, record.id, record.branch, target, marks[0].from)) };
      } catch (error) {
        outcome = { kind: "failed", marks, error: errorText(error), restored: !(error instanceof SyncError) || error.restored };
      }
      await consume(record.id, upTo);
    });
  } catch (error) {
    if (outcome !== undefined) return outcome;
    // The lock was not had: nothing was touched, the marks go all the same.
    await consume(record.id, due.upTo).catch(() => undefined);
    return { kind: "failed", marks: due.marks, error: errorText(error), restored: true };
  }
  return outcome ?? { kind: "none" };
}

/** The coder's follow-up of a sync: the conflicting files first, then the changed files it has; null when it has none. */
export function syncFollowUp(outcome: Extract<SyncOutcome, { kind: "synced" }>, target: string, files: ReadonlySet<string>): { content: string; named: string[] } | null {
  const subjects = new Map<string, string[]>();
  for (const mark of outcome.marks) {
    for (const commit of mark.commits) {
      for (const file of commit.files) {
        const list = subjects.get(file) ?? [];
        if (!list.includes(commit.subject)) list.push(commit.subject);
        subjects.set(file, list);
      }
    }
  }
  const { conflicts } = outcome;
  const changed = [...subjects.keys()].filter((file) => files.has(file) && !conflicts.includes(file)).sort();
  if (conflicts.length === 0 && changed.length === 0) return null;
  const line = (file: string) => `- ${file}${subjects.has(file) ? `: ${subjects.get(file)?.join("; ")}` : ""}`;
  const parts = [`Sync: ${target} moved while you worked. Your worktree is now on its tip ${outcome.tip.slice(0, 12)}, your work carried over uncommitted.`];
  if (conflicts.length > 0) {
    parts.push(
      `These files conflict: both versions are in the file between conflict markers (<<<<<<< ${outcome.tip.slice(0, 12)}… is ${target}, >>>>>>> ${(outcome.snapshot ?? "").slice(0, 12)}… is yours). Resolve them first:\n${conflicts.map(line).join("\n")}`,
    );
  }
  if (changed.length > 0) parts.push(`Files you have read or edited that changed:\n${changed.map(line).join("\n")}`);
  parts.push("Re-read these before you go on.");
  return { content: parts.join("\n\n"), named: [...conflicts, ...changed] };
}

/** The files among `files` that still hold the conflict markers of the sync onto `tip` with the snapshot `snapshot`. */
export async function markersLeft(root: string, files: readonly string[], tip: string, snapshot: string): Promise<string[]> {
  const left: string[] = [];
  for (const file of files) {
    const text = await readFile(join(root, file), "utf8").catch(() => "");
    if (text.split("\n").some((line) => line.startsWith(`<<<<<<< ${tip}`) || line.startsWith(`>>>>>>> ${snapshot}`))) left.push(file);
  }
  return left;
}

/** The reminder when the sync's conflict markers are still in `files` at the end of the next turn. */
export function markersReminder(files: readonly string[]): string {
  return `The conflict markers of the sync are still in:\n${files.map((file) => `- ${file}`).join("\n")}\n\nResolve them (keep what both sides meant), then go on.`;
}

/** Deletes the task's snapshot ref, if there is one. */
export async function dropSnapshot(exec: Exec, root: string, taskId: string): Promise<void> {
  await exec(["git", "update-ref", "-d", snapshotRef(taskId)], { cwd: root });
}

/** The record of the task whose Pi session is `sessionId` (files in `sessionDir`), only for sessions the factory keeps. */
export async function sessionTask(sessionDir: string, sessionId: string): Promise<TaskRecord | undefined> {
  const sessions = join(factoryHome(), "sessions") + sep;
  if (!resolve(sessionDir).startsWith(sessions)) return undefined;
  return (await listTasks()).find((task) => task.sessionId === sessionId);
}

/** The session file of a task record. */
export function taskSessionFile(record: Pick<TaskRecord, "sessionDir" | "sessionId">): Promise<string | undefined> {
  return sessionFilePath(record.sessionDir, record.sessionId);
}

/** The conflicts a sync left in the worktree, until the coder resolved them or was told once more. */
export interface SyncLeft {
  files: string[];
  tip: string;
  snapshot: string;
  reminded: boolean;
}

/** A session entry or a follow-up of the sync, as `agent_before_settle` returns them. */
export type SyncDraft =
  | { type: "custom"; customType: typeof SYNC_TYPE; data: Record<string, unknown> }
  | { type: "custom_message"; customType: typeof SYNC_TYPE; content: string; display: true; details: Record<string, unknown> };

/** What the end of a coder turn does about syncs: the drafts, whether the coder goes on (no round), the conflicts left. */
export interface TurnEndSync {
  drafts: SyncDraft[];
  follow: boolean;
  left: SyncLeft | undefined;
}

const entryDraft = (data: Record<string, unknown>): SyncDraft => ({ type: "custom", customType: SYNC_TYPE, data });
const messageDraft = (content: string, details: Record<string, unknown>): SyncDraft => ({ type: "custom_message", customType: SYNC_TYPE, content, display: true, details });

/**
 * At the end of a coder turn of the task `record` (worktree `root`, merging into `target`), before its round: the due
 * sync, then its follow-up when the task has a changed file; with nothing due, the reminder (once) of conflict markers
 * the last sync left that are still there. At most one continuation per turn end without new marks. Never throws.
 */
export async function syncAtTurnEnd(exec: Exec, root: string, record: TaskRecord | undefined, target: string, left: SyncLeft | undefined): Promise<TurnEndSync> {
  if (record === undefined) return { drafts: [], follow: false, left };
  try {
    const outcome = await syncTask(exec, root, record, target);
    if (outcome.kind === "failed") {
      const drafts = [entryDraft({ kind: "failed", branch: target, error: outcome.error, restored: outcome.restored, marks: outcome.marks.length })];
      return { drafts, follow: false, left };
    }
    if (outcome.kind === "synced") {
      const sessionFile = await taskSessionFile(record);
      const files = sessionFile === undefined ? new Set<string>() : sessionFiles(sessionFile, root);
      // HEAD holds the tip already (`snapshot` null): the coder has every change in front of it, no message.
      const followUp = outcome.snapshot === null ? null : syncFollowUp(outcome, target, files);
      const data = { kind: "synced", branch: target, tip: outcome.tip, snapshot: outcome.snapshot, named: followUp?.named ?? [], conflicts: outcome.conflicts };
      const nowLeft = outcome.conflicts.length > 0 && outcome.snapshot !== null ? { files: outcome.conflicts, tip: outcome.tip, snapshot: outcome.snapshot, reminded: false } : undefined;
      if (followUp === null) return { drafts: [entryDraft(data)], follow: false, left: nowLeft };
      return { drafts: [entryDraft(data), messageDraft(followUp.content, { tip: outcome.tip, files: followUp.named, conflicts: outcome.conflicts })], follow: true, left: nowLeft };
    }
    if (left === undefined || left.reminded) return { drafts: [], follow: false, left };
    const still = await markersLeft(root, left.files, left.tip, left.snapshot);
    if (still.length === 0) return { drafts: [], follow: false, left: undefined };
    return { drafts: [entryDraft({ kind: "reminded", files: still }), messageDraft(markersReminder(still), { files: still })], follow: true, left: { ...left, files: still, reminded: true } };
  } catch {
    return { drafts: [], follow: false, left };
  }
}

/** The conflicts the last sync of a session branch left (from its `factory-sync` entries), if any. */
export function syncLeftOf(entries: Iterable<{ type: string }>): SyncLeft | undefined {
  let left: SyncLeft | undefined;
  for (const entry of entries) {
    const { customType, data } = entry as { customType?: unknown; data?: unknown };
    if (entry.type !== "custom" || customType !== SYNC_TYPE || !isRecord(data)) continue;
    if (data.kind === "synced") {
      const conflicts = Array.isArray(data.conflicts) ? data.conflicts.filter((file): file is string => typeof file === "string") : [];
      left = conflicts.length > 0 && typeof data.tip === "string" && typeof data.snapshot === "string" ? { files: conflicts, tip: data.tip, snapshot: data.snapshot, reminded: false } : undefined;
    } else if (data.kind === "reminded" && left) left = { ...left, reminded: true };
    else if (data.kind === "cleared") left = undefined;
  }
  return left;
}

/** Whether a round's drafts went past its hooks and gates: a later step judged it, or it passed. */
export function roundPassedGates(drafts: readonly Draft[], commitAsk: boolean): boolean {
  if (commitAsk) return true;
  return drafts.some((draft) => {
    if (draft.type === "custom_message") return draft.customType === FEEDBACK_TYPE && (draft.details.trigger === "review" || draft.details.trigger === "protected");
    return draft.customType === "factory-state" && ["merging", "waiting_approve", "reviewing", "done"].includes(draft.data.state);
  });
}
