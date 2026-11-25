/** The core's wave actions, `tasks.wait` over waves and what the wave's runner asks (`core-waves.ts`), over the fixture of `core-test-kit.ts`. */
import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACTIONS, callAction } from "./core.ts";
import type { TaskView } from "./core-tasks.ts";
import { caseDir, expectError, failure, fakeRecord, fakeWaveRunner, git, ID_1, ID_2, ID_3, makeRepo, modelsFile, prompts, RUN, runnerEnded, stateOf, until, useCoreFixture, writeSession } from "./core-test-kit.ts";
import { startWaveTasks, taskWave, waveMergeRefusal, waveReviewWorktree } from "./core-waves.ts";
import { defaultModels } from "./settings.ts";
import { listTasks, writeTask, type TaskRecord } from "./tasks.ts";
import { liveWaveRunners, pokeWave, stopWaveRunners, wavePokePath } from "./wave-poke.ts";
import { appendWaveEvent, createWave, listWaves, readWave, type WaveView } from "./waves.ts";

useCoreFixture();

describe("waves", () => {
  const spec = (key: string, after: string[] = []) => ({ key, title: `Task ${key}`, request: `do ${key}`, after });
  const TAG = "factory/w1";

  async function registeredRepo(withConfig = true): Promise<string> {
    const repo = makeRepo(withConfig);
    await callAction("repos.add", {}, { cwd: repo });
    return repo;
  }

  async function startWave(repo: string, tasks: unknown, extra: Record<string, unknown> = {}): Promise<WaveView> {
    const params = { tag: TAG, title: "Wave one", request: "review the wave", tasks, ...extra };
    return ((await callAction("waves.start", params, { cwd: repo, origin: "session-0" })) as { wave: WaveView }).wave;
  }

  const getWave = async (id: string) => ((await callAction("waves.get", { id })) as { wave: WaveView }).wave;
  const recordById = async (id: string | null) => {
    const record = (await listTasks()).find((task) => task.id === id);
    if (!record) throw new Error(`no task ${id}`);
    return record;
  };
  const taskOf = (wave: WaveView, key: string) => {
    const task = wave.tasks.find((candidate) => candidate.key === key);
    if (!task) throw new Error(`no task ${key}`);
    return task;
  };

  /** A wave written directly (no branch, no runner): for the reads. */
  async function writtenWave(id: string, repo: string, tag: string, createdAt = "2026-01-01T00:00:00.000Z"): Promise<void> {
    await createWave({ id, repo, tag, plan: null, title: `wave ${tag}`, request: "r", branch: `main-${tag}`, target: "main", base: "abc", origin: null, createdAt, overrides: {} });
  }

  test("waves.start creates the branch off the target, the record and starts the tasks that wait for nothing", async () => {
    const repo = await registeredRepo();
    const main = git(repo, "rev-parse", "main");
    const overrides = { maxRounds: 3, merge: "review" as const, models: { small: "c/d", big: "a/b" } };
    let wave = await startWave(repo, [spec("a"), spec("b", ["a"]), spec("c")], { plan: "plan/w1.md", overrides });
    expect(wave).toMatchObject({ repo, tag: TAG, plan: "plan/w1.md", title: "Wave one", request: "review the wave", branch: "main-factory-w1", target: "main", base: main });
    expect(wave).toMatchObject({ origin: "session-0", stage: "building", reason: null, counts: { total: 3, done: 0 } });
    expect("overrides" in wave).toBe(false);
    expect(git(repo, "rev-parse", "refs/heads/main-factory-w1")).toBe(main);
    // The wave's runner starts the tasks that wait for nothing; it lives while the wave does not rest.
    await until(async () => (await getWave(wave.id)).tasks.filter((task) => task.taskId !== null).length === 2);
    wave = await getWave(wave.id);
    expect([wave.running, wave.interrupted]).toEqual([true, false]);
    expect(taskOf(wave, "b")).toEqual({ key: "b", title: "Task b", after: ["a"], model: "big", taskId: null, sessionId: null, state: "pending", usage: null });
    for (const key of ["a", "c"]) {
      const task = taskOf(wave, key);
      const record = await recordById(task.taskId);
      expect(task.sessionId).toBe(record.sessionId);
      expect(record).toMatchObject({ wave: wave.id, tag: TAG, plan: "plan/w1.md", title: `Task ${key}` });
      expect(git(record.worktree, "rev-parse", "HEAD")).toBe(main);
      await until(async () => (await stateOf(record)) === "waiting_approve");
      const view = (await callAction("tasks.get", { id: record.id })) as TaskView;
      expect(view.wave).toBe(wave.id);
      // The wave's settings, its branch as the target, and a task merges by itself.
      expect(view.settings).toEqual({ branch: "main-factory-w1", merge: "auto", maxRounds: 3, review: false, models: { small: "c/d", big: "a/b", coder: "a/b" } });
    }
    const file = await readWave(wave.id);
    // Stored resolved: the overrides over the repository's stored settings (none here) over the defaults.
    expect(file.declaration.overrides).toEqual({ ...overrides, models: { ...overrides.models, coder: "a/b" }, review: false, remote: false });
    expect(file.events.map((event) => event.kind)).toEqual(["tasks", "task", "task"]);
    expect(prompts().filter((line) => line === "prompt /factory start")).toHaveLength(2);
    // The same tag on the same target: its branch exists.
    await expectError(startWave(repo, [spec("x")]), "refused", "main-factory-w1 exists already");
  });

  test("waves.start stores the repository's stored settings with the overrides over them, resolved; a later change does not reach the wave", async () => {
    const repo = await registeredRepo();
    await callAction("settings.set", { repo, settings: { merge: "review", maxRounds: 4, models: { coder: "a/b", reviewer: "c/d" } } });
    const wave = await startWave(repo, [spec("a")], { overrides: { maxRounds: 1, models: { coder: "c/d" } } });
    // Its runner's launch ends before the test does: a runner stopped mid-launch outlasts the test's time.
    await until(async () => taskOf(await getWave(wave.id), "a").taskId !== null);
    // Models merged per name: the override's coder (big its alias), the stored reviewer.
    const resolved = { merge: "review" as const, maxRounds: 1, review: false, models: { coder: "c/d", big: "c/d", reviewer: "c/d" }, remote: false };
    expect((await readWave(wave.id)).declaration.overrides).toEqual(resolved);
    await callAction("settings.set", { repo, settings: { merge: "auto", models: { reviewer: "a/b" } } });
    expect((await readWave(wave.id)).declaration.overrides).toEqual(resolved);
  });

  test("a task with after starts once its predecessor is done (its runner pokes the wave); a wave without changes ends merged", async () => {
    // The wave runner never polls in this test: only the pokes of the tasks' runners move it on.
    process.env.FACTORY_WAVE_POLL_MS = "600000";
    process.env.FAKE_PI_START_END = "done";
    const repo = await registeredRepo();
    const wave = await startWave(repo, [spec("a"), spec("b", ["a"])]);
    expect(taskOf(wave, "b").state).toBe("pending");
    await until(async () => taskOf(await getWave(wave.id), "b").taskId !== null, 20_000);
    const a = await recordById(taskOf(await getWave(wave.id), "a").taskId);
    expect(await stateOf(a)).toBe("done");
    const b = await recordById(taskOf(await getWave(wave.id), "b").taskId);
    expect(b.wave).toBe(wave.id);
    // Nothing differs from the target: no review, no merge, the wave rests merged and its runner ends.
    await until(async () => (await getWave(wave.id)).stage === "merged", 20_000);
    await until(async () => (await liveWaveRunners(wave.id)).length === 0);
    const done = await getWave(wave.id);
    expect([done.counts, done.merge, done.running, done.interrupted]).toEqual([{ total: 2, done: 2 }, null, false, false]);
    expect((await readWave(wave.id)).events.map((event) => event.kind)).toEqual(["tasks", "task", "task", "stage", "stage"]);
  }, 30_000);

  test("waves.add to a rejected wave returns it to building; after may name existing keys", async () => {
    const repo = await registeredRepo();
    const wave = await startWave(repo, [spec("a")]);
    await until(async () => taskOf(await getWave(wave.id), "a").taskId !== null);
    await appendWaveEvent(wave.id, { kind: "stage", stage: "rejected", reason: null });
    expect((await getWave(wave.id)).stage).toBe("rejected");
    // A stage change pokes the runner (as the actions do), which sees the wave rest and ends.
    await pokeWave(wave.id);
    await until(async () => (await liveWaveRunners(wave.id)).length === 0);
    const added = ((await callAction("waves.add", { id: wave.id.slice(0, 8), tasks: [spec("fix", ["a"]), spec("more")] })) as { wave: WaveView }).wave;
    expect(added.stage).toBe("building");
    expect(taskOf(added, "fix").state).toBe("pending");
    expect(added.counts).toEqual({ total: 3, done: 0 });
    // The poke started a runner again: it starts what can start.
    await until(async () => taskOf(await getWave(wave.id), "more").taskId !== null);
    expect(taskOf(await getWave(wave.id), "fix").taskId).toBeNull();
    await stopWaveRunners(wave.id);
    const kinds = (await readWave(wave.id)).events.map((event) => event.kind);
    expect(kinds).toEqual(["tasks", "task", "stage", "tasks", "stage", "task"]);
    await expectError(callAction("waves.add", { id: wave.id, tasks: [spec("a")] }), "invalid", "task key a is not unique");
    await expectError(callAction("waves.add", { id: wave.id, tasks: [spec("x", ["nope"])] }), "invalid", "waits for nope");
    await appendWaveEvent(wave.id, { kind: "stage", stage: "merged", reason: null });
    await expectError(callAction("waves.add", { id: wave.id, tasks: [spec("late")] }), "refused", "is merged");
    await expectError(callAction("waves.add", { id: "ffffffff", tasks: [spec("late")] }), "not_found", "no wave");
  }, 30_000);

  test("a wave's small task runs its coder on the small model, its neighbour on the big one (coder); no reviewer named, none", async () => {
    const repo = await registeredRepo();
    const models = { small: "c/d", big: "a/b" };
    const wave = await startWave(repo, [{ ...spec("cheap"), model: "small" }, spec("other")], { overrides: { models } });
    expect(taskOf(wave, "cheap").model).toBe("small");
    expect(taskOf(wave, "other").model).toBe("big");
    await until(async () => (await getWave(wave.id)).tasks.every((task) => task.taskId !== null));
    const settingsOf = async (key: string) => ((await callAction("tasks.get", { id: taskOf(await getWave(wave.id), key).taskId })) as TaskView).settings?.models;
    expect(await settingsOf("cheap")).toEqual({ small: "c/d", coder: "c/d" });
    expect(await settingsOf("other")).toEqual({ ...models, coder: "a/b" });
    const [tasks] = (await readWave(wave.id)).events;
    expect(tasks).toMatchObject({ kind: "tasks", tasks: [{ key: "cheap", model: "small" }, { key: "other" }] });
    expect(tasks.kind === "tasks" && "model" in tasks.tasks[1]).toBe(false);
    expect((await readWave(wave.id)).declaration.overrides.models).toEqual({ ...models, coder: "a/b" });
  });

  test("a wave that names no model: a small task takes defaults.yaml's small when it is listed, else none; big and the reviewer none", async () => {
    const repo = await registeredRepo();
    const { small, big } = defaultModels();
    const settingsOf = async (id: string, key: string) => ((await callAction("tasks.get", { id: taskOf(await getWave(id), key).taskId })) as TaskView).settings?.models;
    // Off the list: skipped (Pi's session model), never refused.
    const off = await startWave(repo, [{ ...spec("cheap"), model: "small" }, spec("other")]);
    await until(async () => (await getWave(off.id)).tasks.every((task) => task.taskId !== null));
    expect(await settingsOf(off.id, "cheap")).toEqual({});
    expect(await settingsOf(off.id, "other")).toEqual({});
    expect((await readWave(off.id)).declaration.overrides.models).toEqual({});
    await stopWaveRunners(off.id);
    // Listed: the small task's coder runs on it; the big default still never applies.
    writeFileSync(modelsFile(), `- a/b\n- ${small}\n- ${big}\n`);
    const on = await startWave(repo, [{ ...spec("cheap"), model: "small" }, spec("other")], { tag: `${TAG}-on` });
    await until(async () => (await getWave(on.id)).tasks.every((task) => task.taskId !== null));
    expect(await settingsOf(on.id, "cheap")).toEqual({ small, coder: small });
    expect(await settingsOf(on.id, "other")).toEqual({ small });
    await stopWaveRunners(on.id);
  }, 30_000);

  test("a concrete model id in a wave's task is invalid before anything is created; a small model off the list is refused; waves.add takes small too", async () => {
    const repo = await registeredRepo();
    const start = (tasks: unknown[], overrides?: object) => callAction("waves.start", { tag: TAG, title: "t", request: "r", tasks, overrides }, { cwd: repo });
    await expectError(start([spec("a"), { ...spec("b"), model: "c/d" }]), "invalid", 'tasks[1].model must be "small" or "big"');
    await expectError(start([{ ...spec("a"), model: 4 }]), "invalid", "tasks[0].model");
    await expectError(start([{ ...spec("a"), model: "small" }], { models: { small: "x/y", big: "a/b" } }), "refused", "the small model x/y is not a factory model");
    expect(git(repo, "branch", "--list", "main-*")).toBe("");
    expect(await listWaves()).toEqual([]);
    expect(await listTasks()).toEqual([]);

    const wave = await startWave(repo, [spec("a")], { overrides: { models: { small: "c/d", big: "a/b" } } });
    await until(async () => taskOf(await getWave(wave.id), "a").taskId !== null);
    const add = (tasks: unknown[]) => callAction("waves.add", { id: wave.id, tasks });
    const before = (await readWave(wave.id)).events.length;
    await expectError(add([{ ...spec("bad"), model: "c/d" }]), "invalid", 'tasks[0].model must be "small" or "big"');
    expect((await readWave(wave.id)).events).toHaveLength(before);
    const added = ((await add([{ ...spec("fix", ["a"]), model: "small" }])) as { wave: WaveView }).wave;
    expect(taskOf(added, "fix")).toMatchObject({ model: "small", state: "pending" });
    expect((await readWave(wave.id)).events.at(-1)).toMatchObject({ kind: "tasks", tasks: [{ key: "fix", model: "small" }] });
  }, 30_000);

  test("every validation error of waves.start, and none leaves a branch or a wave", async () => {
    const repo = await registeredRepo();
    const start = (params: Record<string, unknown>, cwd = repo) =>
      callAction("waves.start", { tag: TAG, title: "t", request: "r", tasks: [spec("a")], ...params }, { cwd });
    await expectError(callAction("waves.start", { title: "t", request: "r", tasks: [spec("a")] }, { cwd: repo }), "invalid", "needs tag");
    await expectError(start({ tag: "a//b" }), "invalid", "is not segments");
    await expectError(start({ title: " " }), "invalid", "title");
    await expectError(start({ request: "" }), "invalid", "request");
    await expectError(start({ plan: "" }), "invalid", "plan");
    await expectError(start({ tasks: [] }), "invalid", "non-empty array");
    await expectError(start({ tasks: "a" }), "invalid", "must be an array");
    await expectError(start({ tasks: [spec("a b")] }), "invalid", "key");
    await expectError(start({ tasks: [spec("a"), spec("a")] }), "invalid", "not unique");
    await expectError(start({ tasks: [{ key: "a", title: "t" }] }), "invalid", "request");
    await expectError(start({ tasks: [spec("a", ["b"])] }), "invalid", "waits for b");
    await expectError(start({ tasks: [spec("a", ["b"]), spec("b", ["a"])] }), "invalid", "cycle");
    await expectError(start({ overrides: { maxRounds: 0 } }), "invalid", "maxRounds");
    await expectError(start({ overrides: { models: { coder: "x/y" } } }), "refused", "x/y");
    await expectError(start({ overrides: { branch: "nope" } }), "not_found", "no local branch nope");
    const unregistered = makeRepo(true, "other");
    await expectError(start({}, unregistered), "not_found", "is not registered");
    const bare = makeRepo(false, "bare");
    await callAction("repos.add", {}, { cwd: bare });
    await expectError(start({}, bare), "refused", "has no factory.yaml");
    expect(git(repo, "branch", "--list", "main-*")).toBe("");
    expect(await listWaves()).toEqual([]);
    expect(await listTasks()).toEqual([]);
    await expectError(callAction("waves.get", { id: "nothing" }), "not_found", "no wave");
  });

  test("waves.list filters by repository and by tag (equal or prefix + /)", async () => {
    const repo = await registeredRepo();
    await writtenWave(`10000000-${RUN}-4000-8000-000000000001`, repo, "factory/w1", "2026-01-01T00:00:01.000Z");
    await writtenWave(`10000000-${RUN}-4000-8000-000000000002`, repo, "factory/w2", "2026-01-01T00:00:02.000Z");
    await writtenWave(`10000000-${RUN}-4000-8000-000000000003`, "/elsewhere", "factorybot/w1", "2026-01-01T00:00:03.000Z");
    const list = async (params: object) => ((await callAction("waves.list", params, { cwd: repo })) as { waves: WaveView[] }).waves.map((wave) => wave.tag);
    expect(await list({})).toEqual(["factory/w1", "factory/w2", "factorybot/w1"]);
    expect(await list({ tag: "factory" })).toEqual(["factory/w1", "factory/w2"]);
    expect(await list({ tag: "factory/w1" })).toEqual(["factory/w1"]);
    expect(await list({ repo })).toEqual(["factory/w1", "factory/w2"]);
    await expectError(list({ tag: "a//" }), "invalid", "tag");
  });

  test("the view: task states and usage, counts without cancelled tasks, usage of tasks and reviews, timeline", async () => {
    const repo = makeRepo();
    const id = `20000000-${RUN}-4000-8000-000000000001`;
    await writtenWave(id, repo, "factory/w9");
    const usage = (input: number, output: number, total: number, cacheRead = 0) => ({ type: "message", message: { role: "assistant", usage: { input, output, cacheRead, cost: { total } } } });
    const state = (name: string) => ({ type: "custom", customType: "factory-state", data: { state: name, round: 1, reason: "r" } });
    const done = { ...fakeRecord(ID_1, repo), wave: id };
    const cancelled = { ...fakeRecord(ID_2, repo), wave: id };
    for (const record of [done, cancelled]) await writeTask(record);
    writeSession(done, [state("running"), usage(10, 5, 0.5, 3000), state("done")]);
    writeSession(cancelled, [state("running"), usage(1, 1, 0.25, 500), state("cancelled")]);
    await appendWaveEvent(id, { kind: "tasks", tasks: [spec("a"), spec("b"), spec("c", ["a"]), spec("gone")] });
    await appendWaveEvent(id, { kind: "task", key: "a", taskId: done.id, sessionId: done.sessionId });
    await appendWaveEvent(id, { kind: "task", key: "b", taskId: cancelled.id, sessionId: cancelled.sessionId });
    await appendWaveEvent(id, { kind: "task", key: "gone", taskId: ID_3, sessionId: "session-gone" });
    const review = { round: 1, sessionId: "rev", model: "a/b", verdict: "rejected" as const, status: "ok", findings: [], usage: { input: 100, output: 50, cacheRead: 7, cacheWrite: 2, cost: 1 }, wallMs: 5 };
    await appendWaveEvent(id, { kind: "review", ...review });
    const wave = await getWave(id);
    expect(wave.tasks.map((task) => [task.key, task.state, task.usage])).toEqual([
      ["a", "done", { input: 10, output: 5, cacheRead: 3000, cacheWrite: 0, cost: 0.5 }],
      ["b", "cancelled", { input: 1, output: 1, cacheRead: 500, cacheWrite: 0, cost: 0.25 }],
      ["c", "pending", null],
      // A task whose record was removed never finishes: it counts as cancelled.
      ["gone", "cancelled", null],
    ]);
    expect(wave.counts).toEqual({ total: 2, done: 1 });
    expect(wave.usage).toEqual({ input: 111, output: 56, cacheRead: 3507, cacheWrite: 2, cost: 1.75 });
    expect(wave.reviews).toEqual([{ at: expect.any(String), ...review }]);
    // Not resting and no runner: interrupted, whatever the stage.
    expect([wave.running, wave.interrupted]).toEqual([false, true]);
    expect(wave.actions).toEqual(["waves.add", "waves.retry", "waves.cancel", "waves.remove"]);
    await appendWaveEvent(id, { kind: "stage", stage: "reviewing", reason: null });
    expect((await getWave(id)).interrupted).toBe(true);
    await appendWaveEvent(id, { kind: "stage", stage: "rejected", reason: null });
    expect((await getWave(id)).interrupted).toBe(false);
    const timeline = (await callAction("waves.timeline", { id, since: 4 })) as { events: { kind: string }[]; next: number };
    expect(timeline.events.map((event) => event.kind)).toEqual(["review", "stage", "stage"]);
    expect(timeline.next).toBe(7);
    expect(((await callAction("waves.timeline", { id, since: 7 })) as { events: unknown[] }).events).toEqual([]);
    await expectError(callAction("waves.timeline", { id, since: 8 }), "invalid", "past");
  });

  test("a record of the wave no task event names (its runner died after the launch) is adopted, not launched again", async () => {
    const repo = makeRepo();
    git(repo, "branch", "main-factory-w9");
    const id = `20000000-${RUN}-4000-8000-000000000002`;
    await createWave({ id, repo, tag: "factory/w9", plan: null, title: "w", request: "r", branch: "main-factory-w9", target: "main", base: git(repo, "rev-parse", "main"), origin: null, createdAt: "2026-01-01T00:00:00.000Z", overrides: {} });
    await appendWaveEvent(id, { kind: "tasks", tasks: [spec("a")] });
    const orphan = { ...fakeRecord(ID_1, repo), title: "Task a", tag: "factory/w9", wave: id };
    await writeTask(orphan);
    // Another wave's record and one of another title are no orphans of this task.
    await writeTask({ ...fakeRecord(ID_2, repo), title: "Task a", wave: `20000000-${RUN}-4000-8000-000000000003` });
    expect(await startWaveTasks(id)).toEqual(["a"]);
    expect(taskOf(await getWave(id), "a")).toMatchObject({ taskId: ID_1, sessionId: orphan.sessionId });
    expect((await listTasks()).map((record) => record.id)).toEqual([ID_1, ID_2]);
    expect(prompts()).toEqual([]);
  });

  test("a stopping runner starts no further task: the launch in progress is undone, nothing of it is left", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "factory.yaml"), 'hooks:\n  after_create:\n    - ["sleep", "5"]\ngates: []\n');
    git(repo, "commit", "--quiet", "-am", "a slow hook");
    git(repo, "branch", "main-factory-w9");
    const id = `20000000-${RUN}-4000-8000-000000000004`;
    await createWave({ id, repo, tag: "factory/w9", plan: null, title: "w", request: "r", branch: "main-factory-w9", target: "main", base: git(repo, "rev-parse", "main"), origin: null, createdAt: "2026-01-01T00:00:00.000Z", overrides: {} });
    await appendWaveEvent(id, { kind: "tasks", tasks: [spec("a"), spec("b")] });
    const stopped = new AbortController();
    stopped.abort();
    expect(await startWaveTasks(id, undefined, stopped.signal)).toEqual([]);
    // Stopped while the first launch runs its after_create hook: the hook is killed, its worktree and branch removed.
    const stopping = new AbortController();
    setTimeout(() => stopping.abort(), 500);
    const begun = Date.now();
    expect(await startWaveTasks(id, undefined, stopping.signal)).toEqual([]);
    expect(Date.now() - begun).toBeLessThan(4_000);
    expect(await listTasks()).toEqual([]);
    expect(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
    expect(git(repo, "branch", "--format=%(refname:short)")).toBe("main\nmain-factory-w9");
    expect((await readWave(id)).events.map((event) => event.kind)).toEqual(["tasks"]);
    expect(prompts()).toEqual([]);
  });

  test("tasks.start (and with it factory_new_task) refuses the branch of a wave not merged or cancelled (invariant 13)", async () => {
    const repo = makeRepo();
    git(repo, "branch", "main-factory-w9");
    const id = `20000000-${RUN}-4000-8000-000000000005`;
    await createWave({ id, repo, tag: "factory/w9", plan: null, title: "w", request: "r", branch: "main-factory-w9", target: "main", base: git(repo, "rev-parse", "main"), origin: null, createdAt: "2026-01-01T00:00:00.000Z", overrides: {} });
    const start = () => callAction("tasks.start", { title: "t", request: "r", overrides: { branch: "main-factory-w9" } }, { cwd: repo });
    for (const stage of [null, "reviewing", "rejected", "blocked", "waiting_approve", "merging"] as const) {
      if (stage !== null) await appendWaveEvent(id, { kind: "stage", stage, reason: stage === "blocked" ? "gates" : null });
      await expectError(start(), "refused", `main-factory-w9 is the branch of wave 20000000, which is ${stage ?? "building"}: only the wave's own tasks reach it; give the work to the wave with waves.add`);
    }
    expect(await listTasks()).toEqual([]);
    expect(prompts()).toEqual([]);
    // Another target of the same repository is no wave's.
    expect(((await callAction("tasks.start", { title: "t", request: "r" }, { cwd: repo })) as TaskView).wave).toBeNull();
    // Once the wave is merged its branch takes tasks again.
    await appendWaveEvent(id, { kind: "stage", stage: "merged", reason: null });
    expect(((await start()) as TaskView).wave).toBeNull();
    expect(await listTasks()).toHaveLength(2);
  });

  test("waves.start that fails midway (its runner does not start) leaves no branch and no record behind", async () => {
    const repo = await registeredRepo();
    const id: `${string}-${string}-${string}-${string}-${string}` = `20000000-${RUN}-4000-8000-000000000006`;
    // The poke's marker cannot be written: a directory lies where it goes.
    mkdirSync(wavePokePath(id), { recursive: true });
    const uuid = spyOn(crypto, "randomUUID").mockReturnValue(id);
    try {
      await expectError(startWave(repo, [spec("a")]), "failed", "its runner did not start");
    } finally {
      uuid.mockRestore();
    }
    expect(git(repo, "branch", "--format=%(refname:short)")).toBe("main");
    expect(await listWaves()).toEqual([]);
    expect(existsSync(wavePokePath(id))).toBe(false);
    expect(await listTasks()).toEqual([]);
    // Nothing of it is in the way of the next declaration.
    const again = await startWave(repo, [spec("a")]);
    expect(again.branch).toBe("main-factory-w1");
    // Its runner's launch ends before the test does.
    await until(async () => taskOf(await getWave(again.id), "a").taskId !== null);
  });

  test("tasks.start cannot set a wave", async () => {
    const repo = makeRepo();
    expect(Object.keys(ACTIONS["tasks.start"].params.properties)).not.toContain("wave");
    const view = (await callAction("tasks.start", { title: "t", request: "r", wave: `20000000-${RUN}-4000-8000-000000000001` }, { cwd: repo })) as TaskView;
    expect(view.wave).toBeNull();
    expect((await recordById(view.id)).wave).toBeNull();
  });
});

describe("waiting on waves and the wave actions", () => {
  const WAVE = `50000000-${RUN}-4000-8000-000000000001`;
  const spec = (key: string) => ({ key, title: `Task ${key}`, request: `do ${key}`, after: [] });
  const stateEntry = (state: string) => ({ type: "custom", customType: "factory-state", timestamp: "t", data: { state, round: 1, reason: "r" } });
  type WaitResult = { tasks: TaskView[]; waves: WaveView[]; attention: string[]; timedOut: boolean };
  const wait = async (params: object) => (await callAction("tasks.wait", params)) as WaitResult;
  const getWave = async (id = WAVE) => ((await callAction("waves.get", { id })) as { wave: WaveView }).wave;

  /** A wave written directly with two tasks in `states` (a, b), at `stage`. */
  async function writtenWave(repo: string, states: string[], stage?: "reviewing" | "rejected" | "merged" | "waiting_approve" | "blocked", branch = "main-factory-w1"): Promise<TaskRecord[]> {
    await createWave({ id: WAVE, repo, tag: "factory/w1", plan: null, title: "w", request: "r", branch, target: "main", base: "abc", origin: null, createdAt: "2026-01-01T00:00:00.000Z", overrides: {} });
    await appendWaveEvent(WAVE, { kind: "tasks", tasks: states.map((_, index) => spec(String.fromCharCode(97 + index))) });
    const records: TaskRecord[] = [];
    for (const [index, state] of states.entries()) {
      const record = { ...fakeRecord([ID_1, ID_2, ID_3][index], repo), tag: "factory/w1", wave: WAVE };
      await writeTask(record);
      // "starting": no session file yet.
      if (state !== "starting") writeSession(record, [stateEntry(state)]);
      await appendWaveEvent(WAVE, { kind: "task", key: String.fromCharCode(97 + index), taskId: record.id, sessionId: record.sessionId });
      records.push(record);
    }
    if (stage) await appendWaveEvent(WAVE, { kind: "stage", stage, reason: stage === "blocked" ? "conflict" : null });
    return records;
  }

  /** A live stand-in of the wave's runner; resolves with the function that ends it. */
  async function fakeRunner(): Promise<() => Promise<void>> {
    const end = join(caseDir, "runner-end");
    const child = Bun.spawn(["bun", fakeWaveRunner, WAVE], { env: { ...process.env, FAKE_RUNNER_END: end } });
    await until(async () => (await liveWaveRunners(WAVE)).length === 1);
    return async () => {
      writeFileSync(end, "");
      await child.exited;
    };
  }

  test("by wave: not while it reviews with every task done; on merged, without attention", async () => {
    await writtenWave("/r", ["done", "done"], "reviewing");
    const stop = await fakeRunner();
    const busy = await wait({ wave: WAVE.slice(0, 8), timeoutMs: 1_500 });
    expect([busy.timedOut, busy.attention, busy.tasks.map((view) => view.id), busy.waves.map((wave) => [wave.id, wave.stage, wave.running])]).toEqual([
      true,
      [],
      [ID_1, ID_2],
      [[WAVE, "reviewing", true]],
    ]);
    setTimeout(() => void appendWaveEvent(WAVE, { kind: "stage", stage: "merged", reason: null }).then(stop), 300);
    const merged = await wait({ wave: WAVE, timeoutMs: 10_000 });
    expect([merged.timedOut, merged.attention, merged.waves[0].stage]).toEqual([false, [], "merged"]);
  });

  test("by wave: rejected is the wave's attention; by tag the wave is watched too", async () => {
    await writtenWave("/r", ["done"], "reviewing");
    const stop = await fakeRunner();
    setTimeout(() => void appendWaveEvent(WAVE, { kind: "stage", stage: "rejected", reason: null }).then(stop), 300);
    const rejected = await wait({ wave: WAVE, timeoutMs: 10_000 });
    expect([rejected.timedOut, rejected.attention, rejected.waves[0].stage]).toEqual([false, [WAVE], "rejected"]);
    const byTag = await wait({ tag: "factory", timeoutMs: 5_000 });
    expect([byTag.attention, byTag.waves.map((wave) => wave.id)]).toEqual([[WAVE], [WAVE]]);
    // An ignored wave is not watched.
    expect((await wait({ tag: "factory", ignore: [WAVE.slice(0, 8)] })).waves).toEqual([]);
  });

  test("by wave: a task's question needs attention while the wave builds; a cancelled task of it does not", async () => {
    const [, asking] = await writtenWave("/r", ["cancelled", "starting"]);
    const stop = await fakeRunner();
    const quiet = await wait({ wave: WAVE, timeoutMs: 1_000 });
    expect([quiet.timedOut, quiet.attention]).toEqual([true, []]);
    setTimeout(() => writeSession(asking, [stateEntry("waiting_answer")]), 300);
    const asked = await wait({ wave: WAVE, timeoutMs: 10_000 });
    expect([asked.timedOut, asked.attention, asked.waves[0].stage]).toEqual([false, [ID_2], "building"]);
    await stop();
    // Without its runner the building wave is interrupted: attention.
    expect((await wait({ wave: WAVE })).attention).toEqual([ID_2, WAVE]);
  });

  test("by wave: building with a task that can never start needs attention once no task runs, its runner alive or not", async () => {
    await writtenWave("/r", ["cancelled", "starting"]);
    await appendWaveEvent(WAVE, { kind: "tasks", tasks: [{ key: "c", title: "Task c", request: "do c", after: ["a"] }] });
    const stop = await fakeRunner();
    // b still runs: the wave may move on by itself.
    const quiet = await wait({ wave: WAVE, timeoutMs: 1_000 });
    expect([quiet.timedOut, quiet.attention]).toEqual([true, []]);
    writeSession((await listTasks())[1], [stateEntry("done")]);
    const stuck = await wait({ wave: WAVE, timeoutMs: 10_000 });
    expect([stuck.timedOut, stuck.attention, stuck.waves[0].stage, stuck.waves[0].running, stuck.waves[0].interrupted]).toEqual([false, [WAVE], "building", true, false]);
    await stop();
    const rested = await wait({ wave: WAVE, timeoutMs: 10_000 });
    expect([rested.attention, rested.waves[0].interrupted, rested.waves[0].actions]).toEqual([[WAVE], false, ["waves.add", "waves.cancel", "waves.remove"]]);
  });

  test("exactly one of ids, tag and wave", async () => {
    await writtenWave("/r", ["done"]);
    for (const params of [{}, { ids: [ID_1], wave: WAVE }, { tag: "factory", wave: WAVE }, { ids: [ID_1], tag: "factory", wave: WAVE }]) {
      await expectError(wait(params), "invalid", "tasks.wait needs exactly one of ids, tag and wave");
    }
    await expectError(wait({ wave: "ffffffff" }), "not_found", "no wave");
  });

  test("approve only from waiting_approve, retry only blocked or interrupted: refused otherwise; actions say so", async () => {
    await writtenWave("/r", ["done"], "rejected");
    expect((await getWave()).actions).toEqual(["waves.add", "waves.cancel", "waves.remove"]);
    await expectError(callAction("waves.approve", { id: WAVE }), "refused", "is rejected, approve needs waiting_approve");
    await expectError(callAction("waves.retry", { id: WAVE }), "refused", "is rejected, retry needs blocked or interrupted");
    await appendWaveEvent(WAVE, { kind: "stage", stage: "waiting_approve", reason: null });
    expect((await getWave()).actions).toEqual(["waves.add", "waves.approve", "waves.cancel", "waves.remove"]);
    await expectError(callAction("waves.retry", { id: WAVE }), "refused", "retry needs blocked or interrupted");
    await appendWaveEvent(WAVE, { kind: "stage", stage: "merged", reason: null });
    expect((await getWave()).actions).toEqual(["waves.remove"]);
    await expectError(callAction("waves.approve", { id: WAVE }), "refused", "is merged");
    await expectError(callAction("waves.cancel", { id: WAVE }), "refused", "is merged already");
  });

  test("a task of a wave past building is not continued (invariant 2): retry, a follow-up and approve refused, actions say so; its question is answered", async () => {
    const [cancelled, done, asking] = await writtenWave("/r", ["cancelled", "done", "waiting_answer"]);
    const actionsOf = async (record: TaskRecord) => ((await callAction("tasks.get", { id: record.id })) as TaskView).actions;
    // While the wave builds: as for any task.
    expect(await actionsOf(cancelled)).toEqual(["tasks.retry", "tasks.remove", "tasks.message"]);
    // A done task stays while its wave is neither merged nor cancelled (its own test below).
    expect(await actionsOf(done)).toEqual(["tasks.message"]);
    expect(await actionsOf(asking)).toEqual(["tasks.cancel", "tasks.message"]);
    for (const stage of ["reviewing", "waiting_approve", "merging", "rejected", "blocked", "merged", "cancelled"] as const) {
      await appendWaveEvent(WAVE, { kind: "stage", stage, reason: stage === "blocked" ? "gates" : null });
      expect(await actionsOf(cancelled)).toEqual(["tasks.remove"]);
      expect(await actionsOf(done)).toEqual(stage === "merged" || stage === "cancelled" ? ["tasks.remove"] : []);
      // The answer to a question continues the round it asked in: always allowed.
      expect(await actionsOf(asking)).toEqual(["tasks.cancel", "tasks.message"]);
      await expectError(callAction("tasks.retry", { id: cancelled.id }), "refused", `belongs to wave ${WAVE.slice(0, 8)}, which is ${stage}`);
      await expectError(callAction("tasks.message", { id: done.id, text: "one more thing" }), "refused", "give the work to the wave with waves.add");
    }
    writeSession(done, [stateEntry("waiting_approve")]);
    expect(await actionsOf(done)).toEqual(["tasks.cancel", "tasks.remove"]);
    await expectError(callAction("tasks.approve", { id: done.id }), "refused", "approve is refused; give the work to the wave with waves.add");
    // Nothing reached a runner.
    expect(prompts()).toEqual([]);
    // Building again (waves.add): the task actions are back.
    await appendWaveEvent(WAVE, { kind: "stage", stage: "building", reason: null });
    expect(await actionsOf(cancelled)).toEqual(["tasks.retry", "tasks.remove", "tasks.message"]);
    expect(await actionsOf(done)).toEqual(["tasks.approve", "tasks.cancel", "tasks.remove", "tasks.message"]);
  });

  test("tasks.remove refuses a done task while its wave is neither merged nor cancelled: removed, it would strand the tasks after it", async () => {
    const repo = makeRepo();
    const [done, cancelled] = await writtenWave(repo, ["done", "cancelled"]);
    const actionsOf = async (record: TaskRecord) => ((await callAction("tasks.get", { id: record.id })) as TaskView).actions;
    for (const stage of [null, "reviewing", "rejected", "blocked", "waiting_approve", "merging"] as const) {
      if (stage !== null) await appendWaveEvent(WAVE, { kind: "stage", stage, reason: stage === "blocked" ? "gates" : null });
      expect(await actionsOf(done)).not.toContain("tasks.remove");
      await expectError(callAction("tasks.remove", { id: done.id, force: true }), "refused", `is done in wave ${WAVE.slice(0, 8)}, which is ${stage ?? "building"}: the wave counts on it`);
    }
    // A cancelled task counts as cancelled either way; the wave itself is still removable with its done task.
    expect(await actionsOf(cancelled)).toContain("tasks.remove");
    expect((await getWave()).actions).toContain("waves.remove");
    expect(await callAction("tasks.remove", { id: cancelled.id })).toEqual({ removed: cancelled.id, dropped: null });
    await appendWaveEvent(WAVE, { kind: "stage", stage: "merged", reason: null });
    expect(await actionsOf(done)).toEqual(["tasks.remove"]);
    expect(await callAction("tasks.remove", { id: done.id })).toEqual({ removed: done.id, dropped: null });
    expect(await listTasks()).toEqual([]);
  });

  test("a task's merge is refused once its wave's review began, whatever started it, until the wave builds again", async () => {
    const [task] = await writtenWave("/r", ["running"]);
    // A factory task's session lies under the factory's home.
    const record = { ...task, sessionDir: join(caseDir, "agent", "factory", "sessions", "r") };
    await writeTask(record);
    const refusal = () => waveMergeRefusal(record.sessionDir, record.sessionId);
    expect(await refusal()).toBeNull();
    // A launch failed while it built: no review began, its running tasks still merge.
    await appendWaveEvent(WAVE, { kind: "stage", stage: "blocked", reason: "infra" });
    expect(await refusal()).toBeNull();
    await appendWaveEvent(WAVE, { kind: "stage", stage: "building", reason: null });
    for (const stage of ["reviewing", "blocked", "waiting_approve", "merging", "merged"] as const) {
      await appendWaveEvent(WAVE, { kind: "stage", stage, reason: stage === "blocked" ? "gates" : null });
      expect(await refusal()).toContain(`its wave ${WAVE.slice(0, 8)} is ${stage}, its review began: nothing more reaches its branch main-factory-w1`);
    }
    await appendWaveEvent(WAVE, { kind: "stage", stage: "building", reason: null });
    expect(await refusal()).toBeNull();
    await appendWaveEvent(WAVE, { kind: "stage", stage: "reviewing", reason: null });
    // A session outside the factory's home, a task outside a wave: never refused.
    expect(await waveMergeRefusal(task.sessionDir, task.sessionId)).toBeNull();
    await writeTask({ ...record, wave: null });
    expect(await refusal()).toBeNull();
  });

  test("taskWave: the wave of a factory task's session, null outside a wave or the factory's home", async () => {
    const [task] = await writtenWave("/r", ["running"]);
    const record = { ...task, sessionDir: join(caseDir, "agent", "factory", "sessions", "r") };
    await writeTask(record);
    expect(await taskWave(record.sessionDir, record.sessionId)).toBe(WAVE);
    expect(await taskWave(task.sessionDir, task.sessionId)).toBeNull();
    await writeTask({ ...record, wave: null });
    expect(await taskWave(record.sessionDir, record.sessionId)).toBeNull();
  });

  test("waves.cancel stops the wave's runner and its running tasks, the branch stays; then nothing moves", async () => {
    process.env.FAKE_PI_HOLD = "1";
    const repo = makeRepo();
    await callAction("repos.add", {}, { cwd: repo });
    const started = ((await callAction("waves.start", { tag: "factory/w1", title: "w", request: "r", tasks: [spec("a"), spec("b")] }, { cwd: repo })) as { wave: WaveView }).wave;
    await until(async () => (await getWave(started.id)).tasks.every((task) => task.taskId !== null));
    const records = (await listTasks()).filter((record) => record.wave === started.id);
    for (const record of records) await until(async () => (await stateOf(record)) === "running");
    expect((await getWave(started.id)).running).toBe(true);
    await expectError(callAction("waves.remove", { id: started.id }), "refused", "has a runner, cancel it first");
    const cancelled = ((await callAction("waves.cancel", { id: started.id })) as { wave: WaveView }).wave;
    expect([cancelled.stage, cancelled.running, cancelled.actions]).toEqual(["cancelled", false, ["waves.remove"]]);
    for (const record of records) {
      await until(async () => (await stateOf(record)) === "cancelled");
      await until(() => runnerEnded(record));
    }
    expect((await getWave(started.id)).tasks.map((task) => task.state)).toEqual(["cancelled", "cancelled"]);
    expect(git(repo, "branch", "--list", started.branch)).toBe(started.branch);
    await expectError(callAction("waves.cancel", { id: started.id }), "refused", "is cancelled already");
    await expectError(callAction("waves.add", { id: started.id, tasks: [spec("c")] }), "refused", "is cancelled");
    // The cancelled tasks' runners poke the wave: a runner that looks sees it rest and starts nothing.
    await until(async () => (await liveWaveRunners(started.id)).length === 0);
    expect((await listTasks()).filter((record) => record.wave === started.id)).toHaveLength(2);
    // Then remove: the tasks (no work of theirs), the record; the branch of a wave not merged stays.
    expect(await callAction("waves.remove", { id: started.id })).toEqual({ removed: started.id });
    expect((await listTasks()).filter((record) => record.wave === started.id)).toEqual([]);
    for (const record of records) expect(existsSync(record.worktree)).toBe(false);
    expect(existsSync(join(caseDir, "agent", "factory", "waves", `${started.id}.jsonl`))).toBe(false);
    expect(git(repo, "branch", "--list", started.branch)).toBe(started.branch);
    await expectError(callAction("waves.get", { id: started.id }), "not_found", "no wave");
  }, 60_000);

  test("waves.remove: refused for a waiting question and unmerged work without force; a merged wave's branch is deleted", async () => {
    const repo = makeRepo();
    git(repo, "branch", "main-factory-w1");
    const [a, b] = await writtenWave(repo, ["done", "waiting_answer"], "merged");
    for (const record of [a, b]) git(repo, "worktree", "add", "--quiet", "-b", record.branch, record.worktree, "main");
    await expectError(callAction("waves.remove", { id: WAVE, force: true }), "refused", "waits for the answer to its question");
    expect((await getWave()).actions).toEqual([]);
    writeSession(b, [stateEntry("cancelled")]);
    writeFileSync(join(a.worktree, "stray.txt"), "x\n");
    const refused = await failure(callAction("waves.remove", { id: WAVE }));
    expect([refused.code, refused.detail, refused.message]).toEqual(["refused", { force: true }, expect.stringContaining("give force: true")]);
    // Nothing was deleted by the refusal.
    expect([existsSync(a.worktree), existsSync(b.worktree), (await listTasks()).length, (await listWaves()).length]).toEqual([true, true, 2, 1]);
    expect(await callAction("waves.remove", { id: WAVE, force: true })).toEqual({ removed: WAVE });
    expect([existsSync(a.worktree), existsSync(b.worktree), await listTasks(), await listWaves()]).toEqual([false, false, [], []]);
    expect(git(repo, "branch", "--list", "main-factory-w1")).toBe("");
    expect(readdirSync(join(caseDir, "agent", "factory", "waves"))).toEqual([]);
  });

  test("waves.remove: a review worktree a block left is removed with the wave (a dirty one refused, named), then a merged wave's branch is deleted", async () => {
    const repo = makeRepo();
    git(repo, "branch", "main-factory-w1");
    const [a] = await writtenWave(repo, ["done"], "merged");
    git(repo, "worktree", "add", "--quiet", "-b", a.branch, a.worktree, "main");
    const review = waveReviewWorktree({ id: WAVE, repo });
    git(repo, "worktree", "add", "--quiet", review, "main-factory-w1");
    writeFileSync(join(review, "stray.txt"), "x\n");
    const refused = await failure(callAction("waves.remove", { id: WAVE }));
    expect([refused.code, refused.detail, refused.message]).toEqual(["refused", { force: true }, expect.stringContaining(`its review worktree ${review} holds uncommitted changes`)]);
    expect([existsSync(a.worktree), existsSync(review), (await listTasks()).length, (await listWaves()).length]).toEqual([true, true, 1, 1]);
    rmSync(join(review, "stray.txt"));
    expect(await callAction("waves.remove", { id: WAVE })).toEqual({ removed: WAVE });
    expect([existsSync(a.worktree), existsSync(review), git(repo, "branch", "--list", "main-factory-w1")]).toEqual([false, false, ""]);
  });
});

