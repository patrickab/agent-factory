/** The core's task actions and `TaskView` (`core-tasks.ts`), over the fixture of `core-test-kit.ts`. */
import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { ACTIONS, callAction } from "./core.ts";
import type { TaskView, TimelineEntry } from "./core-tasks.ts";
import {
  caseDir,
  exitingRunner,
  expectError,
  failure,
  fakeRecord,
  git,
  ID_1,
  ID_2,
  ID_3,
  makeRepo,
  prompts,
  recordOf,
  restingTask,
  RUN,
  runnerEnded,
  startTask,
  stateOf,
  testPath,
  until,
  useCoreFixture,
  writeSession,
} from "./core-test-kit.ts";
import { liveRunners, stopRunners, taskInboxPath } from "./launch.ts";
import { lastFactoryState } from "./runner.ts";
import { listTasks, lockTask, taskLogPath, tasksDir, unlockTask, writeTask } from "./tasks.ts";
import { appendWaveEvent, createWave } from "./waves.ts";

useCoreFixture();

describe("task reads", () => {
  const sessionEntries = [
    { type: "session", version: 3, id: "s" },
    { type: "custom", customType: "factory-task", timestamp: "t1", data: { mainBranch: "main", settings: { branch: "main", merge: "auto", maxRounds: 2, review: true, models: {} } } },
    { type: "message", timestamp: "t2", message: { role: "user", content: "add b.txt" } },
    { type: "custom", customType: "factory-round", timestamp: "t3", data: { round: 1, trigger: "start" } },
    {
      type: "message",
      timestamp: "t4",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "done" }], usage: { input: 10, output: 5, cacheRead: 3000, cacheWrite: 20, cost: { total: 0.5 } } },
    },
    { type: "message", timestamp: "t5", message: { role: "assistant", content: [{ type: "toolCall" }], usage: { input: 1, output: 1, cacheRead: 500, cost: { total: 0.25 } } } },
    { type: "custom", customType: "factory-review", timestamp: "t6", data: { round: 1, usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 1 } } },
    { type: "custom", customType: "factory-merge-intent", timestamp: "t7", data: { commit: "c", before: "b" } },
    { type: "custom_message", customType: "factory-feedback", content: "fix", timestamp: "t8" },
    { type: "message", timestamp: "t9", message: { role: "user", content: [{ type: "text", text: "/factory retry" }] } },
    { type: "custom", customType: "factory-state", timestamp: "t10", data: { state: "blocked", round: 1, reason: "gates" } },
  ];

  test("tasks.get: state, settings and usage from the session file", async () => {
    const record = fakeRecord(ID_1, "/r");
    await writeTask(record);
    const path = writeSession(record, sessionEntries);
    expect(await callAction("tasks.get", { id: "abc1" })).toEqual({
      id: ID_1,
      repo: "/r",
      worktree: record.worktree,
      branch: record.branch,
      title: record.title,
      createdAt: record.createdAt,
      tag: "team/a",
      plan: null,
      wave: null,
      origin: null,
      sessionId: record.sessionId,
      sessionPath: path,
      state: "blocked",
      round: 1,
      reason: "gates",
      at: "t10",
      question: null,
      running: false,
      interrupted: false,
      settings: { branch: "main", merge: "auto", maxRounds: 2, review: true, models: {} },
      usage: { input: 111, output: 56, cacheRead: 3500, cacheWrite: 20, cost: 1.75 },
      scoutingCost: 0,
      lastMessage: "done",
      failure: null,
      review: { round: 1, status: "unknown", approved: false, findings: [] },
      merged: null,
      minors: [],
      flaky: [],
      actions: ["tasks.retry", "tasks.cancel", "tasks.remove", "tasks.message"],
    });
  });

  test("tasks.get: the coder's last message (not its commit message), a blocked task's failure, the merged commit", async () => {
    const record = fakeRecord(ID_1, "/r");
    await writeTask(record);
    const custom = (customType: string, data: object) => ({ type: "custom", customType, timestamp: "t", data });
    const said = (role: string, text: string) => ({ type: "message", timestamp: "t", message: { role, content: [{ type: "text", text }] } });
    const gate = (exitCode: number, outputTail: string) => custom("factory-gate", { round: 1, phase: "gates", argv: ["bun", "run", "types"], exitCode, killed: false, durationMs: 1, outputTail });
    const head = [sessionEntries[0], sessionEntries[1], custom("factory-round", { round: 1, trigger: "start" }), said("assistant", "Added b.txt.")];
    writeSession(record, [
      ...head,
      { type: "custom_message", customType: "factory-commit-ask", content: "commit message?", timestamp: "t" },
      said("assistant", "feat: add b"),
      custom("factory-merge", { ok: true, commit: "40ca0ce", error: null, depsSynced: false }),
      custom("factory-state", { state: "done", round: 1, reason: "merged" }),
    ]);
    expect(await callAction("tasks.get", { id: ID_1 })).toMatchObject({ lastMessage: "Added b.txt.", failure: null, merged: "40ca0ce", review: null });
    writeSession(record, [...head, gate(2, "src/a.ts: error\n"), gate(0, "ok"), custom("factory-state", { state: "blocked", round: 1, reason: "max_rounds: gates" })]);
    expect(await callAction("tasks.get", { id: ID_1 })).toMatchObject({ failure: "bun run types (exit 2)\nsrc/a.ts: error", merged: null });
    writeSession(record, [...head, custom("factory-merge", { ok: false, commit: null, error: "rebase conflicts in a.ts", depsSynced: false }), custom("factory-state", { state: "blocked", round: 1, reason: "merge_failed" })]);
    expect(await callAction("tasks.get", { id: ID_1 })).toMatchObject({ failure: "rebase conflicts in a.ts" });
    // A failure fed back to the coder in a later round is not why the task stopped.
    writeSession(record, [...head, gate(2, "x"), custom("factory-round", { round: 2, trigger: "gates" }), custom("factory-state", { state: "blocked", round: 2, reason: "pipeline_error: boom" })]);
    expect(await callAction("tasks.get", { id: ID_1 })).toMatchObject({ failure: null });
  });

  test("tasks.get: the flaky names of the gate records, none for old records without them", async () => {
    const record = fakeRecord(ID_1, "/r");
    await writeTask(record);
    const custom = (customType: string, data: object) => ({ type: "custom", customType, timestamp: "t", data });
    const gate = (flaky?: string[]) => custom("factory-gate", { round: 1, phase: "gates", argv: ["bun", "test"], exitCode: 0, killed: false, durationMs: 1, outputTail: "", ...(flaky ? { flaky } : {}) });
    const head = [sessionEntries[0], sessionEntries[1], custom("factory-round", { round: 1, trigger: "start" })];
    writeSession(record, [...head, gate(), custom("factory-state", { state: "merging", round: 1, reason: "passed" })]);
    expect(((await callAction("tasks.get", { id: ID_1 })) as TaskView).flaky).toEqual([]);
    writeSession(record, [...head, gate(["a > b"]), custom("factory-round", { round: 2, trigger: "gates" }), gate(["a > b", "c"]), custom("factory-state", { state: "merging", round: 2, reason: "passed" })]);
    expect(((await callAction("tasks.get", { id: ID_1 })) as TaskView).flaky).toEqual(["a > b", "c"]);
  });

  test("tasks.get: the minor findings of every review, an approving one too; old review records without findings parse", async () => {
    const record = fakeRecord(ID_1, "/r");
    await writeTask(record);
    const custom = (customType: string, data: object) => ({ type: "custom", customType, timestamp: "t", data });
    const finding = (severity: string, file: string, text: string, line: number | null = null) => ({ severity, file, line, text });
    writeSession(record, [
      sessionEntries[0],
      sessionEntries[1],
      custom("factory-review", { round: 1 }),
      custom("factory-review", { round: 2, status: "ok", approved: false, findings: [finding("major", "a.ts", "bug", 3), finding("minor", "a.ts", "rename x", 4)] }),
      custom("factory-review", { round: 3, status: "ok", approved: true, findings: [finding("minor", "b.ts", "doc it"), { severity: "minor" }] }),
      custom("factory-state", { state: "merging", round: 3, reason: "passed" }),
    ]);
    const view = (await callAction("tasks.get", { id: ID_1 })) as TaskView;
    expect(view.minors).toEqual([
      { round: 2, file: "a.ts", line: 4, text: "rename x" },
      { round: 3, file: "b.ts", line: null, text: "doc it" },
    ]);
    expect(view.review).toMatchObject({ round: 3, approved: true });
  });

  test("tasks.get before the session file exists: nulls", async () => {
    await writeTask(fakeRecord(ID_1, "/r"));
    const view = (await callAction("tasks.get", { id: ID_1 })) as TaskView;
    expect([view.sessionPath, view.state, view.round, view.at, view.settings, view.usage, view.running, view.interrupted]).toEqual([null, null, null, null, null, null, false, false]);
    expect(view.actions).toEqual(["tasks.cancel", "tasks.remove"]);
  });

  test("tasks.timeline: the kinds in order, a cursor that skips what was read and a torn last line", async () => {
    const record = fakeRecord(ID_1, "/r");
    await writeTask(record);
    expect(await callAction("tasks.timeline", { id: ID_1 })).toEqual({ entries: [], next: 0 });
    const path = writeSession(record, sessionEntries);
    const first = (await callAction("tasks.timeline", { id: ID_1 })) as { entries: TimelineEntry[]; next: number };
    expect(first.entries.map((entry) => [entry.at, entry.kind])).toEqual([
      ["t1", "task"],
      ["t2", "user"],
      ["t3", "round"],
      ["t4", "coder"],
      ["t6", "review"],
      ["t10", "state"],
    ]);
    expect(first.entries[3].data).toEqual({ text: "done" });
    expect(first.entries[5].data).toEqual({ state: "blocked", round: 1, reason: "gates" });
    expect(first.next).toBe(readFileSync(path).length);
    const more = { type: "custom", customType: "factory-merge", timestamp: "t11", data: { ok: true, commit: "c", error: null, depsSynced: false } };
    writeFileSync(path, `${readFileSync(path, "utf8")}${JSON.stringify(more)}\n{"type":"cus`);
    const second = (await callAction("tasks.timeline", { id: ID_1, since: first.next })) as { entries: TimelineEntry[]; next: number };
    expect(second.entries).toEqual([{ at: "t11", kind: "merge", data: more.data }]);
    expect(await callAction("tasks.timeline", { id: ID_1, since: second.next })).toEqual({ entries: [], next: second.next });
    await expectError(callAction("tasks.timeline", { id: ID_1, since: 1_000_000 }), "invalid", "past the end");
  });

  test("tasks.list: every task, or the repository's", async () => {
    const repo = makeRepo();
    await writeTask(fakeRecord(ID_1, repo));
    await writeTask(fakeRecord(ID_2, "/elsewhere"));
    const ids = (result: unknown) => (result as { tasks: TaskView[] }).tasks.map((view) => view.id);
    expect(ids(await callAction("tasks.list", { repo }))).toEqual([ID_1]);
    expect(ids(await callAction("tasks.list", {}, { cwd: repo }))).toEqual([ID_1, ID_2]);
  });
});

describe("task actions", () => {
  test("tasks.start refusals: no title, not a repo, no factory.yaml, bad overrides", async () => {
    const repo = makeRepo(false);
    await expectError(callAction("tasks.start", { title: " ", request: "r" }, { cwd: repo }), "invalid", "needs a title");
    await expectError(callAction("tasks.start", { title: "t", request: "r" }, { cwd: caseDir }), "not_found", "is not inside a git repository");
    await expectError(callAction("tasks.start", { title: "t", request: "r" }, { cwd: repo }), "refused", "branch main has no factory.yaml");
    await expectError(callAction("tasks.start", { title: "t", request: "r", overrides: { branch: "nope" } }, { cwd: repo }), "refused", "branch nope does not exist locally");
    await expectError(callAction("tasks.start", { title: "t", request: "r", overrides: { maxRounds: 21 } }, { cwd: repo }), "invalid", "overrides.maxRounds must be an integer from 1 to 20");
    expect(await listTasks()).toEqual([]);
  });

  test("start returns once the runner is spawned; get, approve, then remove", async () => {
    const repo = makeRepo();
    const started = (await callAction("tasks.start", { title: "Add b", request: "add b.txt", repo: "." }, { cwd: repo })) as TaskView;
    expect(started.repo).toBe(repo);
    expect(git(started.worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(started.branch);
    const record = await recordOf(started);
    await until(async () => (await stateOf(record)) === "waiting_approve");
    await until(() => runnerEnded(record));
    const view = (await callAction("tasks.get", { id: record.id.slice(0, 6) })) as TaskView;
    expect([view.state, view.round, view.reason, view.running]).toEqual(["waiting_approve", 1, "passed", false]);
    expect(view.actions).toEqual(["tasks.approve", "tasks.cancel", "tasks.remove", "tasks.message"]);
    await expectError(callAction("tasks.retry", { id: record.id }), "refused", "retry needs blocked, cancelled or interrupted");

    await callAction("tasks.approve", { id: record.id });
    await until(async () => (await stateOf(record)) === "done");
    await until(() => runnerEnded(record));
    expect(prompts()).toEqual(["prompt /factory start", "prompt /factory approve"]);

    expect(await callAction("tasks.remove", { id: record.id })).toEqual({ removed: record.id, dropped: null });
    expect(existsSync(record.worktree)).toBe(false);
    expect(git(repo, "branch", "--list", record.branch)).toBe("");
    expect(existsSync(taskLogPath(record.id))).toBe(false);
    expect(await listTasks()).toEqual([]);
  }, 30_000);

  test("busy: an action while another process holds the task lock", async () => {
    const repo = makeRepo();
    const record = await restingTask(repo, "waiting_approve");
    await lockTask(record.id);
    try {
      await expectError(callAction("tasks.approve", { id: record.id }), "busy", "is busy");
    } finally {
      await unlockTask(record.id);
    }
  }, 30_000);

  test("tasks.diff: base, patch and per-file counts of the worktree, uncommitted files included", async () => {
    const repo = makeRepo();
    const record = await restingTask(repo, "waiting_approve");
    writeFileSync(join(record.worktree, "a.txt"), "a\nmore\n");
    git(record.worktree, "commit", "--quiet", "-am", "more");
    writeFileSync(join(record.worktree, "b.txt"), "b\nc\n");
    const diff = (await callAction("tasks.diff", { id: record.id })) as { base: string; diff: string; files: object[] };
    expect(diff.base).toBe(git(repo, "rev-parse", "main"));
    expect(diff.files).toEqual([
      { path: "a.txt", added: 1, removed: 0 },
      { path: "b.txt", added: 2, removed: 0 },
    ]);
    expect(diff.diff).toContain("+more");
    expect(diff.diff).toContain("b/b.txt");
  }, 30_000);

  test("retry from blocked sends /factory retry, the runner ends with the task blocked again", async () => {
    const repo = makeRepo();
    const record = await restingTask(repo, "blocked");
    await expectError(callAction("tasks.approve", { id: record.id }), "refused", "approve needs waiting_approve");
    const view = (await callAction("tasks.retry", { id: record.id })) as TaskView;
    expect(view.id).toBe(record.id);
    await until(() => prompts().includes("prompt /factory retry"));
    await until(async () => (await lastFactoryState(record.sessionDir, record.sessionId))?.reason === "gates");
    await until(() => runnerEnded(record));
  }, 30_000);

  test("cancel of a running task stops its runner first; remove refuses while it runs", async () => {
    process.env.FAKE_PI_HOLD = "1";
    const repo = makeRepo();
    const record = await startTask(repo);
    await until(async () => (await stateOf(record)) === "running");
    const running = (await callAction("tasks.get", { id: record.id })) as TaskView;
    expect([running.running, running.actions]).toEqual([true, ["tasks.cancel", "tasks.message"]]);
    const refusal = await failure(callAction("tasks.remove", { id: record.id, force: true }));
    expect([refusal.code, refusal.message, refusal.detail]).toEqual(["refused", `task ${record.id.slice(0, 8)} is running, cancel it first`, undefined]);
    await callAction("tasks.cancel", { id: record.id });
    await until(async () => (await stateOf(record)) === "cancelled");
    await until(() => runnerEnded(record));
    await expectError(callAction("tasks.cancel", { id: record.id }), "refused", "is cancelled already");
  }, 30_000);

  test("remove refuses unmerged commits and uncommitted changes unless force, and names what it dropped", async () => {
    const repo = makeRepo();
    const record = await restingTask(repo, "waiting_approve");
    const short = record.id.slice(0, 8);
    writeFileSync(join(record.worktree, "b.txt"), "b\n");
    git(record.worktree, "add", "-A");
    git(record.worktree, "commit", "--quiet", "-m", "b");
    writeFileSync(join(record.worktree, "c.txt"), "c\n");
    const refusal = await failure(callAction("tasks.remove", { id: record.id }));
    expect([refusal.code, refusal.message, refusal.detail]).toEqual([
      "refused",
      `task ${short} has 1 unmerged commit (not on main) and uncommitted changes in its worktree, give force: true to remove it anyway`,
      { force: true },
    ]);
    expect(existsSync(record.worktree)).toBe(true);
    expect(await callAction("tasks.remove", { id: record.id, force: true })).toEqual({ removed: record.id, dropped: "1 unmerged commit (not on main) and uncommitted changes" });
    expect(existsSync(record.worktree)).toBe(false);
  }, 30_000);

  test("a running task whose runner is gone is interrupted; retry runs it", async () => {
    process.env.FAKE_PI_HOLD = "1";
    const repo = makeRepo();
    const record = await startTask(repo);
    await until(async () => (await stateOf(record)) === "running");
    await stopRunners(record);
    const view = (await callAction("tasks.get", { id: record.id })) as TaskView;
    expect([view.state, view.running, view.interrupted]).toEqual(["running", false, true]);
    expect(view.actions).toEqual(["tasks.retry", "tasks.cancel", "tasks.remove", "tasks.message"]);
    delete process.env.FAKE_PI_HOLD;
    await callAction("tasks.retry", { id: record.id });
    await until(() => prompts().includes("prompt /factory retry"));
    await until(async () => (await lastFactoryState(record.sessionDir, record.sessionId))?.reason === "gates");
    await until(() => runnerEnded(record));
  }, 30_000);
});

describe("tasks.message", () => {
  test("a resting task gets the message through a new runner", async () => {
    const repo = makeRepo();
    const record = await restingTask(repo, "blocked");
    const view = (await callAction("tasks.message", { id: record.id, text: "please fix it" })) as TaskView;
    expect(view.id).toBe(record.id);
    await until(() => prompts().includes("prompt please fix"));
    expect(existsSync(taskInboxPath(record.id))).toBe(false);
  }, 30_000);

  test("a running task's live runner gets an inbox line; no state and merging are refused", async () => {
    await writeTask(fakeRecord(ID_1, "/r"));
    await expectError(callAction("tasks.message", { id: ID_1, text: "hi" }), "refused", "has not started yet");
    process.env.FAKE_PI_HOLD = "1";
    const repo = makeRepo();
    const record = await startTask(repo);
    await until(async () => (await stateOf(record)) === "running");
    const view = (await callAction("tasks.message", { id: record.id, text: "also do c" })) as TaskView;
    expect(view.running).toBe(true);
    expect(readFileSync(taskInboxPath(record.id), "utf8")).toBe('{"text":"also do c"}\n');
    expect(prompts()).toEqual(["prompt /factory start"]);

    const merging = fakeRecord(ID_2, "/r");
    await writeTask(merging);
    writeSession(merging, [{ type: "custom", customType: "factory-state", data: { state: "merging", round: 1, reason: "approved" } }]);
    await expectError(callAction("tasks.message", { id: ID_2, text: "hi" }), "refused", "is merging");
  }, 30_000);

  test("a runner that ends as the line is appended: the line is taken back and a new runner delivers it", async () => {
    const repo = makeRepo();
    const record = await restingTask(repo, "blocked");
    writeSession(record, [
      { type: "custom", customType: "factory-task", data: { mainBranch: "main" } },
      { type: "custom", customType: "factory-state", data: { state: "running", round: 2, reason: "message" } },
    ]);
    const runner = Bun.spawn(["bun", exitingRunner, record.worktree, record.sessionDir, record.sessionId, "x"], {
      env: { ...process.env, FAKE_INBOX: taskInboxPath(record.id) },
    });
    await until(async () => (await liveRunners(record)).length === 1);
    await callAction("tasks.message", { id: record.id, text: "late note" });
    await runner.exited;
    await until(() => prompts().includes("prompt late note"));
    expect(readFileSync(taskInboxPath(record.id), "utf8")).toBe("");
  }, 30_000);
});

describe("tasks.import", () => {
  const ID = "11111111-2222-3333-4444-555555555555";

  test("hostOnly: tasks.import only", () => {
    expect(Object.entries(ACTIONS).filter(([, spec]) => spec.hostOnly).map(([name]) => name)).toEqual(["tasks.import"]);
  });

  test("writes a record of a linked worktree on its branch once, keeps an existing one, refuses a wrong shape", async () => {
    const repo = makeRepo();
    const worktree = join(caseDir, "task-wt");
    git(repo, "worktree", "add", "--quiet", "-b", "task", worktree);
    const record = { id: ID, repo, worktree, branch: "task", title: "first", sessionId: `test-session-s-${RUN}`, sessionDir: join(caseDir, "sessions"), createdAt: "2026-01-01T00:00:00.000Z" };
    expect(await callAction("tasks.import", { record })).toMatchObject({ id: ID, title: "first", state: null });
    expect(await callAction("tasks.import", { record: { ...record, title: "second" } })).toMatchObject({ title: "first" });
    await expect(callAction("tasks.import", { record: { ...record, id: "abc" } })).rejects.toMatchObject({ code: "invalid" });
    await expect(callAction("tasks.import", { record: { ...record, id: ID.replace("1", "9"), title: "" } })).rejects.toMatchObject({ code: "invalid" });
    await expect(callAction("tasks.import", { record: { ...record, id: ID.replace("1", "9"), worktree: "task-wt" } })).rejects.toMatchObject({ code: "invalid" });
    expect((await listTasks()).map((task) => task.id)).toEqual([ID]);
  });

  test("refuses a record that would let tasks.remove delete a checkout or branch the task does not own", async () => {
    const repo = makeRepo();
    const victim = join(caseDir, "victim-wt");
    git(repo, "worktree", "add", "--quiet", "-b", "precious", victim);
    const other = makeRepo(true, "other");
    const base = { id: ID, repo, worktree: victim, branch: "precious", title: "t", sessionId: `test-session-s-${RUN}`, sessionDir: join(caseDir, "sessions"), createdAt: "2026-01-01T00:00:00.000Z" };
    const refused = async (change: object, message: string) => expectError(callAction("tasks.import", { record: { ...base, ...change } }), "refused", message);
    await refused({ worktree: repo, branch: "main" }, `${repo} is not a linked worktree of ${repo}`);
    await refused({ branch: "main" }, `${victim} does not have branch main checked out`);
    await refused({ repo: victim }, `${victim} is not the primary checkout of its repository`);
    await refused({ repo: other }, `${victim} is not a linked worktree of ${other}`);
    await refused({ repo: join(caseDir, "nothing") }, "is not a git repository");
    expect(await listTasks()).toEqual([]);
    expect(existsSync(victim)).toBe(true);
  });

  test("an imported record belongs to no wave, whatever its wave field says (invariant 4)", async () => {
    const repo = makeRepo();
    const worktree = join(caseDir, "task-wt");
    git(repo, "worktree", "add", "--quiet", "-b", "task", worktree);
    const wave = `60000000-${RUN}-4000-8000-000000000001`;
    const record = { id: ID, repo, worktree, branch: "task", title: "t", sessionId: `test-session-s-${RUN}`, sessionDir: join(caseDir, "sessions"), createdAt: "2026-01-01T00:00:00.000Z", wave };
    expect(((await callAction("tasks.import", { record })) as TaskView).wave).toBeNull();
    expect((await listTasks()).map((task) => [task.id, task.wave])).toEqual([[ID, null]]);
  });
});

describe("an old merge request record (invariant 7)", () => {
  test("keeps its limits: removing it keeps its source branch and its commits, approve, retry, cancel and message are refused", async () => {
    const repo = makeRepo();
    const worktree = join(caseDir, "mr-wt");
    git(repo, "worktree", "add", "--quiet", "-b", "feature", worktree);
    writeFileSync(join(worktree, "f.txt"), "f\n");
    git(worktree, "add", "-A");
    git(worktree, "commit", "--quiet", "-m", "feature work");
    const feature = git(repo, "rev-parse", "feature");
    const record = { ...fakeRecord(ID_1, repo), worktree, branch: "feature" };
    mkdirSync(tasksDir(), { recursive: true });
    writeFileSync(join(tasksDir(), `${ID_1}.json`), JSON.stringify({ ...record, kind: "merge_request", source: "feature" }));
    writeSession(record, [{ type: "custom", customType: "factory-state", timestamp: "t", data: { state: "waiting_approve", round: 1, reason: "passed" } }]);
    const [loaded] = await listTasks();
    expect(loaded.kind).toBe("merge_request");
    const view = (await callAction("tasks.get", { id: ID_1 })) as TaskView;
    expect("kind" in view).toBe(false);
    expect(view.actions).toEqual(["tasks.remove"]);
    for (const [action, params, what] of [
      ["tasks.approve", {}, "approve"],
      ["tasks.retry", {}, "retry"],
      ["tasks.cancel", {}, "cancel"],
      ["tasks.message", { text: "hi" }, "a message"],
    ] as const) {
      await expectError(callAction(action, { id: ID_1, ...params }), "refused", `is an old merge request: ${what} is refused, it can only be removed`);
    }
    expect(prompts()).toEqual([]);
    // Its commits are its source branch's, which it never owned: no force needed, and the branch stays.
    expect(await callAction("tasks.remove", { id: ID_1 })).toEqual({ removed: ID_1, dropped: null });
    expect(git(repo, "rev-parse", "feature")).toBe(feature);
    expect(existsSync(worktree)).toBe(false);
    expect(await listTasks()).toEqual([]);
  });
});

describe("D review fixes", () => {
  test("a relative repo without cwd is invalid", async () => {
    await expectError(callAction("settings.get", { repo: "some/repo" }), "invalid", "repo some/repo must be an absolute path (the call has no cwd)");
  });

  test("env: the runners an action starts get the caller's environment, not the host's", async () => {
    const repo = makeRepo();
    const envLog = join(caseDir, "env.log");
    process.env.FAKE_PI_START_END = "blocked";
    const env = { ...(process.env as Record<string, string>), FAKE_PI_ENV_LOG: envLog };
    process.env.FACTORY_TEST_SECRET = "leak";
    const record = await recordOf((await callAction("tasks.start", { title: "t", request: "r" }, { cwd: repo, env })) as TaskView);
    await until(async () => (await stateOf(record)) === "blocked");
    await until(() => runnerEnded(record));
    await callAction("tasks.message", { id: record.id, text: "more" }, { env });
    await until(() => existsSync(envLog) && readFileSync(envLog, "utf8").split("\n").length === 3);
    expect(readFileSync(envLog, "utf8")).toBe("secret -\nsecret -\n");
  }, 30_000);

  test("an interrupted task without unmerged work is removed without force", async () => {
    process.env.FAKE_PI_HOLD = "1";
    const repo = makeRepo();
    const record = await startTask(repo);
    await until(async () => (await stateOf(record)) === "running");
    await stopRunners(record);
    expect(await callAction("tasks.remove", { id: record.id })).toEqual({ removed: record.id, dropped: null });
    expect(existsSync(record.worktree)).toBe(false);
  }, 30_000);

  test("an interrupted task with unmerged work: refused with detail force, removed with force", async () => {
    process.env.FAKE_PI_HOLD = "1";
    const repo = makeRepo();
    const record = await startTask(repo);
    await until(async () => (await stateOf(record)) === "running");
    await stopRunners(record);
    writeFileSync(join(record.worktree, "c.txt"), "c\n");
    const refusal = await failure(callAction("tasks.remove", { id: record.id }));
    expect([refusal.code, refusal.detail]).toEqual(["refused", { force: true }]);
    expect(await callAction("tasks.remove", { id: record.id, force: true })).toEqual({ removed: record.id, dropped: "0 unmerged commits (not on main) and uncommitted changes" });
  }, 30_000);

  test("cancel and retry of an interrupted task whose runner cannot start: failed", async () => {
    process.env.FAKE_PI_HOLD = "1";
    const repo = makeRepo();
    const record = await startTask(repo);
    await until(async () => (await stateOf(record)) === "running");
    await stopRunners(record);
    rmSync(record.worktree, { recursive: true, force: true });
    await expectError(callAction("tasks.cancel", { id: record.id }), "failed", `the runner of task ${record.id.slice(0, 8)} ended before it ran`);
    await expectError(callAction("tasks.retry", { id: record.id }), "failed", `the runner of task ${record.id.slice(0, 8)} ended before it ran`);
    expect(await callAction("tasks.remove", { id: record.id })).toEqual({ removed: record.id, dropped: null });
  }, 30_000);

  test("tasks.message: a runner that cannot start is failed, not refused", async () => {
    const repo = makeRepo();
    const record = await restingTask(repo, "blocked");
    process.env.PATH = testPath
      .split(":")
      .filter((dir) => !existsSync(join(dir, "bun")))
      .join(":");
    await expectError(callAction("tasks.message", { id: record.id, text: "hi" }), "failed", "bun is not on PATH");
  }, 30_000);

  test("tasks.timeline reads the session file from since on, not all of it", async () => {
    const record = fakeRecord(ID_1, "/r");
    await writeTask(record);
    const path = writeSession(record, []);
    // Sparse and larger than a Buffer can hold: reading the whole file fails.
    truncateSync(path, 2 ** 32 + 16);
    const since = statSync(path).size;
    const entry = { type: "custom", customType: "factory-state", timestamp: "t1", data: { state: "blocked", round: 1, reason: "gates" } };
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
    try {
      expect(await callAction("tasks.timeline", { id: ID_1, since })).toEqual({ entries: [{ at: "t1", kind: "state", data: entry.data }], next: statSync(path).size });
    } finally {
      rmSync(path, { force: true });
    }
  });
});

describe("task tags", () => {
  test("tasks.start: tag defaults to the system user, plan to null; given ones are stored", async () => {
    const repo = makeRepo();
    const plain = (await callAction("tasks.start", { title: "Add b", request: "add b.txt" }, { cwd: repo })) as TaskView;
    expect([plain.tag, plain.plan]).toEqual([userInfo().username, null]);
    const tagged = (await callAction("tasks.start", { title: "Add c", request: "add c.txt", tag: "plugin/m1/w1", plan: "plan/plugin/m1/w1.md" }, { cwd: repo })) as TaskView;
    expect([tagged.tag, tagged.plan]).toEqual(["plugin/m1/w1", "plan/plugin/m1/w1.md"]);
    const stored = await recordOf(tagged);
    expect([stored.tag, stored.plan]).toEqual(["plugin/m1/w1", "plan/plugin/m1/w1.md"]);
  }, 30_000);

  test("tasks.start refuses a malformed tag and an empty plan before any worktree; kind and source are no params", async () => {
    const repo = makeRepo();
    for (const tag of ["", "a//b", "/a", "a/", "a b", "ä"]) {
      await expectError(callAction("tasks.start", { title: "t", request: "r", tag }, { cwd: repo }), "invalid", "is not segments of");
    }
    await expectError(callAction("tasks.start", { title: "t", request: "r", plan: " " }, { cwd: repo }), "invalid", "plan must not be empty");
    expect(Object.keys(ACTIONS["tasks.start"].params.properties)).not.toContain("kind");
    expect(Object.keys(ACTIONS["tasks.start"].params.properties)).not.toContain("source");
    expect(await listTasks()).toEqual([]);
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
  });

  test("a record written without tag and plan still lists, with the defaults; an old kind is ignored", async () => {
    const { tag: _tag, plan: _plan, ...old } = fakeRecord(ID_1, "/r");
    mkdirSync(tasksDir(), { recursive: true });
    writeFileSync(join(tasksDir(), `${ID_1}.json`), JSON.stringify({ ...old, kind: "merge_request" }));
    const views = ((await callAction("tasks.list", {})) as { tasks: TaskView[] }).tasks;
    expect(views.map((view) => [view.id, view.tag, view.plan, "kind" in view])).toEqual([[ID_1, userInfo().username, null, false]]);
  });

  test("tasks.list tag: the tag itself and the tags under it, not a longer segment", async () => {
    await writeTask({ ...fakeRecord(ID_1, "/r"), tag: "a" });
    await writeTask({ ...fakeRecord(ID_2, "/r"), tag: "a/b" });
    await writeTask({ ...fakeRecord(ID_3, "/r"), tag: "ab" });
    const ids = async (tag: string) => ((await callAction("tasks.list", { tag })) as { tasks: TaskView[] }).tasks.map((view) => view.id);
    expect(await ids("a")).toEqual([ID_1, ID_2]);
    expect(await ids("a/b")).toEqual([ID_2]);
    expect(await ids("ab")).toEqual([ID_3]);
    expect(await ids("a/b/c")).toEqual([]);
    await expectError(callAction("tasks.list", { tag: "a/" }), "invalid", "is not segments of");
  });
});

describe("waiting_answer", () => {
  test("TaskView: the open question, actions message and cancel; timeline kind question; remove refused; tasks.wait needs attention", async () => {
    const record = fakeRecord(ID_1, "/r");
    await writeTask(record);
    const asked = [
      { type: "custom", customType: "factory-round", timestamp: "t1", data: { round: 1, trigger: "start" } },
      { type: "custom", customType: "factory-question", timestamp: "t2", data: { text: "Which table?" } },
      { type: "custom", customType: "factory-state", timestamp: "t3", data: { state: "waiting_answer", round: 1, reason: "question" } },
    ];
    const path = writeSession(record, asked);
    const view = (await callAction("tasks.get", { id: ID_1 })) as TaskView;
    expect([view.state, view.question, view.running, view.interrupted, view.actions]).toEqual(["waiting_answer", "Which table?", false, false, ["tasks.cancel", "tasks.message"]]);
    const timeline = (await callAction("tasks.timeline", { id: ID_1 })) as { entries: TimelineEntry[] };
    expect(timeline.entries[1]).toEqual({ at: "t2", kind: "question", data: { text: "Which table?" } });
    await expectError(callAction("tasks.remove", { id: ID_1, force: true }), "refused", "waits for the answer to its question");
    expect(await callAction("tasks.wait", { ids: [ID_1] })).toMatchObject({ attention: [ID_1], timedOut: false });

    appendFileSync(path, `${JSON.stringify({ type: "custom", customType: "factory-state", timestamp: "t4", data: { state: "blocked", round: 1, reason: "gates" } })}\n`);
    const answered = (await callAction("tasks.get", { id: ID_1 })) as TaskView;
    expect([answered.state, answered.question]).toEqual(["blocked", null]);
  });
});

describe("tasks.start and queued waves", () => {
  test("a queued wave that started owns the branch its start event set (invariant 13)", async () => {
    const repo = makeRepo();
    const id = `20000000-${RUN}-4000-8000-000000000007`;
    const named = `20000000-${RUN}-4000-8000-000000000008`;
    // Queued: no branch in its declaration.
    await createWave({ id, repo, tag: "factory/w8", plan: null, title: "w", request: "r", branch: null, target: "main", base: null, after: [named], origin: null, createdAt: "2026-01-01T00:00:00.000Z", overrides: {} });
    const main = git(repo, "rev-parse", "main");
    git(repo, "branch", "main-factory-w8");
    await appendWaveEvent(id, { kind: "start", branch: "main-factory-w8", base: main });
    const start = () => callAction("tasks.start", { title: "t", request: "r", overrides: { branch: "main-factory-w8" } }, { cwd: repo });
    await expectError(start(), "refused", "main-factory-w8 is the branch of wave 20000000, which is building");
    expect(await listTasks()).toEqual([]);
  });
});
