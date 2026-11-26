/**
 * Files in step over real git repos in a temp dir: a wave's branch, task worktrees on it with sessions that say
 * `running` and name the files they read or edited, a sibling's merge (`mergeTask`, whose hook marks the syncs) and the
 * sync at the end of a coder turn (`syncAtTurnEnd`).
 */
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PROTECTED } from "./config.ts";
import { LOCKFILES, snapshotTree, taskBase, taskDiff, taskGit } from "./git.ts";
import { mergeTask } from "./merge.ts";
import { runCommand, type Exec } from "./run.ts";
import type { Settings, Task } from "./state.ts";
import { pendingMarks, roundPassedGates, snapshotRef, SYNC_TYPE, syncAtTurnEnd, syncLeftOf, waveLanded, type SyncDraft } from "./sync.ts";
import { writeTask, type TaskRecord } from "./tasks.ts";
import { appendWaveEvent, createWave } from "./waves.ts";

const savedEnv = { ...process.env };
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "factory-sync-test-")));
let caseDir: string;
let caseCount = 0;

beforeEach(() => {
  caseDir = join(scratch, `case-${++caseCount}`);
  mkdirSync(caseDir);
  Object.assign(process.env, {
    PI_CODING_AGENT_DIR: join(caseDir, "agent"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "test",
    GIT_COMMITTER_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_EMAIL: "test@example.com",
  });
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function write(cwd: string, file: string, text: string): void {
  writeFileSync(join(cwd, file), text);
}

function commit(cwd: string, file: string, text: string, message: string): string {
  write(cwd, file, text);
  git(cwd, "add", "-A");
  git(cwd, "commit", "--quiet", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

const RUN = randomBytes(2).toString("hex");
const waveId = (n: number) => `30000000-${RUN}-4000-8000-00000000000${n}`;
let taskCount = 0;

const settings = (branch: string): Settings => ({ branch, merge: "auto", maxRounds: 3, review: false, models: {} });
const noGates = { hooks: { after_create: [], after_code: [], after_merge: [] }, gates: [], merge_gates: [], task_gates: [], protected: DEFAULT_PROTECTED, lockfiles: LOCKFILES };

/** A repo on `main` with `shared.ts` and `other.ts`, a wave whose branch is off it, in `building`. */
async function waveRepo(n = 1, branch = "main-factory-w1"): Promise<{ repo: string; branch: string; wave: string }> {
  const repo = join(caseDir, "repo");
  if (!existsSync(repo)) {
    mkdirSync(repo);
    git(repo, "init", "--quiet", "-b", "main");
    write(repo, "shared.ts", "one\ntwo\nthree\n");
    write(repo, "other.ts", "other\n");
    git(repo, "add", "-A");
    git(repo, "commit", "--quiet", "-m", "init");
  }
  git(repo, "branch", branch, "main");
  const wave = waveId(n);
  await createWave({ id: wave, repo, tag: `factory/w${n}`, plan: null, title: `Wave ${n}`, request: "r", branch, target: "main", base: git(repo, "rev-parse", "main"), origin: null, createdAt: "2026-01-01T00:00:00.000Z", overrides: {} });
  return { repo, branch, wave };
}

const call = (name: string, path: string) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "x", name, arguments: { path } }] } });

/** A task of `wave` in a worktree off `branch`, its session `running` and naming `files` as read. */
async function runningTask(repo: string, wave: string, branch: string, files: string[], state = "running"): Promise<TaskRecord> {
  const n = ++taskCount;
  const worktree = join(caseDir, `task-${n}`);
  git(repo, "worktree", "add", "--quiet", "-b", `task-${n}`, worktree, branch);
  const sessionDir = join(caseDir, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  const sessionId = `session-${RUN}-${n}`;
  const lines = [{ type: "custom", customType: "factory-state", data: { state, round: 1, reason: "start" } }, ...files.map((file) => call("read", join(worktree, file)))];
  writeFileSync(join(sessionDir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  const record: TaskRecord = { id: `40000000-${RUN}-4000-8000-${String(n).padStart(12, "0")}`, repo, worktree, branch: `task-${n}`, title: `Task ${n}`, sessionId, sessionDir, createdAt: new Date(n).toISOString(), tag: "t", plan: null, wave, origin: null };
  await writeTask(record);
  return record;
}

/** Merges the worktree of `record` into `target` as a task's merge does (`mergeTask`, which marks the syncs). */
async function merge(record: TaskRecord, target: string, title: string): Promise<void> {
  const task: Task = { title, request: "r", settings: settings(target), ...(await taskGit(runCommand, record.worktree, target)) };
  const outcome = await mergeTask({ exec: runCommand, cleanup: runCommand, root: record.worktree, round: 1, task, config: noGates, intent: () => undefined });
  expect(outcome.result.kind).toBe("merged");
}

const messages = (drafts: SyncDraft[]) => drafts.filter((draft) => draft.type === "custom_message").map((draft) => (draft.type === "custom_message" ? draft.content : ""));

describe("a sibling's merge reaches a running task", () => {
  test("rebased at its turn's end, its work carried over, a message naming only its files", async () => {
    const { repo, branch, wave } = await waveRepo();
    const a = await runningTask(repo, wave, branch, ["shared.ts", "mine.ts"]);
    const b = await runningTask(repo, wave, branch, []);
    // A's work: a commit of its own, a tracked change, a staged file and an untracked one.
    commit(a.worktree, "mine.ts", "mine\n", "wip");
    write(a.worktree, "other.ts", "other, by a\n");
    write(a.worktree, "new.ts", "new\n");
    // B changes shared.ts (A read it) and theirs.ts (A has not).
    write(b.worktree, "shared.ts", "one\ntwo, by b\nthree\n");
    write(b.worktree, "theirs.ts", "theirs\n");
    await merge(b, branch, "feat: b changes shared");
    expect(await pendingMarks(a.id)).toHaveLength(1);
    expect(await pendingMarks(b.id)).toHaveLength(0);

    const tip = git(repo, "rev-parse", branch);
    const end = await syncAtTurnEnd(runCommand, a.worktree, a, branch, undefined);
    expect(end.follow).toBe(true);
    // No round: only sync entries, no `factory-round` or state.
    expect(end.drafts.every((draft) => draft.customType === SYNC_TYPE)).toBe(true);
    const [message] = messages(end.drafts);
    expect(message).toContain("- shared.ts: feat: b changes shared");
    expect(message).not.toContain("theirs.ts");
    expect(message).toContain("Re-read these before you go on.");

    expect(git(a.worktree, "rev-parse", "HEAD")).toBe(tip);
    expect(readFileSync(join(a.worktree, "shared.ts"), "utf8")).toBe("one\ntwo, by b\nthree\n");
    expect(readFileSync(join(a.worktree, "mine.ts"), "utf8")).toBe("mine\n");
    expect(readFileSync(join(a.worktree, "other.ts"), "utf8")).toBe("other, by a\n");
    expect(readFileSync(join(a.worktree, "new.ts"), "utf8")).toBe("new\n");
    expect(git(a.worktree, "status", "--porcelain")).toContain("?? new.ts");
    // The base is the new tip: the task's diff is its own change only, never the sibling's.
    const task: Task = { title: "a", request: "r", settings: settings(branch), branch: a.branch, mainBranch: branch, baseSha: tip };
    expect(await taskBase(runCommand, a.worktree, task)).toBe(tip);
    expect((await taskDiff(runCommand, a.worktree, tip)).paths.sort()).toEqual(["mine.ts", "new.ts", "other.ts"]);
    expect(git(repo, "rev-parse", snapshotRef(a.id))).not.toBe("");

    // Consumed: the next turn end does nothing.
    expect(await syncAtTurnEnd(runCommand, a.worktree, a, branch, end.left)).toEqual({ drafts: [], follow: false, left: undefined });
  });

  test("a task without the changed files is rebased without a message; a resting task is not marked", async () => {
    const { repo, branch, wave } = await waveRepo();
    const a = await runningTask(repo, wave, branch, ["mine.ts"]);
    const resting = await runningTask(repo, wave, branch, ["shared.ts"], "waiting_approve");
    const b = await runningTask(repo, wave, branch, []);
    write(a.worktree, "mine.ts", "mine\n");
    write(b.worktree, "shared.ts", "changed\n");
    await merge(b, branch, "feat: b");
    expect(await pendingMarks(resting.id)).toHaveLength(0);
    const end = await syncAtTurnEnd(runCommand, a.worktree, a, branch, undefined);
    expect(end.follow).toBe(false);
    expect(messages(end.drafts)).toEqual([]);
    expect(end.drafts).toEqual([{ type: "custom", customType: SYNC_TYPE, data: expect.objectContaining({ kind: "synced", named: [], conflicts: [] }) }]);
    expect(git(a.worktree, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", branch));
    expect(readFileSync(join(a.worktree, "mine.ts"), "utf8")).toBe("mine\n");
  });

  test("two merges before the turn ends make one sync", async () => {
    const { repo, branch, wave } = await waveRepo();
    const a = await runningTask(repo, wave, branch, ["shared.ts", "other.ts"]);
    const b = await runningTask(repo, wave, branch, []);
    const c = await runningTask(repo, wave, branch, []);
    write(b.worktree, "shared.ts", "by b\n");
    await merge(b, branch, "feat: b");
    write(c.worktree, "other.ts", "by c\n");
    await merge(c, branch, "feat: c");
    expect(await pendingMarks(a.id)).toHaveLength(2);
    const end = await syncAtTurnEnd(runCommand, a.worktree, a, branch, undefined);
    const all = messages(end.drafts);
    expect(all).toHaveLength(1);
    expect(all[0]).toContain("- other.ts: feat: c");
    expect(all[0]).toContain("- shared.ts: feat: b");
    expect(end.drafts.filter((draft) => draft.type === "custom")).toHaveLength(1);
    expect(await pendingMarks(a.id)).toHaveLength(0);
  });
});

describe("a conflict", () => {
  test("keeps its markers, is named first, and is said once more while the markers stay", async () => {
    const { repo, branch, wave } = await waveRepo();
    const a = await runningTask(repo, wave, branch, ["other.ts"]);
    const b = await runningTask(repo, wave, branch, []);
    write(a.worktree, "shared.ts", "one\ntwo, by a\nthree\n");
    write(b.worktree, "shared.ts", "one\ntwo, by b\nthree\n");
    write(b.worktree, "other.ts", "other, by b\n");
    await merge(b, branch, "feat: b");
    const end = await syncAtTurnEnd(runCommand, a.worktree, a, branch, undefined);
    const [message] = messages(end.drafts);
    expect(message.indexOf("- shared.ts")).toBeLessThan(message.indexOf("- other.ts"));
    expect(message).toContain("conflict");
    const text = readFileSync(join(a.worktree, "shared.ts"), "utf8");
    expect(text).toContain("two, by a");
    expect(text).toContain("two, by b");
    expect(text).toContain("<<<<<<< ");
    // No git operation in progress: the coder resolves it by editing.
    expect(existsSync(join(git(a.worktree, "rev-parse", "--git-dir"), "rebase-merge"))).toBe(false);
    expect(end.left?.files).toEqual(["shared.ts"]);

    // The markers stay: said once more, then the round runs.
    const again = await syncAtTurnEnd(runCommand, a.worktree, a, branch, end.left);
    expect(again.follow).toBe(true);
    expect(messages(again.drafts)[0]).toContain("- shared.ts");
    const third = await syncAtTurnEnd(runCommand, a.worktree, a, branch, again.left);
    expect(third.follow).toBe(false);
    expect(third.drafts).toEqual([]);

    // Rebuilt from the session entries.
    const entries = [...end.drafts, ...again.drafts];
    expect(syncLeftOf(entries)).toEqual({ files: ["shared.ts"], tip: end.left?.tip ?? "", snapshot: end.left?.snapshot ?? "", reminded: true });
  });

  test("resolved markers end the reminder", async () => {
    const { repo, branch, wave } = await waveRepo();
    const a = await runningTask(repo, wave, branch, []);
    const b = await runningTask(repo, wave, branch, []);
    write(a.worktree, "shared.ts", "a\n");
    write(b.worktree, "shared.ts", "b\n");
    await merge(b, branch, "feat: b");
    const end = await syncAtTurnEnd(runCommand, a.worktree, a, branch, undefined);
    expect(end.follow).toBe(true);
    write(a.worktree, "shared.ts", "a and b\n");
    expect(await syncAtTurnEnd(runCommand, a.worktree, a, branch, end.left)).toEqual({ drafts: [], follow: false, left: undefined });
  });
});

test("a sync that fails restores HEAD, worktree and index, and consumes its marks", async () => {
  const { repo, branch, wave } = await waveRepo();
  const a = await runningTask(repo, wave, branch, ["shared.ts"]);
  const b = await runningTask(repo, wave, branch, []);
  commit(a.worktree, "mine.ts", "mine\n", "wip");
  write(a.worktree, "other.ts", "staged\n");
  git(a.worktree, "add", "other.ts");
  write(a.worktree, "other.ts", "staged, then changed\n");
  write(a.worktree, "new.ts", "new\n");
  write(b.worktree, "shared.ts", "by b\n");
  await merge(b, branch, "feat: b");
  const status = git(a.worktree, "status", "--porcelain");
  const head = git(a.worktree, "rev-parse", "HEAD");
  const tree = await snapshotTree(runCommand, a.worktree);
  const staged = git(a.worktree, "diff", "--cached");
  // The last step fails: everything before it is undone.
  const failing: Exec = (argv, options) => (argv[1] === "reset" ? Promise.resolve({ exitCode: 1, killed: false, timedOut: false, stdout: "", stdoutTruncated: false, output: "no", durationMs: 0 } as never) : runCommand(argv, options));
  const end = await syncAtTurnEnd(failing, a.worktree, a, branch, undefined);
  expect(end.follow).toBe(false);
  expect(end.drafts).toEqual([{ type: "custom", customType: SYNC_TYPE, data: expect.objectContaining({ kind: "failed", restored: true }) }]);
  expect(git(a.worktree, "status", "--porcelain")).toBe(status);
  expect(git(a.worktree, "rev-parse", "HEAD")).toBe(head);
  expect(await snapshotTree(runCommand, a.worktree)).toBe(tree);
  expect(git(a.worktree, "diff", "--cached")).toBe(staged);
  expect(await pendingMarks(a.id)).toHaveLength(0);
});

test("a wave's merge rebases the other building wave's branch, then syncs its tasks onto it with their old base", async () => {
  const one = await waveRepo(1, "main-factory-w1");
  const two = await waveRepo(2, "main-factory-w2");
  const { repo } = one;
  // Wave two has a done task's commit on its branch and a running task off it.
  const work = join(caseDir, "work");
  git(repo, "worktree", "add", "--quiet", work, two.branch);
  commit(work, "two.ts", "two\n", "feat: two");
  git(repo, "worktree", "remove", work);
  const t = await runningTask(repo, two.wave, two.branch, ["shared.ts"]);
  write(t.worktree, "task.ts", "task\n");
  // Wave one lands on main.
  const before = git(repo, "rev-parse", "main");
  git(repo, "worktree", "add", "--quiet", work, one.branch);
  commit(work, "shared.ts", "one\ntwo, by wave one\nthree\n", "feat: wave one");
  git(repo, "worktree", "remove", work);
  git(repo, "update-ref", "refs/heads/main", git(repo, "rev-parse", one.branch));
  const after = git(repo, "rev-parse", "main");
  const oldTip = git(repo, "rev-parse", two.branch);

  const done = await waveLanded(runCommand, repo, one.wave, "main", before, after);
  expect(done[0]).toContain("rebased onto main, 1 running task to sync");
  const newTip = git(repo, "rev-parse", two.branch);
  expect(newTip).not.toBe(oldTip);
  expect(git(repo, "rev-parse", `${two.branch}^`)).toBe(after);
  expect(git(repo, "log", "-1", "--format=%s", two.branch)).toBe("feat: two");

  const end = await syncAtTurnEnd(runCommand, t.worktree, t, two.branch, undefined);
  expect(messages(end.drafts)[0]).toContain("- shared.ts: feat: wave one");
  expect(git(t.worktree, "rev-parse", "HEAD")).toBe(newTip);
  // Its own change only: not the old copy of `two.ts`, not wave one's file.
  expect((await taskDiff(runCommand, t.worktree, newTip)).paths).toEqual(["task.ts"]);
});

test("a queued wave is left alone when another wave lands, and is synced once it started", async () => {
  const one = await waveRepo(1, "main-factory-w1");
  const { repo } = one;
  const queued = waveId(2);
  await createWave({ id: queued, repo, tag: "factory/w2", plan: null, title: "Wave 2", request: "r", branch: null, target: "main", origin: null, createdAt: "2026-01-01T00:00:00.000Z", overrides: {}, after: [one.wave] } as never);
  const land = async (file: string) => {
    const work = join(caseDir, `work-${file}`);
    const before = git(repo, "rev-parse", "main");
    git(repo, "worktree", "add", "--quiet", "--detach", work, "main");
    commit(work, file, "x\n", `feat: ${file}`);
    git(repo, "update-ref", "refs/heads/main", git(work, "rev-parse", "HEAD"));
    git(repo, "worktree", "remove", "--force", work);
    return [before, git(repo, "rev-parse", "main")] as const;
  };
  const [b1, a1] = await land("landed1.ts");
  expect(await waveLanded(runCommand, repo, one.wave, "main", b1, a1)).toEqual([]);

  git(repo, "branch", "main-factory-w2", a1);
  await appendWaveEvent(queued, { kind: "start", branch: "main-factory-w2", base: a1 });
  const t = await runningTask(repo, queued, "main-factory-w2", []);
  const [b2, a2] = await land("landed2.ts");
  const done = await waveLanded(runCommand, repo, one.wave, "main", b2, a2);
  expect(done[0]).toContain("rebased onto main, 1 running task to sync");
  expect(t.wave).toBe(queued);
});

test("a round passed its gates once a later step judged it", () => {
  expect(roundPassedGates([{ type: "custom", customType: "factory-state", data: { state: "merging", round: 1, reason: "passed" } }], false)).toBe(true);
  expect(roundPassedGates([{ type: "custom_message", customType: "factory-feedback", content: "", display: true, details: { round: 1, trigger: "gates" } }], false)).toBe(false);
  expect(roundPassedGates([{ type: "custom_message", customType: "factory-feedback", content: "", display: true, details: { round: 1, trigger: "review" } }], false)).toBe(true);
});
