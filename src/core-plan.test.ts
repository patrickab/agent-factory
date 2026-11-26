/** An adjustable plan (`core-plan.ts`): `tasks.update`, `waves.update` and the start an update races, over `core-test-kit.ts`. */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentView } from "./agent-view.ts";
import { callAction } from "./core.ts";
import { launchSpec, recordStart } from "./core-plan.ts";
import { startWaveTasks } from "./core-waves.ts";
import { caseDir, expectError, fakeRecord, fakeWaveRunner, git, ID_1, makeRepo, RUN, until, useCoreFixture, writeSession } from "./core-test-kit.ts";
import type { TaskView } from "./core-tasks.ts";
import { taskInboxPath } from "./launch.ts";
import { readTask, writeTask, type TaskRecord } from "./tasks.ts";
import { liveWaveRunners, stopWaveRunners } from "./wave-poke.ts";
import { appendWaveEvent, createWave, foldWave, parseWaveFile, readWave, type WaveView } from "./waves.ts";

useCoreFixture();

const spec = (key: string, after: string[] = []) => ({ key, title: `Task ${key}`, request: `do ${key}`, after });
const getWave = async (id: string) => ((await callAction("waves.get", { id })) as { wave: WaveView }).wave;
const taskOf = (wave: WaveView, key: string) => wave.tasks.find((task) => task.key === key);
type Updated = { wave: WaveView; key: string; changed: boolean; delivery: string };
const update = async (params: Record<string, unknown>) => (await callAction("tasks.update", params)) as Updated;

/** A wave written directly, no runner; `states` gives started tasks (key -> session state) records and `task` events. */
async function writtenWave(n: number, tasks: ReturnType<typeof spec>[], states: Record<string, string> = {}): Promise<{ id: string; records: Map<string, TaskRecord>; ids: Map<string, string> }> {
  const repo = makeRepo(true, `repo-${n}`);
  const id = `50000000-${RUN}-4000-8000-00000000000${n}`;
  await createWave({ id, repo, tag: `plan/w${n}`, plan: null, title: "Wave", request: "review it", branch: `main-plan-w${n}`, target: "main", base: "abc", origin: null, createdAt: "2026-01-01T00:00:00.000Z", overrides: {} });
  const ids = new Map(tasks.map((task, index) => [task.key, `7${n}${index}00000-${RUN}-4000-8000-000000000000`]));
  await appendWaveEvent(id, { kind: "tasks", tasks: tasks.map((task) => ({ ...task, id: ids.get(task.key) })) });
  const records = new Map<string, TaskRecord>();
  for (const [key, state] of Object.entries(states)) {
    const record = { ...fakeRecord(ids.get(key) as string, repo), title: `Task ${key}`, wave: id };
    await writeTask(record);
    writeSession(record, [{ type: "custom", customType: "factory-state", data: { state, round: 1, reason: "r" } }]);
    await appendWaveEvent(id, { kind: "task", key, taskId: record.id, sessionId: record.sessionId });
    records.set(key, record);
  }
  return { id, records, ids };
}

/** A live stand-in of the wave's runner; resolves with the function that ends it. */
async function fakeRunner(id: string): Promise<() => Promise<void>> {
  const end = join(caseDir, "runner-end");
  const child = Bun.spawn(["bun", fakeWaveRunner, id], { env: { ...process.env, FAKE_RUNNER_END: end } });
  await until(async () => (await liveWaveRunners(id)).length === 1);
  return async () => {
    writeFileSync(end, "");
    await child.exited;
  };
}

describe("tasks.update", () => {
  test("a pending task starts with the updated request, title, model and predecessors; a running one is told old and new", async () => {
    process.env.FAKE_PI_HOLD = "1";
    const messages = join(caseDir, "messages.log");
    process.env.FAKE_PI_MESSAGE_LOG = messages;
    const repo = makeRepo();
    await callAction("repos.add", {}, { cwd: repo });
    const params = { tag: "plan/w1", title: "Wave", request: "review it", tasks: [spec("a"), spec("b", ["a"]), spec("c", ["b"])], overrides: { models: { small: "c/d", big: "a/b" } } };
    const { wave } = (await callAction("waves.start", params, { cwd: repo })) as { wave: WaveView };
    await until(async () => taskOf(await getWave(wave.id), "a")?.taskId != null);
    const a = (await getWave(wave.id)).tasks[0];
    await until(async () => ((await callAction("tasks.get", { id: a.taskId })) as TaskView).state === "running");

    // A pending task's id, declared with it, from waves.get.
    const bId = taskOf(await getWave(wave.id), "b")?.id as string;
    expect(bId).toMatch(/^[0-9a-f-]{36}$/);
    expect(taskOf(await getWave(wave.id), "b")?.taskId).toBeNull();
    expect(await callAction("waves.get", { id: wave.id }).then((answer) => agentView("waves.get", {}, answer))).toContain(`b pending (${bId.slice(0, 8)})`);
    await expectError(callAction("tasks.get", { id: bId.slice(0, 8) }), "refused", "has not started yet: tasks.update changes it, waves.get shows it");
    // Pending: after is checked as at waves.add.
    await expectError(update({ id: bId, after: ["b"] }), "invalid", "waits for itself");
    await expectError(update({ id: bId, after: ["nope"] }), "invalid", "waits for nope");
    await expectError(update({ id: bId, after: ["c"] }), "invalid", "cycle: b -> c -> b");
    const changed = await update({ id: bId.slice(0, 8), title: "Task B", request: "do B, not b", model: "small", after: [] });
    expect([changed.changed, changed.delivery]).toEqual([true, "pending"]);
    expect(taskOf(changed.wave, "b")).toMatchObject({ title: "Task B", after: [], model: "small" });
    expect(changed.wave.updates).toEqual([{ at: expect.any(String), key: "b", fields: ["title", "request", "after", "model"] }]);
    // Its after is done now (none): the poke starts it with the new spec.
    await until(async () => taskOf(await getWave(wave.id), "b")?.taskId != null);
    const b = (await getWave(wave.id)).tasks[1];
    // The started task carries the id it was declared with.
    expect([b.taskId, b.id]).toEqual([bId, bId]);
    const view = (await callAction("tasks.get", { id: b.taskId })) as TaskView;
    expect([view.title, view.settings?.models?.coder]).toEqual(["Task B", "c/d"]);
    await until(() => existsSync(messages) && readFileSync(messages, "utf8").includes("do B, not b"));

    // Running: title and request only, its coder gets old and new through its runner's inbox.
    await expectError(update({ id: a.taskId, after: [] }), "refused", "has started (running): its after and model are fixed");
    await expectError(update({ id: a.taskId, model: "small" }), "refused", "add a task with waves.add");
    const told = await update({ id: a.taskId, request: "do a, and docs" });
    expect([told.changed, told.delivery]).toEqual([true, "sent"]);
    expect(taskOf(told.wave, "a")?.title).toBe("Task a");
    const inbox = readFileSync(taskInboxPath(a.taskId as string), "utf8");
    expect(JSON.parse(inbox.trim().split("\n").at(-1) as string).text).toBe("Your task changed, follow the new text:\n- request\n  old: do a\n  new: do a, and docs");
    // The same text again changes nothing.
    expect((await update({ id: a.taskId, request: "do a, and docs" })).changed).toBe(false);
    await stopWaveRunners(wave.id);
  }, 30_000);

  test("each refusal: the params, a task that cannot change, a wave that ended", async () => {
    const { id, records, ids } = await writtenWave(1, [spec("d"), spec("x"), spec("m"), spec("q"), spec("w"), spec("p")], { d: "done", x: "cancelled", m: "merging", q: "waiting_answer", w: "waiting_approve" });
    const of = (key: string) => ids.get(key) as string;
    await expectError(update({ request: "r" }), "invalid", "tasks.update needs id");
    await expectError(update({ id: of("p") }), "invalid", "needs title, request, after or model");
    await expectError(update({ id: of("p"), request: " " }), "invalid", "request must not be empty");
    await expectError(update({ id: of("p"), model: "x/y" }), "invalid", 'model must be "small" or "big"');
    await expectError(update({ id: `ffff0000-${RUN}`, request: "r" }), "not_found", "no task has an id starting with");
    for (const [key, state] of [["d", "done"], ["x", "cancelled"], ["m", "merging"]]) {
      await expectError(update({ id: of(key), request: "r" }), "refused", `task ${key} of wave ${id.slice(0, 8)} is ${state}, it cannot change: add a task with waves.add`);
    }
    await expectError(update({ id: of("w"), request: "r" }), "refused", "waits for approve");
    // A plain task belongs to no wave.
    await writeTask({ ...fakeRecord(`60000000-${RUN}-4000-8000-000000000001`, makeRepo(true, "plain")), wave: null });
    await expectError(update({ id: `60000000-${RUN}`, request: "r" }), "refused", "belongs to no wave");
    // Waiting for an answer: the change waits on its record and goes with the answer (the runner's notes).
    const kept = await update({ id: of("q"), title: "Task Q" });
    expect(kept.delivery).toBe("kept");
    expect((await readTask((records.get("q") as TaskRecord).id)).contractNotes).toEqual(["Your task changed, follow the new text:\n- title\n  old: Task q\n  new: Task Q"]);
    await appendWaveEvent(id, { kind: "stage", stage: "merged", reason: null });
    await expectError(update({ id: of("p"), request: "r" }), "refused", "is merged, its tasks cannot change");
    await expectError(callAction("waves.update", { id, request: "r" }), "refused", "is merged, it cannot change");
  });

  test("an update racing the start: after and model refused, the new text reaches the coder once it started", async () => {
    const { id, ids } = await writtenWave(2, [spec("a")]);
    const aId = ids.get("a") as string;
    const end = await fakeRunner(id);
    try {
      const launched = await launchSpec(id, "a", []);
      expect(launched).toMatchObject({ key: "a", request: "do a" });
      await expectError(update({ id: aId, model: "small" }), "refused", "has started (starting)");
      const raced = await update({ id: aId, request: "do a better" });
      expect([raced.changed, raced.delivery]).toEqual([true, "starting"]);
      // The launch went out with the old text; recording the start tells the coder.
      const record = { ...fakeRecord(aId, (await readWave(id)).declaration.repo), title: "Task a", wave: id };
      await writeTask(record);
      writeSession(record, [{ type: "custom", customType: "factory-state", data: { state: "running", round: 1, reason: "start" } }]);
      const note = await recordStart(id, "a", launched as NonNullable<typeof launched>, record);
      expect(note).toBe("Your task changed, follow the new text:\n- request\n  old: do a\n  new: do a better");
      // No live task runner here: it waits on the record for the runner's next look.
      expect((await readTask(aId)).contractNotes).toEqual([note as string]);
      expect(taskOf(await getWave(id), "a")).toMatchObject({ taskId: aId, id: aId });
      expect(await recordStart(id, "a", { title: "Task a", request: "do a better" }, record)).toBeNull();
    } finally {
      await end();
    }
  });

  test("a launch its runner did not finish (no live runner) leaves the task pending; launchSpec skips a task whose after changed", async () => {
    const { id, ids } = await writtenWave(3, [spec("a"), spec("b")]);
    expect(await launchSpec(id, "a", ["b"])).toBeNull();
    expect(await launchSpec(id, "a", [])).not.toBeNull();
    const changed = await update({ id: ids.get("a"), model: "small", after: ["b"] });
    expect([changed.delivery, taskOf(changed.wave, "a")?.model, taskOf(changed.wave, "a")?.after]).toEqual(["pending", "small", ["b"]]);
    await appendWaveEvent(id, { kind: "stage", stage: "cancelled", reason: null });
    expect(await launchSpec(id, "b", [])).toBeNull();
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

describe("old logs", () => {
  test("a spec without an id (a log written before ids) launches with a new id; one with an id launches with it", async () => {
    const repo = makeRepo(true, "repo-old");
    git(repo, "branch", "main-plan-old");
    const id = `50000000-${RUN}-4000-8000-000000000008`;
    await createWave({ id, repo, tag: "plan/old", plan: null, title: "W", request: "r", branch: "main-plan-old", target: "main", base: git(repo, "rev-parse", "main"), origin: null, createdAt: "2026-01-01T00:00:00.000Z", overrides: {} });
    const declared = `7f000000-${RUN}-4000-8000-000000000000`;
    await appendWaveEvent(id, { kind: "tasks", tasks: [spec("old"), { ...spec("new"), id: declared }] });
    expect(taskOf(await getWave(id), "old")?.id).toBeUndefined();
    expect(await startWaveTasks(id)).toEqual(["old", "new"]);
    const wave = await getWave(id);
    const old = taskOf(wave, "old");
    expect(old?.taskId).toMatch(/^[0-9a-f-]{36}$/);
    expect(old?.taskId).not.toBe(declared);
    expect([old?.id, taskOf(wave, "new")?.taskId]).toEqual([old?.taskId, declared]);
    expect((await readTask(declared)).wave).toBe(id);
    await expectError(update({ id: `ffff1111-${RUN}`, request: "r" }), "not_found", "no task has an id");
  });

  test("a log without update or launch events folds as before: no updates, no launching", () => {
    const id = `50000000-${RUN}-4000-8000-000000000009`;
    const declaration = { id, repo: "/r", tag: "t", plan: null, title: "W", request: "r", branch: "main-t", target: "main", base: "abc", origin: null, createdAt: "2026-01-01T00:00:00.000Z", overrides: {} };
    const lines = [
      declaration,
      { at: "2026-01-01T00:00:01.000Z", kind: "tasks", tasks: [{ key: "a", title: "A", request: "do a", after: [] }] },
      { at: "2026-01-01T00:00:02.000Z", kind: "task", key: "a", taskId: ID_1, sessionId: "s" },
      { at: "2026-01-01T00:00:03.000Z", kind: "stage", stage: "reviewing", reason: null },
    ];
    const { declaration: parsed, events } = parseWaveFile(lines.map((line) => `${JSON.stringify(line)}\n`).join(""), id);
    const fold = foldWave(parsed, events);
    expect(fold).toEqual({
      ...declaration,
      after: [],
      stage: "reviewing",
      reason: null,
      detail: null,
      tasks: [{ key: "a", title: "A", request: "do a", after: [], model: "big", taskId: ID_1, sessionId: "s" }],
      reviews: [],
      gates: [],
      merge: null,
      remote: null,
    });
    // A started task's update keeps its after and model; the wave's changes its title and request.
    const later = [
      ...events,
      { at: "2026-01-01T00:00:04.000Z", kind: "update" as const, key: "a", request: "do a well", model: "small" as const },
      { at: "2026-01-01T00:00:05.000Z", kind: "update" as const, request: "review the docs" },
    ];
    const updated = foldWave(parsed, later);
    expect([updated.tasks[0].request, updated.tasks[0].model, updated.request]).toEqual(["do a well", "big", "review the docs"]);
    expect(updated.updates?.map((entry) => [entry.key, entry.fields])).toEqual([["a", ["request"]], [null, ["request"]]]);
  });
});
