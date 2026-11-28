/** The core's task actions and `TaskView` (`core-tasks.ts`), over the fixture of `core-test-kit.ts`. */
import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callAction } from "./core.ts";
import type { TaskView, TimelineEntry } from "./core-tasks.ts";
import { caseDir, expectError, failure, fakeRecord, git, ID_1, ID_2, makeRepo, noted, prompts, recordOf, restingTask, runnerEnded, runnerHolding, startTask, stateOf, until, TASK_ENTRY, useCoreFixture, writeSession } from "./core-test-kit.ts";
import { stopRunners, taskInboxPath } from "./launch.ts";
import { lastFactoryState } from "./runner.ts";
import { listTasks, lockTask, taskLockPath, taskLogPath, writeTask } from "./tasks.ts";
import { unlockFile } from "./lock.ts";

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

  test("tasks.timeline reads from since on; a torn last line is read once it is whole", async () => {
    const record = fakeRecord(ID_1, "/r");
    await writeTask(record);
    const path = writeSession(record, sessionEntries);
    const timeline = (since: number) => callAction("tasks.timeline", { id: ID_1, since }) as Promise<{ entries: TimelineEntry[]; next: number }>;
    const first = await timeline(0);
    expect([first.entries.at(-1)?.kind, first.next]).toEqual(["state", readFileSync(path).length]);
    const merge = { type: "custom", customType: "factory-merge", timestamp: "t11", data: { ok: true, commit: "c", error: null, depsSynced: false } };
    const torn = JSON.stringify({ ...merge, timestamp: "t12" });
    appendFileSync(path, `${JSON.stringify(merge)}\n${torn.slice(0, 10)}`);
    const second = await timeline(first.next);
    expect(second.entries).toEqual([{ at: "t11", kind: "merge", data: merge.data }]);
    appendFileSync(path, `${torn.slice(10)}\n`);
    expect(await timeline(second.next)).toEqual({ entries: [{ at: "t12", kind: "merge", data: merge.data }], next: readFileSync(path).length });
  });
});

describe("task actions", () => {
  test("tasks.start refusals: no title, not a repo, no factory.yaml, bad overrides", async () => {
    const repo = makeRepo(false);
    await expectError(callAction("tasks.start", { title: " ", request: "r" }, { cwd: repo }), "invalid");
    await expectError(callAction("tasks.start", { title: "t", request: "r" }, { cwd: caseDir }), "not_found");
    await expectError(callAction("tasks.start", { title: "t", request: "r" }, { cwd: repo }), "refused");
    await expectError(callAction("tasks.start", { title: "t", request: "r", overrides: { branch: "nope" } }, { cwd: repo }), "not_found");
    await expectError(callAction("tasks.start", { title: "t", request: "r", overrides: { maxRounds: 21 } }, { cwd: repo }), "invalid");
    expect(await listTasks()).toEqual([]);
  });

  test("tasks.start whose pi exits before it answers fails and leaves no record, worktree or branch", async () => {
    process.env.FAKE_PI_EXIT = "1";
    const repo = makeRepo();
    await expectError(callAction("tasks.start", { title: "Add b", request: "add b.txt" }, { cwd: repo }), "failed");
    expect(await listTasks()).toEqual([]);
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
    expect(git(repo, "branch", "--list", "add-b-*")).toBe("");
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
    await expectError(callAction("tasks.retry", { id: record.id }), "refused");

    await callAction("tasks.approve", { id: record.id });
    await until(async () => (await stateOf(record)) === "done");
    await until(() => runnerEnded(record));

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
      await expectError(callAction("tasks.approve", { id: record.id }), "busy");
    } finally {
      await unlockFile(taskLockPath(record.id));
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
    await expectError(callAction("tasks.approve", { id: record.id }), "refused");
    const view = (await callAction("tasks.retry", { id: record.id })) as TaskView;
    expect(view.id).toBe(record.id);
    await until(() => prompts().includes("/factory retry"));
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
    expect([refusal.code, refusal.detail]).toEqual(["refused", undefined]);
    await callAction("tasks.cancel", { id: record.id });
    await until(async () => (await stateOf(record)) === "cancelled");
    await until(() => runnerEnded(record));
    await expectError(callAction("tasks.cancel", { id: record.id }), "refused");
  }, 30_000);

  test("remove refuses unmerged commits and uncommitted changes unless force, and says it dropped them", async () => {
    const repo = makeRepo();
    const record = await restingTask(repo, "waiting_approve");
    writeFileSync(join(record.worktree, "b.txt"), "b\n");
    git(record.worktree, "add", "-A");
    git(record.worktree, "commit", "--quiet", "-m", "b");
    writeFileSync(join(record.worktree, "c.txt"), "c\n");
    const refusal = await failure(callAction("tasks.remove", { id: record.id }));
    expect([refusal.code, refusal.detail]).toEqual(["refused", { force: true }]);
    expect(existsSync(record.worktree)).toBe(true);
    const removed = (await callAction("tasks.remove", { id: record.id, force: true })) as { removed: string; dropped: string | null };
    expect([removed.removed, removed.dropped === null]).toEqual([record.id, false]);
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
    await until(() => prompts().includes("/factory retry"));
    await until(async () => (await lastFactoryState(record.sessionDir, record.sessionId))?.reason === "gates");
    await until(() => runnerEnded(record));
  }, 30_000);

  test("a task without a session and without a runner is interrupted; retry starts it", async () => {
    const repo = makeRepo();
    const record = await restingTask(repo, "waiting_approve");
    // As if its Pi had died before it answered: no session at all.
    rmSync(record.sessionDir, { recursive: true });
    const view = (await callAction("tasks.get", { id: record.id })) as TaskView;
    expect([view.state, view.interrupted, view.actions.includes("tasks.retry")]).toEqual([null, true, true]);
    await callAction("tasks.retry", { id: record.id });
    await until(async () => (await stateOf(record)) === "waiting_approve");
    expect(prompts().filter((line) => line === record.start)).toHaveLength(2);
  }, 30_000);
});

describe("tasks.message", () => {
  test("a resting task gets the message through a new runner", async () => {
    const repo = makeRepo();
    const record = await restingTask(repo, "blocked");
    const view = (await callAction("tasks.message", { id: record.id, text: "please fix it" })) as TaskView;
    expect(view.id).toBe(record.id);
    await until(() => prompts().includes("please fix it"));
    expect(existsSync(taskInboxPath(record.id))).toBe(false);
  }, 30_000);

  test("a message sent as the runner ends, after its last look at the inbox: the coder gets it once, a final task refuses it", async () => {
    for (const final of [false, true]) {
      const record = await restingTask(makeRepo(true, `repo-${final}`), "blocked");
      const end = join(caseDir, `runner-end-${final}`);
      // A runner that closed Pi's stdin: it holds the task lock and ends without reading the inbox again.
      const runner = await runnerHolding(taskLockPath(record.id), record.sessionId, { ...process.env, FAKE_RUNNER_END: end });
      await until(async () => !(await runnerEnded(record)));
      const sent = callAction("tasks.message", { id: record.id, text: "late note" });
      const outcome = sent.then(() => undefined, (error: unknown) => error);
      await until(() => existsSync(taskInboxPath(record.id)));
      // The task ends `cancelled` while the line waits.
      if (final) writeSession(record, [TASK_ENTRY, { type: "custom", customType: "factory-state", timestamp: "2026-01-01T00:00:00.000Z", data: { state: "cancelled", round: 1, reason: "cancelled" } }]);
      writeFileSync(end, "");
      await runner.exited;
      const error = await outcome;
      if (final) {
        expect((error as { code: string }).code).toBe("refused");
        expect(Number(readFileSync(`${taskInboxPath(record.id)}.read`, "utf8"))).toBe(readFileSync(taskInboxPath(record.id)).length);
        expect(await runnerEnded(record)).toBe(true);
        continue;
      }
      expect(error).toBeUndefined();
      await until(() => prompts().includes("late note"));
      expect(prompts().filter((prompt) => prompt === "late note")).toHaveLength(1);
      // Marked sent: no runner sends it again.
      expect(Number(readFileSync(`${taskInboxPath(record.id)}.read`, "utf8"))).toBe(readFileSync(taskInboxPath(record.id)).length);
    }
  }, 30_000);

  test("a running task's live runner gets an inbox line; no state and merging are refused", async () => {
    await writeTask(fakeRecord(ID_1, "/r"));
    await expectError(callAction("tasks.message", { id: ID_1, text: "hi" }), "refused");
    process.env.FAKE_PI_HOLD = "1";
    const repo = makeRepo();
    const record = await startTask(repo);
    await until(async () => (await stateOf(record)) === "running");
    const view = (await callAction("tasks.message", { id: record.id, text: "also do c" })) as TaskView;
    expect(view.running).toBe(true);
    expect(readFileSync(taskInboxPath(record.id), "utf8")).toBe('{"text":"also do c"}\n');
    expect(prompts()).not.toContain("also do c");

    const merging = fakeRecord(ID_2, "/r");
    await writeTask(merging);
    writeSession(merging, [TASK_ENTRY, { type: "custom", customType: "factory-state", timestamp: "2026-01-01T00:00:00.000Z", data: { state: "merging", round: 1, reason: "approved" } }]);
    await expectError(callAction("tasks.message", { id: ID_2, text: "hi" }), "refused");
  }, 30_000);

  test("a done task whose worktree is gone and whose branch holds other work refuses a message and stays done", async () => {
    const repo = makeRepo();
    const record = { ...fakeRecord(ID_1, repo), branch: "taken" };
    git(repo, "branch", "taken", git(repo, "commit-tree", "main^{tree}", "-p", "main", "-m", "other work"));
    await writeTask(record);
    writeSession(record, [TASK_ENTRY, { type: "custom", customType: "factory-state", timestamp: "2026-01-01T00:00:00.000Z", data: { state: "done", round: 1, reason: "merged" } }]);
    await expectError(callAction("tasks.message", { id: ID_1, text: "more" }), "refused");
    expect((await lastFactoryState(record.sessionDir, record.sessionId))?.state).toBe("done");
    expect(existsSync(record.worktree)).toBe(false);
    expect(prompts()).toEqual([]);
  }, 30_000);
});

describe("runner environment", () => {

  test("env: the runners an action starts get the caller's environment, not the host's", async () => {
    const repo = makeRepo();
    process.env.FAKE_PI_START_END = "blocked";
    const env = { ...(process.env as Record<string, string>) };
    process.env.FACTORY_TEST_SECRET = "leak";
    const record = await recordOf((await callAction("tasks.start", { title: "t", request: "r" }, { cwd: repo, env })) as TaskView);
    await until(async () => (await stateOf(record)) === "blocked");
    await until(() => runnerEnded(record));
    await callAction("tasks.message", { id: record.id, text: "more" }, { env });
    await until(() => noted("env").length === 2);
    expect(noted<{ secret?: string }>("env").map((seen) => seen.secret)).toEqual([undefined, undefined]);
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
    await expectError(callAction("tasks.remove", { id: ID_1, force: true }), "refused");
    expect(await callAction("tasks.wait", { ids: [ID_1] })).toMatchObject({ attention: [ID_1], timedOut: false });

    appendFileSync(path, `${JSON.stringify({ type: "custom", customType: "factory-state", timestamp: "t4", data: { state: "blocked", round: 1, reason: "gates" } })}\n`);
    const answered = (await callAction("tasks.get", { id: ID_1 })) as TaskView;
    expect([answered.state, answered.question]).toEqual(["blocked", null]);
  });
});
