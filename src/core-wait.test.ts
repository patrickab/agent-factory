/** The core's `tasks.wait` over tasks (`core-wait.ts`), over the fixture of `core-test-kit.ts`; over waves: `core-waves.test.ts`. */
import { describe, expect, test } from "bun:test";
import { callAction } from "./core.ts";
import type { TaskView } from "./core-tasks.ts";
import { expectError, fakeRecord, ID_1, ID_2, TASK_ENTRY, useCoreFixture, writeSession } from "./core-test-kit.ts";
import { writeTask, type TaskRecord } from "./tasks.ts";
import type { WaveView } from "./waves.ts";

useCoreFixture();

describe("tasks.wait", () => {
  const stateEntry = (state: string) => ({ type: "custom", customType: "factory-state", timestamp: "t", data: { state, round: 1, reason: "r" } });

  /** A task tagged `tag`: resting in `state`, or starting (no session file) without one. */
  async function waitTask(id: string, tag: string, state?: string): Promise<TaskRecord> {
    const record = { ...fakeRecord(id, "/r"), tag };
    await writeTask(record);
    if (state !== undefined) writeSession(record, [TASK_ENTRY, stateEntry(state)]);
    return record;
  }

  type WaitResult = { tasks: TaskView[]; waves: WaveView[]; attention: string[]; timedOut: boolean };
  const wait = async (params: object) => (await callAction("tasks.wait", params)) as WaitResult;

  test("returns at once when every watched task rests; done needs no attention", async () => {
    await waitTask(ID_1, "w", "done");
    await waitTask(ID_2, "w", "cancelled");
    // At once: no timeoutMs, a wait that did not end would outlast the test.
    const result = await wait({ ids: [ID_1, ID_2.slice(0, 6)] });
    expect([result.tasks.map((view) => view.id), result.attention, result.timedOut]).toEqual([[ID_1, ID_2], [ID_2], false]);
    const done = await wait({ ids: [ID_1] });
    expect([done.attention, done.timedOut]).toEqual([[], false]);
  });

  test("returns when one task blocks while another has not finished", async () => {
    await waitTask(ID_1, "w");
    const blocking = await waitTask(ID_2, "w");
    setTimeout(() => writeSession(blocking, [TASK_ENTRY, stateEntry("blocked")]), 300);
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
    const result = await wait({ ids: [ID_1], timeoutMs: 1_000 });
    expect([result.tasks.map((view) => view.id), result.attention, result.timedOut]).toEqual([[ID_1], [], true]);
    expect(await wait({ tag: "nobody" })).toEqual({ tasks: [], waves: [], attention: [], timedOut: false });
  });

  test("an abort ends the wait", async () => {
    await waitTask(ID_1, "w");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await expectError(callAction("tasks.wait", { ids: [ID_1] }, { signal: controller.signal }), "failed");
  });

  test("an interrupted task (a running state, no runner) rests and needs attention", async () => {
    await waitTask(ID_1, "w", "running");
    const result = await wait({ ids: [ID_1], timeoutMs: 5_000 });
    expect([result.attention, result.timedOut, result.tasks[0].interrupted]).toEqual([[ID_1], false, true]);
  });
});
