/** The core's `tasks.wait` over tasks (`core-wait.ts`), over the fixture of `core-test-kit.ts`; over waves: `core-waves.test.ts`. */
import { describe, expect, test } from "bun:test";
import { callAction } from "./core.ts";
import type { TaskView } from "./core-tasks.ts";
import { expectError, fakeRecord, ID_1, ID_2, useCoreFixture, writeSession } from "./core-test-kit.ts";
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

  test("an interrupted task (a running state, no runner) rests and needs attention", async () => {
    await waitTask(ID_1, "w", "running");
    const result = await wait({ ids: [ID_1], timeoutMs: 5_000 });
    expect([result.attention, result.timedOut, result.tasks[0].interrupted]).toEqual([[ID_1], false, true]);
  });

  describe("a queued wave", () => {
    const FIRST = "60000000-0000-4000-8000-000000000001";
    const QUEUED = "60000000-0000-4000-8000-000000000002";
    /** `FIRST` resting `rejected` on the branch `main-q-first`, `QUEUED` declared after it. */
    async function waves(): Promise<void> {
      const common = { repo: "/r", plan: null, request: "r", target: "main", origin: null, overrides: {} };
      await createWave({ ...common, id: FIRST, tag: "q/first", title: "first", branch: "main-q-first", base: "abc", createdAt: "2026-01-01T00:00:00.000Z" });
      await appendWaveEvent(FIRST, { kind: "stage", stage: "rejected", reason: null });
      await createWave({ ...common, id: QUEUED, tag: "q/next", title: "next", branch: "main-q-next", base: "abc", after: [FIRST], createdAt: "2026-01-02T00:00:00.000Z" });
    }

    test("one that can never start (the wave it waits for was cancelled) needs attention at once", async () => {
      await waves();
      await appendWaveEvent(FIRST, { kind: "stage", stage: "cancelled", reason: null });
      const started = Date.now();
      const never = await wait({ wave: QUEUED, timeoutMs: 5_000 });
      expect(Date.now() - started).toBeLessThan(3_000);
      expect([never.attention, never.timedOut]).toEqual([[QUEUED], false]);
    });

  });
});
