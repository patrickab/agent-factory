/** The core's wave actions, `tasks.wait` over waves and what the wave's runner asks (`core-waves.ts`), over the fixture of `core-test-kit.ts`. */
import { describe, expect, spyOn } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callAction } from "./core.ts";
import type { TaskView } from "./core-tasks.ts";
import { caseDigits, caseDir, caseSerial, caseTests, expectError, failure, fakeRecord, git, makeRepo, prompts, RUN, runnerEnded, runnerHolding, stateOf, until, TASK_ENTRY, useCoreFixture, writeSession } from "./core-test-kit.ts";
import { sessionWave, startWaveTasks } from "./core-waves.ts";
import { stopRunners } from "./launch.ts";
import { lastFactoryState } from "./runner.ts";
import { listTasks, writeTask, type TaskRecord } from "./tasks.ts";
import { liveWaveRunners, pokeWave, stopWaveRunners, waveLockPath, wavePokePath } from "./wave-poke.ts";
import { appendWaveEvent, createWave, listWaves, readWave, type WaveView } from "./waves.ts";

useCoreFixture();

const test = caseTests();
/** The running test's wave id of series `series` (1-9), number `n`; its task ids `taskId(n)`. */
const waveId = (series: number, n: number): string => `${series}0000000-${RUN}-4000-8000-${caseDigits(caseSerial() * 10 + n)}`;
const taskId = (n: number): string => `abc${n}0000-${RUN}-4000-8000-${caseDigits(caseSerial() * 10 + n)}`;

describe("waves", () => {
  const spec = (key: string, after: string[] = []) => ({ key, title: `Task ${key}`, request: `do ${key}`, after, id: crypto.randomUUID() });
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
  }, 30_000);

  test("a task whose pi exits before it answers blocks the wave (infra) and stays pending; waves.retry with a working pi starts it", async () => {
    process.env.FAKE_PI_EXIT = "1";
    const repo = await registeredRepo();
    const wave = await startWave(repo, [spec("a")]);
    await until(async () => (await getWave(wave.id)).stage === "blocked", 20_000);
    await until(async () => (await liveWaveRunners(wave.id)).length === 0);
    const blocked = await getWave(wave.id);
    expect([blocked.reason, taskOf(blocked, "a").state, taskOf(blocked, "a").taskId, await listTasks()]).toEqual(["infra", "pending", null, []]);
    delete process.env.FAKE_PI_EXIT;
    await callAction("waves.retry", { id: wave.id });
    await until(async () => taskOf(await getWave(wave.id), "a").taskId !== null, 20_000);
    expect(await stateOf(await recordById(taskOf(await getWave(wave.id), "a").taskId))).toBeDefined();
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
    await expectError(callAction("waves.add", { id: wave.id, tasks: [spec("a")] }), "invalid");
    await appendWaveEvent(wave.id, { kind: "stage", stage: "merged", reason: null });
    await expectError(callAction("waves.add", { id: wave.id, tasks: [spec("late")] }), "refused");
    await expectError(callAction("waves.add", { id: "ffffffff", tasks: [spec("late")] }), "not_found");
  }, 30_000);

  /** A wave whose two tasks run held; then its runner and theirs are stopped: the wave and both tasks interrupted. */
  async function interruptedWave(repo: string): Promise<{ wave: WaveView; a: TaskRecord; c: TaskRecord }> {
    process.env.FAKE_PI_HOLD = "1";
    const started = await startWave(repo, [spec("a"), spec("c")]);
    await until(async () => (await getWave(started.id)).tasks.every((task) => task.taskId !== null));
    const wave = await getWave(started.id);
    const [a, c] = await Promise.all(["a", "c"].map((key) => recordById(taskOf(wave, key).taskId)));
    for (const record of [a, c]) await until(async () => (await stateOf(record)) === "running");
    await stopWaveRunners(wave.id);
    for (const record of [a, c]) await stopRunners(record);
    for (const record of [a, c]) expect(((await callAction("tasks.get", { id: record.id })) as TaskView).interrupted).toBe(true);
    delete process.env.FAKE_PI_HOLD;
    return { wave, a, c };
  }

  test("waves.retry of an interrupted wave retries its interrupted tasks; one whose retry is refused is named, the other runs", async () => {
    const repo = await registeredRepo();
    const { wave, a, c } = await interruptedWave(repo);
    expect((await getWave(wave.id)).interrupted).toBe(true);
    // c's runner cannot start: its retry fails, a's goes on.
    rmSync(c.worktree, { recursive: true, force: true });
    const answer = (await callAction("waves.retry", { id: wave.id })) as { wave: WaveView; retried: string[]; refused: { id: string; why: string }[] };
    expect(answer.retried).toEqual([a.id]);
    expect(answer.refused).toEqual([{ id: c.id, why: expect.any(String) }]);
    expect(prompts().filter((line) => line === "/factory retry")).toHaveLength(1);
    await until(async () => (await lastFactoryState(a.sessionDir, a.sessionId))?.reason === "gates");
  }, 30_000);

  test("a wave's small task runs its coder on the small model, its neighbour on the big one (coder); no reviewer named, none", async () => {
    const repo = await registeredRepo();
    const models = { small: "c/d", big: "a/b" };
    const wave = await startWave(repo, [{ ...spec("cheap"), model: "small" }, spec("other")], { overrides: { models } });
    expect(taskOf(wave, "cheap").model).toBe("small");
    expect(taskOf(wave, "other").model).toBe("big");
    const settingsOf = async (key: string) => ((await callAction("tasks.get", { id: taskOf(await getWave(wave.id), key).taskId })) as TaskView).settings?.models;
    // The coder's session names its settings once its runner started it.
    await until(async () => (await getWave(wave.id)).tasks.every((task) => task.taskId !== null) && (await settingsOf("cheap")) !== undefined && (await settingsOf("other")) !== undefined);
    expect(await settingsOf("cheap")).toEqual({ coder: "c/d" });
    expect(await settingsOf("other")).toEqual({ coder: "a/b" });
    expect((await readWave(wave.id)).declaration.overrides.models).toEqual(models);
  });

  test("one validation error per check of waves.start (the specs' own: waves.test), and none leaves a branch or a wave", async () => {
    const repo = await registeredRepo();
    const start = (params: Record<string, unknown>, cwd = repo) =>
      callAction("waves.start", { tag: TAG, title: "t", request: "r", tasks: [spec("a")], ...params }, { cwd });
    await expectError(callAction("waves.start", { title: "t", request: "r", tasks: [spec("a")] }, { cwd: repo }), "invalid");
    await expectError(start({ tag: "a//b" }), "invalid");
    await expectError(start({ title: " " }), "invalid");
    await expectError(start({ plan: "" }), "invalid");
    await expectError(start({ tasks: [] }), "invalid");
    await expectError(start({ overrides: { maxRounds: 0 } }), "invalid");
    await expectError(start({ overrides: { models: { big: "x/y" } } }), "refused");
    await expectError(start({ overrides: { branch: "nope" } }), "not_found");
    const unregistered = makeRepo(true, "other");
    await expectError(start({}, unregistered), "not_found");
    const bare = makeRepo(false, "bare");
    await callAction("repos.add", {}, { cwd: bare });
    await expectError(start({}, bare), "refused");
    expect(git(repo, "branch", "--list", "main-*")).toBe("");
    expect(await listWaves()).toEqual([]);
    expect(await listTasks()).toEqual([]);
    await expectError(callAction("waves.get", { id: "nothing" }), "not_found");
  });

  test("waves.list {origin}: the waves a session declared; {open: true}: those not merged or cancelled; both with repo and tag", async () => {
    const repo = await registeredRepo();
    const wave = async (n: number, tag: string, origin: string | null, stage?: "merged" | "cancelled" | "blocked", waveRepo = repo) => {
      const id = `5a000000-${RUN}-4000-8000-00000000000${n}`;
      await createWave({ id, repo: waveRepo, tag, plan: null, title: `wave ${tag}`, request: "r", branch: `main-${tag}`, target: "main", base: "abc", origin, createdAt: `2026-01-01T00:00:0${n}.000Z`, overrides: {} });
      if (stage !== undefined) await appendWaveEvent(id, { kind: "stage", stage, reason: stage === "blocked" ? "infra" : null });
    };
    await wave(1, "o/w1", "session-a", "merged");
    await wave(2, "o/w2", "session-a", "blocked");
    await wave(3, "o/w3", "session-b", "cancelled");
    await wave(4, "p/w4", "session-a");
    await wave(5, "o/w5", null, undefined, "/elsewhere");
    const list = async (params: object) => ((await callAction("waves.list", params, { cwd: repo })) as { waves: WaveView[] }).waves.map((wave) => wave.tag);
    expect(await list({ origin: "session-a" })).toEqual(["o/w1", "o/w2", "p/w4"]);
    expect(await list({ origin: "session-c" })).toEqual([]);
    expect(await list({ open: true })).toEqual(["o/w2", "p/w4", "o/w5"]);
    expect(await list({ open: false })).toEqual(["o/w1", "o/w2", "o/w3", "p/w4", "o/w5"]);
    expect(await list({ origin: "session-a", open: true, tag: "o" })).toEqual(["o/w2"]);
    expect(await list({ open: true, repo })).toEqual(["o/w2", "p/w4"]);
    await expectError(list({ origin: "" }), "invalid");
    await expectError(list({ open: "yes" }), "invalid");
  });

  test("a record of the wave no task event names (its runner died after the launch) is adopted, not launched again", async () => {
    const repo = makeRepo();
    git(repo, "branch", "main-factory-w9");
    const id = waveId(2, 2);
    await createWave({ id, repo, tag: "factory/w9", plan: null, title: "w", request: "r", branch: "main-factory-w9", target: "main", base: git(repo, "rev-parse", "main"), origin: null, createdAt: "2026-01-01T00:00:00.000Z", overrides: {} });
    await appendWaveEvent(id, { kind: "tasks", tasks: [{ ...spec("a"), id: taskId(1) }] });
    const orphan = { ...fakeRecord(taskId(1), repo), title: "Task a", tag: "factory/w9", wave: id };
    await writeTask(orphan);
    // Another wave's record is no orphan of this task.
    await writeTask({ ...fakeRecord(taskId(2), repo), title: "Task a", wave: waveId(2, 3) });
    expect(await startWaveTasks(id)).toEqual(["a"]);
    expect(taskOf(await getWave(id), "a")).toMatchObject({ taskId: taskId(1), sessionId: orphan.sessionId });
    expect((await listTasks()).map((record) => record.id)).toEqual([taskId(1), taskId(2)]);
    expect(prompts()).toEqual([]);
  });

  test("a stopping runner starts no further task: the launch in progress is undone, nothing of it is left", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "factory.yaml"), 'hooks:\n  after_create:\n    - ["sleep", "5"]\ngates: []\n');
    git(repo, "commit", "--quiet", "-am", "a slow hook");
    git(repo, "branch", "main-factory-w9");
    const id = waveId(2, 4);
    await createWave({ id, repo, tag: "factory/w9", plan: null, title: "w", request: "r", branch: "main-factory-w9", target: "main", base: git(repo, "rev-parse", "main"), origin: null, createdAt: "2026-01-01T00:00:00.000Z", overrides: {} });
    await appendWaveEvent(id, { kind: "tasks", tasks: [spec("a"), spec("b")] });
    const stopped = new AbortController();
    stopped.abort();
    expect(await startWaveTasks(id, undefined, stopped.signal)).toEqual([]);
    // Stopped while the first launch runs its after_create hook: the hook is killed, its worktree and branch removed.
    const stopping = new AbortController();
    setTimeout(() => stopping.abort(), 500);
    // Within the test's timeout: the hook would run 5 s.
    expect(await startWaveTasks(id, undefined, stopping.signal)).toEqual([]);
    expect(await listTasks()).toEqual([]);
    expect(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
    expect(git(repo, "branch", "--format=%(refname:short)")).toBe("main\nmain-factory-w9");
    expect((await readWave(id)).fold.tasks.map((task) => task.taskId)).toEqual([null, null]);
    expect(prompts()).toEqual([]);
  });

  test("tasks.start refuses the branch of a wave not merged or cancelled (invariant 13)", async () => {
    const repo = makeRepo();
    git(repo, "branch", "main-factory-w9");
    const id = waveId(2, 5);
    await createWave({ id, repo, tag: "factory/w9", plan: null, title: "w", request: "r", branch: "main-factory-w9", target: "main", base: git(repo, "rev-parse", "main"), origin: null, createdAt: "2026-01-01T00:00:00.000Z", overrides: {} });
    const start = () => callAction("tasks.start", { title: "t", request: "r", overrides: { branch: "main-factory-w9" } }, { cwd: repo });
    for (const stage of [null, "reviewing", "rejected", "blocked", "waiting_approve", "merging"] as const) {
      if (stage !== null) await appendWaveEvent(id, { kind: "stage", stage, reason: stage === "blocked" ? "gates" : null });
      await expectError(start(), "refused");
    }
    // A queued wave's branch (it waits for this one) is the wave's too.
    git(repo, "branch", "main-factory-w10");
    await createWave({ id: waveId(2, 7), repo, tag: "factory/w10", plan: null, title: "q", request: "r", branch: "main-factory-w10", target: "main", base: git(repo, "rev-parse", "main"), origin: null, createdAt: "2026-01-01T00:00:01.000Z", overrides: {}, after: [id] });
    await expectError(callAction("tasks.start", { title: "t", request: "r", overrides: { branch: "main-factory-w10" } }, { cwd: repo }), "refused");
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
    const id = waveId(2, 6) as `${string}-${string}-${string}-${string}-${string}`;
    // The poke's marker cannot be written: a directory lies where it goes.
    mkdirSync(wavePokePath(id), { recursive: true });
    const uuid = spyOn(crypto, "randomUUID").mockReturnValue(id);
    try {
      await expectError(startWave(repo, [spec("a")]), "failed");
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

  describe("a wave that waits for waves (after)", () => {
    const WAVE_N = (n: number) => waveId(5, n);

    /** A wave written directly on `repo` with its branch holding one commit (`<n>.txt`), resting `stage`. */
    async function predecessor(repo: string, tag: string, n: number, stage: "rejected" | "blocked" = "rejected"): Promise<string> {
      const id = WAVE_N(n);
      const branch = `main-${tag.replaceAll("/", "-")}`;
      const base = git(repo, "rev-parse", "main");
      git(repo, "checkout", "--quiet", "-b", branch);
      writeFileSync(join(repo, `${n}.txt`), `${n}\n`);
      git(repo, "add", "-A");
      git(repo, "commit", "--quiet", "-m", `feat: ${n}`);
      git(repo, "checkout", "--quiet", "main");
      await createWave({ id, repo, tag, plan: null, title: `wave ${tag}`, request: "r", branch, target: "main", base, origin: null, createdAt: `2026-01-0${n}T00:00:00.000Z`, overrides: {} });
      await appendWaveEvent(id, { kind: "stage", stage, reason: stage === "blocked" ? "gates" : null });
      return id;
    }

    /** The predecessor reaches main and is merged; the poke runs its runner, which pokes the queued waves after it. */
    async function merge(repo: string, id: string): Promise<void> {
      const { declaration } = await readWave(id);
      git(repo, "merge", "--quiet", "--no-edit", declaration.branch);
      await appendWaveEvent(id, { kind: "stage", stage: "merged", reason: null });
      await pokeWave(id);
      await until(async () => (await liveWaveRunners(id)).length === 0);
    }

    const restsQueued = async (id: string) => {
      await until(async () => (await liveWaveRunners(id)).length === 0);
      return getWave(id);
    };

    test("queued until its one predecessor merged, then its branch moves to the target's tip with that code and its tasks start", async () => {
      const repo = await registeredRepo();
      const p1 = await predecessor(repo, "factory/p1", 1);
      const queued = await startWave(repo, [spec("a")], { tag: "factory/w3", after: ["factory/p1"] });
      expect(queued).toMatchObject({ stage: "queued", branch: "main-factory-w3", after: [p1], detail: null });
      expect((await readWave(queued.id)).declaration.after).toEqual([p1]);
      const waiting = await restsQueued(queued.id);
      expect([waiting.stage, waiting.interrupted, waiting.actions]).toEqual(["queued", false, ["waves.add", "waves.cancel", "waves.remove"]]);
      expect(taskOf(waiting, "a").taskId).toBeNull();
      // The predecessor: not removable while a queued wave waits for it.
      expect((await getWave(p1)).actions).not.toContain("waves.remove");
      await expectError(callAction("waves.remove", { id: p1 }), "refused");
      await merge(repo, p1);
      await until(async () => taskOf(await getWave(queued.id), "a").taskId !== null, 20_000);
      const started = await getWave(queued.id);
      const main = git(repo, "rev-parse", "main");
      const file = await readWave(queued.id);
      expect([started.stage, started.branch, file.fold.base]).toEqual(["building", "main-factory-w3", main]);
      expect(git(repo, "rev-parse", "refs/heads/main-factory-w3")).toBe(main);
      expect(git(repo, "show", "main-factory-w3:1.txt")).toBe("1");
      const record = await recordById(taskOf(started, "a").taskId);
      expect(git(record.worktree, "show", "HEAD:1.txt")).toBe("1");
    }, 40_000);

    test("a rejected predecessor keeps it queued (waves.add takes tasks and keeps it so); a cancelled one: it can never start", async () => {
      const repo = await registeredRepo();
      const p1 = await predecessor(repo, "factory/p1", 1);
      const queued = await startWave(repo, [spec("a")], { tag: "factory/w3", after: ["factory/p1"] });
      await restsQueued(queued.id);
      const added = ((await callAction("waves.add", { id: queued.id, tasks: [spec("b", ["a"])] })) as { wave: WaveView }).wave;
      expect([added.stage, added.tasks.map((task) => task.key)]).toEqual(["queued", ["a", "b"]]);
      const still = await restsQueued(queued.id);
      expect([still.stage, still.detail, still.tasks.every((task) => task.taskId === null)]).toEqual(["queued", null, true]);
      expect((await callAction("tasks.wait", { wave: queued.id, timeoutMs: 1000 })) as { attention: string[] }).toMatchObject({ attention: [] });
      await callAction("waves.cancel", { id: p1 });
      const never = await getWave(queued.id);
      expect([never.stage, never.detail === null]).toEqual(["queued", false]);
      // Recorded once: a poke of the queued wave records nothing more.
      const recorded = (await readWave(queued.id)).events.length;
      await pokeWave(queued.id);
      await restsQueued(queued.id);
      expect((await readWave(queued.id)).events).toHaveLength(recorded);
      expect(((await callAction("tasks.wait", { wave: queued.id, timeoutMs: 1000 })) as { attention: string[] }).attention).toEqual([queued.id]);
      // A cancelled wave is no name for a new one; the queued one is cancelled and removed (its branch too), then the named one.
      await expectError(startWave(repo, [spec("x")], { tag: "factory/w4", after: [p1] }), "invalid");
      await expectError(callAction("waves.remove", { id: p1 }), "refused");
      expect((await callAction("waves.cancel", { id: queued.id })) as { wave: WaveView }).toMatchObject({ wave: { stage: "cancelled" } });
      expect(await callAction("waves.remove", { id: queued.id })).toEqual({ removed: queued.id });
      expect(git(repo, "branch", "--list", "main-factory-w3")).toBe("");
      expect(await callAction("waves.remove", { id: p1 })).toEqual({ removed: p1 });
    }, 40_000);

    test("waves.remove of a wave that never started keeps its branch when it holds commits the target lacks", async () => {
      const repo = await registeredRepo();
      await predecessor(repo, "factory/p1", 1);
      const queued = await startWave(repo, [spec("a")], { tag: "factory/w3", after: ["factory/p1"] });
      git(repo, "worktree", "add", "--quiet", join(caseDir, "w3"), "main-factory-w3");
      writeFileSync(join(caseDir, "w3", "mine.txt"), "mine\n");
      git(join(caseDir, "w3"), "add", "-A");
      git(join(caseDir, "w3"), "commit", "--quiet", "-m", "mine");
      git(repo, "worktree", "remove", join(caseDir, "w3"));
      const tip = git(repo, "rev-parse", "main-factory-w3");
      await callAction("waves.cancel", { id: queued.id });
      expect(await callAction("waves.remove", { id: queued.id })).toEqual({ removed: queued.id });
      expect(git(repo, "rev-parse", "main-factory-w3")).toBe(tip);
    }, 30_000);

    test("queued with every named wave merged and no runner (one died before it poked): interrupted, attention in tasks.wait, waves.retry starts it", async () => {
      const repo = await registeredRepo();
      const p1 = await predecessor(repo, "factory/p1", 1);
      const id = WAVE_N(9);
      git(repo, "branch", "main-factory-w3");
      await createWave({ id, repo, tag: "factory/w3", plan: null, title: "w3", request: "r", branch: "main-factory-w3", target: "main", base: git(repo, "rev-parse", "main"), after: [p1], origin: null, createdAt: "2026-01-09T00:00:00.000Z", overrides: {} });
      await appendWaveEvent(id, { kind: "tasks", tasks: [spec("a")] });
      git(repo, "merge", "--quiet", "--no-edit", "main-factory-p1");
      await appendWaveEvent(p1, { kind: "stage", stage: "merged", reason: null });
      const stalled = await getWave(id);
      expect([stalled.stage, stalled.interrupted, stalled.actions.includes("waves.retry")]).toEqual(["queued", true, true]);
      expect(((await callAction("tasks.wait", { wave: id, timeoutMs: 1000 })) as { attention: string[]; timedOut: boolean })).toMatchObject({ attention: [id], timedOut: false });
      await callAction("waves.retry", { id });
      await until(async () => taskOf(await getWave(id), "a").taskId !== null, 20_000);
      expect(git(repo, "show", "main-factory-w3:1.txt")).toBe("1");
    }, 30_000);

  });
});

describe("waiting on waves and the wave actions", () => {
  const WAVE = (): string => waveId(5, 1);
  const spec = (key: string) => ({ key, title: `Task ${key}`, request: `do ${key}`, after: [], id: crypto.randomUUID() });
  const stateEntry = (state: string) => ({ type: "custom", customType: "factory-state", timestamp: "t", data: { state, round: 1, reason: "r" } });
  type WaitResult = { tasks: TaskView[]; waves: WaveView[]; attention: string[]; timedOut: boolean };
  const wait = async (params: object) => (await callAction("tasks.wait", params)) as WaitResult;
  const getWave = async (id = WAVE()) => ((await callAction("waves.get", { id })) as { wave: WaveView }).wave;

  /** A wave written directly with two tasks in `states` (a, b), at `stage`. */
  async function writtenWave(repo: string, states: string[], stage?: "reviewing" | "rejected" | "merged" | "waiting_approve" | "blocked", branch = "main-factory-w1"): Promise<TaskRecord[]> {
    await createWave({ id: WAVE(), repo, tag: "factory/w1", plan: null, title: "w", request: "r", branch, target: "main", base: "abc", origin: null, createdAt: "2026-01-01T00:00:00.000Z", overrides: {} });
    await appendWaveEvent(WAVE(), { kind: "tasks", tasks: states.map((_, index) => spec(String.fromCharCode(97 + index))) });
    const records: TaskRecord[] = [];
    for (const [index, state] of states.entries()) {
      const record = { ...fakeRecord([taskId(1), taskId(2), taskId(3)][index], repo), tag: "factory/w1", wave: WAVE() };
      await writeTask(record);
      // "starting": no session file yet.
      if (state !== "starting") writeSession(record, [TASK_ENTRY, stateEntry(state)]);
      await appendWaveEvent(WAVE(), { kind: "task", key: String.fromCharCode(97 + index), taskId: record.id, sessionId: record.sessionId });
      records.push(record);
    }
    if (stage) await appendWaveEvent(WAVE(), { kind: "stage", stage, reason: stage === "blocked" ? "conflict" : null });
    return records;
  }

  /** A live stand-in of the wave's runner; resolves with the function that ends it. */
  async function fakeRunner(): Promise<() => Promise<void>> {
    const end = join(caseDir, "runner-end");
    const child = await runnerHolding(waveLockPath(WAVE()), WAVE(), { ...process.env, FAKE_RUNNER_END: end });
    await until(async () => (await liveWaveRunners(WAVE())).length === 1);
    return async () => {
      writeFileSync(end, "");
      await child.exited;
    };
  }

  test("by wave: not while it reviews with every task done; on merged, without attention", async () => {
    await writtenWave("/r", ["done", "done"], "reviewing");
    const stop = await fakeRunner();
    const busy = await wait({ wave: WAVE().slice(0, 8), timeoutMs: 1_500 });
    expect([busy.timedOut, busy.attention, busy.tasks.map((view) => view.id), busy.waves.map((wave) => [wave.id, wave.stage, wave.running])]).toEqual([
      true,
      [],
      [taskId(1), taskId(2)],
      [[WAVE(), "reviewing", true]],
    ]);
    setTimeout(() => void appendWaveEvent(WAVE(), { kind: "stage", stage: "merged", reason: null }).then(stop), 300);
    const merged = await wait({ wave: WAVE(), timeoutMs: 10_000 });
    expect([merged.timedOut, merged.attention, merged.waves[0].stage]).toEqual([false, [], "merged"]);
  });

  test("by wave: a task's question needs attention while the wave builds; a cancelled task of it does not", async () => {
    const [, asking] = await writtenWave("/r", ["cancelled", "starting"]);
    const stop = await fakeRunner();
    const quiet = await wait({ wave: WAVE(), timeoutMs: 1_000 });
    expect([quiet.timedOut, quiet.attention]).toEqual([true, []]);
    setTimeout(() => writeSession(asking, [TASK_ENTRY, stateEntry("waiting_answer")]), 300);
    const asked = await wait({ wave: WAVE(), timeoutMs: 10_000 });
    expect([asked.timedOut, asked.attention, asked.waves[0].stage]).toEqual([false, [taskId(2)], "building"]);
    await stop();
    // Without its runner the building wave is interrupted: attention.
    expect((await wait({ wave: WAVE() })).attention).toEqual([taskId(2), WAVE()]);
  });

  test("a task of a wave past building is not continued (invariant 2): retry, a message and approve refused, actions say so; its question is answered", async () => {
    const [cancelled, done, asking] = await writtenWave("/r", ["cancelled", "done", "waiting_answer"]);
    const actionsOf = async (record: TaskRecord) => ((await callAction("tasks.get", { id: record.id })) as TaskView).actions;
    // While the wave builds: as for any task.
    expect(await actionsOf(cancelled)).toEqual(["tasks.retry", "tasks.remove", "tasks.message"]);
    // A done task stays while its wave is neither merged nor cancelled (its own test below).
    expect(await actionsOf(done)).toEqual([]);
    expect(await actionsOf(asking)).toEqual(["tasks.cancel", "tasks.message"]);
    for (const stage of ["reviewing", "waiting_approve", "merging", "rejected", "blocked", "merged", "cancelled"] as const) {
      await appendWaveEvent(WAVE(), { kind: "stage", stage, reason: stage === "blocked" ? "gates" : null });
      expect(await actionsOf(cancelled)).toEqual(["tasks.remove"]);
      expect(await actionsOf(done)).toEqual(stage === "merged" || stage === "cancelled" ? ["tasks.remove"] : []);
      // The answer to a question continues the round it asked in: always allowed.
      expect(await actionsOf(asking)).toEqual(["tasks.cancel", "tasks.message"]);
      await expectError(callAction("tasks.retry", { id: cancelled.id }), "refused");
      await expectError(callAction("tasks.message", { id: done.id, text: "one more thing" }), "refused");
    }
    writeSession(done, [TASK_ENTRY, stateEntry("waiting_approve")]);
    expect(await actionsOf(done)).toEqual(["tasks.cancel", "tasks.remove"]);
    await expectError(callAction("tasks.approve", { id: done.id }), "refused");
    // Nothing reached a runner.
    expect(prompts()).toEqual([]);
    // Building again (waves.add): the task actions are back.
    await appendWaveEvent(WAVE(), { kind: "stage", stage: "building", reason: null });
    expect(await actionsOf(cancelled)).toEqual(["tasks.retry", "tasks.remove", "tasks.message"]);
    expect(await actionsOf(done)).toEqual(["tasks.approve", "tasks.cancel", "tasks.remove", "tasks.message"]);
  });

  test("tasks.remove refuses a done task while its wave is neither merged nor cancelled: removed, it would strand the tasks after it", async () => {
    const repo = makeRepo();
    const [done, cancelled] = await writtenWave(repo, ["done", "cancelled"]);
    const actionsOf = async (record: TaskRecord) => ((await callAction("tasks.get", { id: record.id })) as TaskView).actions;
    for (const stage of [null, "reviewing", "rejected", "blocked", "waiting_approve", "merging"] as const) {
      if (stage !== null) await appendWaveEvent(WAVE(), { kind: "stage", stage, reason: stage === "blocked" ? "gates" : null });
      expect(await actionsOf(done)).not.toContain("tasks.remove");
      await expectError(callAction("tasks.remove", { id: done.id, force: true }), "refused");
    }
    // A cancelled task counts as cancelled either way; the wave itself is still removable with its done task.
    expect(await actionsOf(cancelled)).toContain("tasks.remove");
    expect((await getWave()).actions).toContain("waves.remove");
    expect(await callAction("tasks.remove", { id: cancelled.id })).toEqual({ removed: cancelled.id, dropped: null });
    await appendWaveEvent(WAVE(), { kind: "stage", stage: "merged", reason: null });
    expect(await actionsOf(done)).toEqual(["tasks.remove"]);
    expect(await callAction("tasks.remove", { id: done.id })).toEqual({ removed: done.id, dropped: null });
    expect(await listTasks()).toEqual([]);
  });

  test("a task's merge is refused once its wave's review began, whatever started it, until the wave builds again", async () => {
    const [record] = await writtenWave("/r", ["running"]);
    const refusal = async () => (await sessionWave(record.sessionId))?.mergeRefusal ?? null;
    expect(await refusal()).toBeNull();
    // A launch failed while it built: no review began, its running tasks still merge.
    await appendWaveEvent(WAVE(), { kind: "stage", stage: "blocked", reason: "infra" });
    expect(await refusal()).toBeNull();
    await appendWaveEvent(WAVE(), { kind: "stage", stage: "building", reason: null });
    for (const stage of ["reviewing", "blocked", "waiting_approve", "merging", "merged"] as const) {
      await appendWaveEvent(WAVE(), { kind: "stage", stage, reason: stage === "blocked" ? "gates" : null });
      expect(await refusal()).not.toBeNull();
    }
    await appendWaveEvent(WAVE(), { kind: "stage", stage: "building", reason: null });
    expect(await refusal()).toBeNull();
    await appendWaveEvent(WAVE(), { kind: "stage", stage: "reviewing", reason: null });
    // A task outside a wave: never refused.
    await writeTask({ ...record, wave: null });
    expect(await refusal()).toBeNull();
  });

  test("waves.cancel stops the wave's runner and its running tasks, the branch stays; then nothing moves; its home stays", async () => {
    process.env.FAKE_PI_HOLD = "1";
    const repo = makeRepo();
    await callAction("repos.add", {}, { cwd: repo });
    const plan = `plan-${crypto.randomUUID()}`;
    mkdirSync(join(String(process.env.MEMORY_STORE_ROOT), plan), { recursive: true });
    const started = ((await callAction("waves.start", { tag: "factory/w1", title: "w", request: "r", plan, tasks: [spec("a"), spec("b")] }, { cwd: repo })) as { wave: WaveView }).wave;
    await until(async () => (await getWave(started.id)).tasks.every((task) => task.taskId !== null));
    const records = (await listTasks()).filter((record) => record.wave === started.id);
    for (const record of records) await until(async () => (await stateOf(record)) === "running");
    expect((await getWave(started.id)).running).toBe(true);
    await expectError(callAction("waves.remove", { id: started.id }), "refused");
    const cancelled = ((await callAction("waves.cancel", { id: started.id })) as { wave: WaveView }).wave;
    expect(cancelled.stage).toBe("cancelled");
    for (const record of records) {
      await until(async () => (await stateOf(record)) === "cancelled");
      await until(() => runnerEnded(record));
    }
    expect((await getWave(started.id)).tasks.map((task) => task.state)).toEqual(["cancelled", "cancelled"]);
    expect(git(repo, "branch", "--list", started.branch)).toBe(started.branch);
    await expectError(callAction("waves.cancel", { id: started.id }), "refused");
    await expectError(callAction("waves.add", { id: started.id, tasks: [spec("c")] }), "refused");
    // The cancelled tasks' runners poke the wave: a runner that looks sees it rest and starts nothing.
    await until(async () => (await liveWaveRunners(started.id)).length === 0);
    const rested = await getWave(started.id);
    expect([rested.running, rested.actions]).toEqual([false, ["waves.remove"]]);
    expect((await listTasks()).filter((record) => record.wave === started.id)).toHaveLength(2);
    // Then remove: the tasks (no work of theirs), the record; the branch of a wave not merged stays.
    expect(await callAction("waves.remove", { id: started.id })).toEqual({ removed: started.id });
    expect((await listTasks()).filter((record) => record.wave === started.id)).toEqual([]);
    for (const record of records) expect(existsSync(record.worktree)).toBe(false);
    expect(git(repo, "branch", "--list", started.branch)).toBe(started.branch);
    const home = readdirSync(join(String(process.env.MEMORY_STORE_ROOT), plan, "run", "waves", "factory", "w1", started.id.slice(0, 8)), { recursive: true }).map(String);
    expect(["wave.jsonl", ...records.map((record) => record.sessionId)].every((name) => home.some((file) => file.includes(name)))).toBe(true);
  }, 60_000);

  test("waves.remove: refused for a waiting question and unmerged work without force; a merged wave's branch is deleted", async () => {
    const repo = makeRepo();
    git(repo, "branch", "main-factory-w1");
    const [a, b] = await writtenWave(repo, ["done", "waiting_answer"], "merged");
    for (const record of [a, b]) git(repo, "worktree", "add", "--quiet", "-b", record.branch, record.worktree, "main");
    await expectError(callAction("waves.remove", { id: WAVE(), force: true }), "refused");
    expect((await getWave()).actions).toEqual([]);
    writeSession(b, [TASK_ENTRY, stateEntry("cancelled")]);
    writeFileSync(join(a.worktree, "stray.txt"), "x\n");
    const refused = await failure(callAction("waves.remove", { id: WAVE() }));
    expect([refused.code, refused.detail]).toEqual(["refused", { force: true }]);
    // Nothing was deleted by the refusal.
    expect([existsSync(a.worktree), existsSync(b.worktree), (await listTasks()).length, (await listWaves()).length]).toEqual([true, true, 2, 1]);
    expect(await callAction("waves.remove", { id: WAVE(), force: true })).toEqual({ removed: WAVE() });
    expect([existsSync(a.worktree), existsSync(b.worktree), await listTasks(), await listWaves()]).toEqual([false, false, [], []]);
    expect(git(repo, "branch", "--list", "main-factory-w1")).toBe("");
    expect(readdirSync(join(caseDir, "agent", "factory", "waves"))).toEqual([]);
  });

});

