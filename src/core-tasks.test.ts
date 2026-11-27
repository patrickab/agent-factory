/** The core's task actions and `TaskView` (`core-tasks.ts`), over the fixture of `core-test-kit.ts`. */
import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callAction } from "./core.ts";
import type { TaskView, TimelineEntry } from "./core-tasks.ts";
import { caseDir, expectError, failure, fakeRecord, git, ID_1, ID_2, makeRepo, prompts, recordOf, restingTask, runnerEnded, startTask, stateOf, until, useCoreFixture, writeSession } from "./core-test-kit.ts";
import { stopRunners, taskInboxPath } from "./launch.ts";
import { lastFactoryState } from "./runner.ts";
import { listTasks, lockTask, taskLogPath, unlockTask, writeTask } from "./tasks.ts";

useCoreFixture();

describe("task reads", () => {
  const sessionEntries = [
    { type: "custom", customType: "factory-task", timestamp: "t1", data: { mainBranch: "main", settings: { branch: "main", merge: "auto", maxRounds: 2, review: true, models: {} } } },
    { type: "message", timestamp: "t2", message: { role: "user", content: "add b.txt" } },
    { type: "custom", customType: "factory-round", timestamp: "t3", data: { round: 1, trigger: "start" } },
    {
      type: "message",
      timestamp: "t4",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "done" }], usage: { input: 10, output: 5, cacheRead: 3000, cacheWrite: 20, cost: { total: 0.5 } } },
    },
    { type: "message", timestamp: "t5", message: { role: "assistant", content: [{ type: "toolCall" }], usage: { input: 1, output: 1, cacheRead: 500, cost: { total: 0.25 } } } },
    { type: "custom", customType: "factory-review", timestamp: "t6", data: { round: 1, status: "ok", approved: true, findings: [], model: null, sessionFile: null, wallMs: 1, usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 1 } } },
    { type: "custom", customType: "factory-merge-intent", timestamp: "t7", data: { commit: "c", before: "b" } },
    { type: "custom_message", customType: "factory-feedback", content: "fix", timestamp: "t8" },
    { type: "message", timestamp: "t9", message: { role: "user", content: [{ type: "text", text: "/factory retry" }] } },
    { type: "custom", customType: "factory-state", timestamp: "t10", data: { state: "blocked", round: 1, reason: "gates" } },
  ];

  test("tasks.get: state and usage from the session file", async () => {
    const record = fakeRecord(ID_1, "/r");
    await writeTask(record);
    writeSession(record, sessionEntries);
    expect(await callAction("tasks.get", { id: "abc1" })).toMatchObject({
      id: ID_1,
      state: "blocked",
      reason: "gates",
      usage: { input: 111, output: 56, cacheRead: 3500, cacheWrite: 20, cost: 1.75 },
      actions: ["tasks.retry", "tasks.cancel", "tasks.remove", "tasks.message"],
    });
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

  test("tasks.diff: patch and per-file counts of the worktree, uncommitted files included", async () => {
    const repo = makeRepo();
    const record = await restingTask(repo, "waiting_approve");
    writeFileSync(join(record.worktree, "a.txt"), "a\nmore\n");
    git(record.worktree, "commit", "--quiet", "-am", "more");
    writeFileSync(join(record.worktree, "b.txt"), "b\nc\n");
    const diff = (await callAction("tasks.diff", { id: record.id })) as { diff: string; files: object[] };
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
});

describe("runner environment", () => {

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

});

describe("waiting_answer", () => {
  test("TaskView: the open question, actions message and cancel; timeline kind question; remove refused; tasks.wait needs attention", async () => {
    const record = fakeRecord(ID_1, "/r");
    await writeTask(record);
    const asked = [
      { type: "custom", customType: "factory-task", timestamp: "t0", data: { mainBranch: "main" } },
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
