/** An adjustable plan (`core-plan.ts`): `tasks.update` and `waves.update`, over `core-test-kit.ts`. */
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { callAction } from "./core.ts";
import { launchSpec } from "./core-plan.ts";
import { caseDir, expectError, fakeRecord, makeRepo, RUN, runnerHolding, until, useCoreFixture } from "./core-test-kit.ts";
import { writeTask } from "./tasks.ts";
import { liveWaveRunners, waveLockPath } from "./wave-poke.ts";
import { appendWaveEvent, createWave, readWave, type WaveView } from "./waves.ts";

useCoreFixture();

const spec = (key: string, after: string[] = []) => ({ key, title: `Task ${key}`, request: `do ${key}`, after, id: crypto.randomUUID() });
const taskOf = (wave: WaveView, key: string) => wave.tasks.find((task) => task.key === key);
type Updated = { wave: WaveView; key: string; changed: boolean };
const update = async (params: Record<string, unknown>) => (await callAction("tasks.update", params)) as Updated;

/** A wave written directly, no runner; the tasks `started` get records and `task` events. */
async function writtenWave(n: number, tasks: ReturnType<typeof spec>[], started: string[] = []): Promise<{ id: string; ids: Map<string, string> }> {
  const repo = makeRepo(true, `repo-${n}`);
  const id = `50000000-${RUN}-4000-8000-00000000000${n}`;
  await createWave({ id, repo, tag: `plan/w${n}`, plan: null, title: "Wave", request: "review it", branch: `main-plan-w${n}`, target: "main", base: "abc", origin: null, createdAt: "2026-01-01T00:00:00.000Z", overrides: {} });
  const ids = new Map(tasks.map((task, index) => [task.key, `7${n}${index}00000-${RUN}-4000-8000-000000000000`]));
  await appendWaveEvent(id, { kind: "tasks", tasks: tasks.map((task) => ({ ...task, id: ids.get(task.key) as string })) });
  for (const key of started) {
    const record = { ...fakeRecord(ids.get(key) as string, repo), title: `Task ${key}`, wave: id };
    await writeTask(record);
    await appendWaveEvent(id, { kind: "task", key, taskId: record.id, sessionId: record.sessionId });
  }
  return { id, ids };
}

/** A live stand-in of the wave's runner; resolves with the function that ends it. */
async function fakeRunner(id: string): Promise<() => Promise<void>> {
  const end = join(caseDir, "runner-end");
  const child = await runnerHolding(waveLockPath(id), id, { ...process.env, FAKE_RUNNER_END: end });
  await until(async () => (await liveWaveRunners(id)).length === 1);
  return async () => {
    writeFileSync(end, "");
    await child.exited;
  };
}

describe("tasks.update", () => {
  test("a pending task changes; a started, launching or recorded one and a task of an ended wave are refused", async () => {
    const { id, ids } = await writtenWave(1, [spec("p"), spec("q"), spec("s"), spec("l"), spec("r")], ["s"]);
    const of = (key: string) => ids.get(key) as string;
    // A live runner holds the wave: the poke after a change starts nothing.
    const end = await fakeRunner(id);
    try {
      expect(await launchSpec(id, "l", [])).toMatchObject({ key: "l" });
      // A record under its declared id without a `task` event: a runner died between the launch and the event.
      await writeTask({ ...fakeRecord(of("r"), (await readWave(id)).declaration.repo), title: "Task r", wave: id });
      const changed = await update({ id: of("p").slice(0, 8), title: "Task P", request: "do P", after: ["q"] });
      expect(changed.changed).toBe(true);
      expect(taskOf(changed.wave, "p")).toMatchObject({ title: "Task P", after: ["q"] });
      expect((await update({ id: of("p"), title: "Task P" })).changed).toBe(false);
      for (const key of ["s", "l", "r"]) await expectError(update({ id: of(key), request: "r" }), "refused", "tasks.message");
    } finally {
      await end();
    }
    await appendWaveEvent(id, { kind: "stage", stage: "merged", reason: null });
    await expectError(update({ id: of("q"), request: "r" }), "refused", "merged");
    await expectError(callAction("waves.update", { id, request: "r" }), "refused", "merged");
  });
});

describe("waves.update", () => {
  test("replaces title and reviewer instructions, an event shown by waves.get; nothing changed without one", async () => {
    const { id } = await writtenWave(4, [spec("a")]);
    await expectError(callAction("waves.update", { id }), "invalid", "needs title or request");
    const { wave, changed } = (await callAction("waves.update", { id, title: "Wave two", request: "check the docs too" })) as { wave: WaveView; changed: boolean };
    expect([changed, wave.title, wave.request]).toEqual([true, "Wave two", "check the docs too"]);
    expect(wave.updates).toEqual([{ at: expect.any(String), key: null, fields: ["title", "request"] }]);
    expect(((await callAction("waves.update", { id, title: "Wave two" })) as { changed: boolean }).changed).toBe(false);
    expect((await readWave(id)).declaration.request).toBe("review it");
  });
});
