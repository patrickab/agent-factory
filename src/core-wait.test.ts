/** The core's `tasks.wait` over tasks (`core-wait.ts`), over the fixture of `core-test-kit.ts`; over waves: `core-waves.test.ts`. */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACTIONS, callAction } from "./core.ts";
import type { TaskView } from "./core-tasks.ts";
import { caseDir, exitingRunner, expectError, fakeRecord, ID_1, ID_2, until, useCoreFixture, writeSession } from "./core-test-kit.ts";
import { liveRunners, taskInboxPath } from "./launch.ts";
import { writeTask, type TaskRecord } from "./tasks.ts";
import { appendWaveEvent, createWave, type WaveView } from "./waves.ts";

useCoreFixture();

describe("tasks.wait", () => {
  const stateEntry = (state: string) => ({ type: "custom", customType: "factory-state", timestamp: "t", data: { state, round: 1, reason: "r" } });

  /** A task tagged `tag`: resting in `state`, or starting (no session file) without one. */
  async function waitTask(id: string, tag: string, state?: string): Promise<TaskRecord> {
    const record = { ...fakeRecord(id, "/r"), tag };
    await writeTask(record);
    if (state !== undefined) writeSession(record, [stateEntry(state)]);
    return record;
  }

  type WaitResult = { tasks: TaskView[]; waves: WaveView[]; attention: string[]; timedOut: boolean };
  const wait = async (params: object) => (await callAction("tasks.wait", params)) as WaitResult;

  test("returns at once when every watched task rests; done needs no attention", async () => {
    await waitTask(ID_1, "w", "done");
    await waitTask(ID_2, "w", "cancelled");
    const started = Date.now();
    const result = await wait({ ids: [ID_1, ID_2.slice(0, 6)] });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect([result.tasks.map((view) => view.id), result.attention, result.timedOut]).toEqual([[ID_1, ID_2], [ID_2], false]);
    const done = await wait({ ids: [ID_1] });
    expect([done.attention, done.timedOut]).toEqual([[], false]);
  });

  test("returns when one task blocks while another has not finished", async () => {
    await waitTask(ID_1, "w");
    const blocking = await waitTask(ID_2, "w");
    setTimeout(() => writeSession(blocking, [stateEntry("blocked")]), 300);
    const result = await wait({ tag: "w", timeoutMs: 10_000 });
    expect(result.attention).toEqual([ID_2]);
    expect(result.timedOut).toBe(false);
    expect(result.tasks.map((view) => [view.id, view.state])).toEqual([
      [ID_1, null],
      [ID_2, "blocked"],
    ]);
  });

  test("tag: a task started during the wait is watched too", async () => {
    await waitTask(ID_1, "w/x");
    setTimeout(() => void waitTask(ID_2, "w/y", "waiting_approve"), 300);
    const result = await wait({ tag: "w", timeoutMs: 10_000 });
    expect([result.attention, result.timedOut]).toEqual([[ID_2], false]);
  });

  test("times out after timeoutMs while a task has not rested; no watched task answers at once", async () => {
    await waitTask(ID_1, "w");
    const started = Date.now();
    const result = await wait({ ids: [ID_1], timeoutMs: 1_000 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
    expect([result.tasks.map((view) => view.id), result.attention, result.timedOut]).toEqual([[ID_1], [], true]);
    expect(await wait({ tag: "nobody" })).toEqual({ tasks: [], waves: [], attention: [], timedOut: false });
  });

  test("an abort ends the wait", async () => {
    await waitTask(ID_1, "w");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await expectError(callAction("tasks.wait", { ids: [ID_1] }, { signal: controller.signal }), "failed", "tasks.wait was aborted");
  });

  test("an interrupted task (a running state, no runner) rests and needs attention (m7)", async () => {
    await waitTask(ID_1, "w", "running");
    const result = await wait({ ids: [ID_1], timeoutMs: 5_000 });
    expect([result.attention, result.timedOut, result.tasks[0].interrupted]).toEqual([[ID_1], false, true]);
  });

  test("a resting state with a live runner does not rest until the runner ends (m7)", async () => {
    const record = await waitTask(ID_1, "w", "blocked");
    const runner = Bun.spawn(["bun", exitingRunner, record.worktree, record.sessionDir, record.sessionId, "x"], { env: { ...process.env, FAKE_INBOX: taskInboxPath(record.id) } });
    await until(async () => (await liveRunners(record)).length === 1);
    const timedOut = await wait({ ids: [ID_1], timeoutMs: 1_000 });
    expect([timedOut.attention, timedOut.timedOut, timedOut.tasks[0].running]).toEqual([[], true, true]);
    setTimeout(() => writeFileSync(taskInboxPath(record.id), ""), 300);
    const ended = await wait({ ids: [ID_1], timeoutMs: 10_000 });
    expect([ended.attention, ended.timedOut]).toEqual([[ID_1], false]);
    await runner.exited;
  }, 30_000);

  test("a poll looks for no runner while that cannot end the wait: only the answer's views do (m5)", async () => {
    const pgrepLog = join(caseDir, "pgrep.log");
    const wrapperBin = join(caseDir, "pgrep-bin");
    mkdirSync(wrapperBin);
    const realPgrep = execFileSync("sh", ["-c", "command -v pgrep"], { encoding: "utf8" }).trim();
    writeFileSync(join(wrapperBin, "pgrep"), `#!/bin/sh\necho x >> "${pgrepLog}"\nexec "${realPgrep}" "$@"\n`, { mode: 0o755 });
    process.env.PATH = `${wrapperBin}:${process.env.PATH}`;
    await waitTask(ID_1, "w");
    await waitTask(ID_2, "w", "done");
    const result = await wait({ tag: "w", timeoutMs: 1_500 });
    expect(result.timedOut).toBe(true);
    // One lookup per task for the answer's TaskViews; the polls before it (a starting task, a done one) need none.
    expect(readFileSync(pgrepLog, "utf8").trim().split("\n")).toHaveLength(2);
  });

  test("invalid: ids and tag both or neither, empty ids, a timeout out of bounds", async () => {
    await waitTask(ID_1, "w", "done");
    await expectError(wait({}), "invalid", "tasks.wait needs exactly one of ids, tag and wave");
    await expectError(wait({ ids: [ID_1], tag: "w" }), "invalid", "tasks.wait needs exactly one of ids, tag and wave");
    await expectError(wait({ ids: [""] }), "invalid", "ids must hold non-empty strings");
    await expectError(wait({ ids: [ID_1], timeoutMs: 999 }), "invalid", "timeoutMs must be at least 1000");
    await expectError(wait({ ids: [ID_1], timeoutMs: 3_600_001 }), "invalid", "timeoutMs must be at most 3600000");
    expect(ACTIONS["tasks.wait"].mutates).toBe(false);
  });

  describe("a queued wave", () => {
    const FIRST = "60000000-0000-4000-8000-000000000001";
    const QUEUED = "60000000-0000-4000-8000-000000000002";
    /** `FIRST` resting `rejected` on the branch `main-q-first`, `QUEUED` declared after it (no branch yet). */
    async function waves(): Promise<void> {
      const common = { repo: "/r", plan: null, request: "r", target: "main", origin: null, overrides: {} };
      await createWave({ ...common, id: FIRST, tag: "q/first", title: "first", branch: "main-q-first", base: "abc", createdAt: "2026-01-01T00:00:00.000Z" });
      await appendWaveEvent(FIRST, { kind: "stage", stage: "rejected", reason: null });
      await createWave({ ...common, id: QUEUED, tag: "q/next", title: "next", branch: null, base: null, after: [FIRST], createdAt: "2026-01-02T00:00:00.000Z" });
    }

    test("neither rests nor needs attention while it can start: the wait goes on; the rejected wave it waits for answers", async () => {
      await waves();
      const queued = await wait({ wave: QUEUED, timeoutMs: 1_000 });
      expect([queued.waves.map((view) => view.stage), queued.attention, queued.timedOut]).toEqual([["queued"], [], true]);
      const both = await wait({ tag: "q", timeoutMs: 5_000 });
      expect([both.attention, both.timedOut]).toEqual([[FIRST], false]);
    });

    test("one that can never start (the wave it waits for was cancelled) needs attention at once", async () => {
      await waves();
      await appendWaveEvent(FIRST, { kind: "stage", stage: "cancelled", reason: null });
      const started = Date.now();
      const never = await wait({ wave: QUEUED, timeoutMs: 5_000 });
      expect(Date.now() - started).toBeLessThan(3_000);
      expect([never.attention, never.timedOut]).toEqual([[QUEUED], false]);
    });

    test("the action's summary names queued: the one that can never start needs attention, the one that can keeps the wait going", () => {
      const { summary } = ACTIONS["tasks.wait"];
      expect(summary).toContain("queued after a wave that was cancelled");
      expect(summary).toContain("a queued wave that can still start keeps the wait going");
    });
  });
});
