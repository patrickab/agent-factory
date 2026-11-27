/**
 * The wave runner over real git repos in a temp dir: the wave's tasks are records whose sessions say `done`, their
 * work commits on the wave's branch, and the reviewer is a fake `pi` on PATH (`--mode json`, an approving `submit_verdict`
 * call). `runWave` runs in this process; the poke tests start real detached runners.
 */
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { caseDigits, caseSerial, caseTests } from "./test-case.ts";
import { callAction } from "./core.ts";
import { worktreePath } from "./launch.ts";
import { git, until } from "./scenario-kit.ts";
import { writeTask, type TaskRecord } from "./tasks.ts";
import { liveWaveRunners, pokeWave, stopWaveRunners, wavePokePath } from "./wave-poke.ts";
import { runWave } from "./wave-runner.ts";
import { appendWaveEvent, createWave, listWaves, lockWave, readWave, unlockWave, type WaveView } from "./waves.ts";

const test = caseTests();
const savedEnv = { ...process.env };
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "factory-wave-runner-test-")));
const fakeBin = join(scratch, "bin");
const promptLog = join(scratch, "reviewer-prompt.txt");

/** The fake reviewer: a session file in `--session-dir`, the verdict call and one assistant message's usage. */
mkdirSync(fakeBin);
writeFileSync(
  join(fakeBin, "pi"),
  `#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
if (!args.includes("json")) process.exit(3);
const dir = args[args.indexOf("--session-dir") + 1];
const id = "11111111-2222-4333-8444-555555555555";
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "2026-01-01T00-00-00-000Z_" + id + ".jsonl"), JSON.stringify({ type: "session", id }) + "\\n");
writeFileSync(process.env.FAKE_PROMPT_LOG, args.at(-1));
if (process.env.FAKE_REVIEW_SLEEP) await Bun.sleep(Number(process.env.FAKE_REVIEW_SLEEP));
const emit = (record) => console.log(JSON.stringify(record));
emit({ type: "session", id });
emit({ type: "tool_execution_end", toolName: "submit_verdict", isError: false, result: { details: { findings: [] } } });
emit({ type: "message_end", message: { role: "assistant", usage: { input: 100, output: 20, cacheRead: 900, cacheWrite: 30, cost: { total: 0.5 } } } });
`,
);
chmodSync(join(fakeBin, "pi"), 0o755);

let caseDir: string;
let caseCount = 0;

beforeEach(() => {
  caseDir = join(scratch, `case-${++caseCount}`);
  mkdirSync(caseDir);
  Object.assign(process.env, {
    PATH: `${fakeBin}:${savedEnv.PATH ?? ""}`,
    HOME: scratch,
    PI_CODING_AGENT_DIR: join(caseDir, "agent"),
    FAKE_PROMPT_LOG: promptLog,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "test",
    GIT_COMMITTER_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_EMAIL: "test@example.com",
  });
  delete process.env.FAKE_REVIEW_SLEEP;
  rmSync(promptLog, { force: true });
});

afterEach(async () => {
  for (const wave of await listWaves()) await stopWaveRunners(wave.declaration.id);
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function commit(cwd: string, file: string, text: string, message: string): string {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", "-A");
  git(cwd, "commit", "--quiet", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

/** Part of every fixed id and session id here: a concurrent test run (another worktree) never matches these runners. */
const RUN = randomBytes(2).toString("hex");
const WAVE = (): string => `30000000-${RUN}-4000-8000-${caseDigits()}`;
const BRANCH = "main-factory-w1";
const taskId = (n: number) => `40000000-${RUN}-4000-8000-${caseDigits(caseSerial() * 10 + n)}`;

/**
 * A repo on `main` with `factory.yaml` (`config`), the wave's branch off it holding one commit per task (a, then b after
 * a), the tasks' records with sessions in `state`, and the wave's log of them. Returns the repo.
 */
async function waveRepo(config = "gates:\n  - [\"true\"]\n", state = "done", overrides: object = {}): Promise<string> {
  const repo = join(caseDir, "repo");
  mkdirSync(repo);
  git(repo, "init", "--quiet", "-b", "main");
  writeFileSync(join(repo, "factory.yaml"), config);
  commit(repo, "a.txt", "a\n", "init");
  const base = git(repo, "rev-parse", "main");
  git(repo, "branch", BRANCH);
  // The tasks' merges into the wave's branch, as their runs left them: one commit each.
  const work = join(caseDir, "work");
  git(repo, "worktree", "add", "--quiet", work, BRANCH);
  commit(work, "b.txt", "b\n", "feat: add b");
  commit(work, "c.txt", "c\n", "feat: add c");
  git(repo, "worktree", "remove", work);
  await createWave({ id: WAVE(), repo, tag: "factory/w1", plan: null, title: "Wave one", request: "Check b and c.\nKeep it small.", branch: BRANCH, target: "main", base, origin: null, createdAt: "2026-01-01T00:00:00.000Z", overrides });
  const specs = [
    { key: "a", title: "Add b", request: "add b", after: [], id: crypto.randomUUID() },
    { key: "b", title: "Add c", request: "add c", after: ["a"], id: crypto.randomUUID() },
  ];
  await appendWaveEvent(WAVE(), { kind: "tasks", tasks: specs });
  for (const [index, spec] of specs.entries()) {
    const record: TaskRecord = {
      id: taskId(index + 1),
      repo,
      worktree: join(caseDir, `task-${spec.key}`),
      branch: `task-${spec.key}`,
      title: spec.title,
      sessionId: `session-${RUN}-${caseSerial()}-${spec.key}`,
      sessionDir: join(caseDir, "sessions"),
      createdAt: `2026-01-01T00:00:0${index + 1}.000Z`,
      tag: "factory/w1",
      plan: null,
      wave: WAVE(),
      origin: null,
    };
    await writeTask(record);
    mkdirSync(record.sessionDir, { recursive: true });
    const entry = { type: "custom", customType: "factory-state", data: { state, round: 1, reason: "r" } };
    writeFileSync(join(record.sessionDir, `2026-01-01T00-00-00-000Z_${record.sessionId}.jsonl`), `${JSON.stringify(entry)}\n`);
    await appendWaveEvent(WAVE(), { kind: "task", key: spec.key, taskId: record.id, sessionId: record.sessionId });
  }
  return repo;
}

const getWave = async () => ((await callAction("waves.get", { id: WAVE() })) as { wave: WaveView }).wave;
type Event = { at?: string; kind: string; stage?: string; reason?: string | null; detail?: string; dropped?: string[]; key?: string; taskId?: string };
const timeline = async () => (await readWave(WAVE())).events as Event[];
type WaitResult = { waves: WaveView[]; attention: string[]; timedOut: boolean };
const waitWave = async (timeoutMs: number) => (await callAction("tasks.wait", { wave: WAVE(), timeoutMs })) as WaitResult;
/** Overwrites the session of the wave's task `key` with one state. */
const setState = (key: string, state: string) =>
  writeFileSync(join(caseDir, "sessions", `2026-01-01T00-00-00-000Z_session-${RUN}-${caseSerial()}-${key}.jsonl`), `${JSON.stringify({ type: "custom", customType: "factory-state", data: { state, round: 1, reason: "r" } })}\n`);
/** Holds the runner's lock in this process while `act` runs: a poke leaves its marker and starts no runner. */
async function holding<T>(act: () => Promise<T>): Promise<T> {
  await lockWave(WAVE());
  try {
    return await act();
  } finally {
    await unlockWave(WAVE());
  }
}
const reviewWorktree = (repo: string) => worktreePath(repo, `wave-${WAVE().slice(0, 8)}-review`);

describe("the wave runner", () => {

  test("waves.add moves a rejected wave again and pokes the runner", async () => {
    await waveRepo();
    await appendWaveEvent(WAVE(), { kind: "stage", stage: "rejected", reason: null });
    // A live runner holds the wave (this process): the poke leaves its marker and starts none.
    await lockWave(WAVE());
    try {
      const added = ((await callAction("waves.add", { id: WAVE(), tasks: [{ key: "fix", title: "Fix b", request: "fix b", after: ["a"] }] })) as { wave: WaveView }).wave;
      expect([added.stage, added.counts]).toEqual(["building", { total: 3, done: 2 }]);
      expect(existsSync(wavePokePath(WAVE()))).toBe(true);
      expect(await liveWaveRunners(WAVE())).toEqual([]);
    } finally {
      await unlockWave(WAVE());
    }
  });

  /** A commit on the wave's branch, made in a worktree of its own. */
  function waveCommit(repo: string, file: string, text: string, message: string): void {
    const work = join(caseDir, "work-extra");
    git(repo, "worktree", "add", "--quiet", work, BRANCH);
    commit(work, file, text, message);
    git(repo, "worktree", "remove", work);
  }

  /** The wave's two conflict tasks, used up (their `conflict` events only): the next conflict blocks it. */
  async function usedUpConflicts(): Promise<void> {
    for (const key of ["conflict-1", "conflict-2"]) await appendWaveEvent(WAVE(), { kind: "conflict", phase: "review", key, head: "0".repeat(40), onto: "1".repeat(40), files: ["a.txt"] });
  }

  test("a third rebase conflict that changes a line blocks it with reason conflict and deletes nothing", async () => {
    const repo = await waveRepo();
    await usedUpConflicts();
    waveCommit(repo, "a.txt", "wave's a\n", "feat: change a");
    const wave = git(repo, "rev-parse", BRANCH);
    commit(repo, "a.txt", "main's a\n", "main: change a");
    const main = git(repo, "rev-parse", "main");
    await runWave(WAVE());
    const view = await getWave();
    expect([view.stage, view.reason, view.detail]).toEqual(["blocked", "conflict", "the rebase onto main conflicts on a.txt; its 2 conflict tasks are used up"]);
    expect([git(repo, "rev-parse", BRANCH), git(repo, "rev-parse", "main")]).toEqual([wave, main]);
    expect(view.reviews).toEqual([]);
    expect([view.tasks.map((task) => task.key), (await readWave(WAVE())).events.filter((event) => event.kind === "conflict").length]).toEqual([["a", "b"], 2]);
  });

  test("merge review: waves.approve only from waiting_approve, then the runner merges", async () => {
    const repo = await waveRepo(undefined, "done", { merge: "review" });
    await appendWaveEvent(WAVE(), { kind: "stage", stage: "reviewing", reason: null });
    await expect(callAction("waves.approve", { id: WAVE() })).rejects.toThrow("is reviewing, approve needs waiting_approve");
    await runWave(WAVE());
    const waiting = await getWave();
    expect([waiting.stage, waiting.actions.includes("waves.approve")]).toEqual(["waiting_approve", true]);
    const approved = ((await callAction("waves.approve", { id: WAVE() })) as { wave: WaveView }).wave;
    expect(approved.stage).toBe("merging");
    await until(async () => (await getWave()).stage === "merged");
    expect(git(repo, "log", "--format=%s", "main")).toBe("feat: add c\nfeat: add b\ninit");
    await expect(callAction("waves.approve", { id: WAVE() })).rejects.toThrow("is merged, approve needs waiting_approve");
  }, 30_000);

  test("a failing gate blocks it with reason gates, its output in the gate event; the wave's commits stay", async () => {
    const repo = await waveRepo('gates:\n  - ["sh", "-c", "echo gate broke; exit 1"]\n');
    await runWave(WAVE());
    const wave = await getWave();
    expect([wave.stage, wave.reason, wave.reviews]).toEqual(["blocked", "gates", []]);
    expect(wave.gates).toEqual([{ at: expect.any(String), phase: "review", passed: false, wallMs: expect.any(Number), log: expect.stringContaining("gate broke") }]);
    expect(git(repo, "log", "--format=%s", BRANCH)).toBe("feat: add c\nfeat: add b\ninit");
    expect(git(repo, "log", "--format=%s", "main")).toBe("init");
  });

  test("a gate exiting 75 blocks it with reason infra", async () => {
    await waveRepo('gates:\n  - ["sh", "-c", "exit 75"]\n');
    await runWave(WAVE());
    expect((await getWave()).reason).toBe("infra");
  });

  describe("merge_gates: once per wave, before the reviewer", () => {
    /** `gates` pass; `merge_gates` append a line to the count file and exit `exit`. */
    const config = (count: string, exit = 0) => `gates:\n  - ["true"]\nmerge_gates:\n  - ["sh", "-c", "echo run >> ${count}; exit ${exit}"]\n`;
    const runs = (count: string) => (existsSync(count) ? readFileSync(count, "utf8").split("\n").filter(Boolean).length : 0);

    test("the merge skips them when the target did not move since the review's run", async () => {
      const count = join(caseDir, "merge-gates");
      const repo = await waveRepo(config(count), "done", { merge: "review" });
      await runWave(WAVE());
      expect([(await getWave()).stage, runs(count)]).toEqual(["waiting_approve", 1]);
      // The gate event names the commit the suite passed on; the view does not show it (invariant 11).
      expect((await getWave()).gates).toEqual([{ at: expect.any(String), phase: "review", passed: true, wallMs: expect.any(Number), log: expect.any(String) }]);
      await holding(() => callAction("waves.approve", { id: WAVE() }));
      await runWave(WAVE());
      const wave = await getWave();
      expect([wave.stage, runs(count), wave.gates.map((gate) => gate.phase)]).toEqual(["merged", 1, ["review"]]);
      expect(git(repo, "log", "--format=%s", "main")).toBe("feat: add c\nfeat: add b\ninit");
    }, 30_000);

    test("the merge runs them again when the target moved since", async () => {
      const count = join(caseDir, "merge-gates");
      const repo = await waveRepo(config(count), "done", { merge: "review" });
      await runWave(WAVE());
      expect([(await getWave()).stage, runs(count)]).toEqual(["waiting_approve", 1]);
      commit(repo, "d.txt", "d\n", "main: add d");
      await holding(() => callAction("waves.approve", { id: WAVE() }));
      await runWave(WAVE());
      const wave = await getWave();
      expect([wave.stage, runs(count), wave.gates.map((gate) => [gate.phase, gate.passed])]).toEqual(["merged", 2, [["review", true], ["merge", true]]]);
      expect(git(repo, "log", "--format=%s", "main")).toBe("feat: add c\nfeat: add b\nmain: add d\ninit");
    }, 30_000);
  });

  test("a failing after_create hook blocks it (infra) and removes the review worktree it created: waves.retry prepares a fresh one", async () => {
    const mark = join(caseDir, "hook-may-pass");
    const repo = await waveRepo(`hooks:\n  after_create:\n    - ["test", "-e", "${mark}"]\ngates: []\n`);
    await runWave(WAVE());
    const blocked = await getWave();
    expect([blocked.stage, blocked.reason]).toEqual(["blocked", "infra"]);
    expect(existsSync(reviewWorktree(repo))).toBe(false);
    expect(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
    // The hook passes now: the retry creates the worktree again, its hook runs, the wave merges.
    writeFileSync(mark, "");
    await callAction("waves.retry", { id: WAVE() });
    await until(async () => (await getWave()).stage === "merged");
    await until(async () => (await liveWaveRunners(WAVE())).length === 0);
    expect(git(repo, "log", "--format=%s", "main")).toBe("feat: add c\nfeat: add b\ninit");
  }, 30_000);

  test("a dirty review worktree blocks it with reason dirty; the file and the worktree stay", async () => {
    const repo = await waveRepo('hooks:\n  after_create:\n    - ["sh", "-c", "echo x > stray.txt"]\ngates: []\n');
    await runWave(WAVE());
    expect([(await getWave()).stage, (await getWave()).reason]).toEqual(["blocked", "dirty"]);
    expect(readFileSync(join(reviewWorktree(repo), "stray.txt"), "utf8")).toBe("x\n");
    expect(git(repo, "log", "--format=%s", "main")).toBe("init");
  });

  test("all tasks cancelled: the wave ends cancelled without a review", async () => {
    await waveRepo(undefined, "cancelled");
    await runWave(WAVE());
    expect([(await getWave()).stage, (await getWave()).reviews]).toEqual(["cancelled", []]);
  });

  test("a poke during a run does not start a second runner; the running one is the wave's view", async () => {
    // A task still runs: the runner waits for it and lives.
    await waveRepo(undefined, "running");
    expect(await pokeWave(WAVE())).toBe(true);
    await until(async () => (await liveWaveRunners(WAVE())).length === 1);
    expect(await pokeWave(WAVE())).toBe(false);
    expect(await pokeWave(WAVE())).toBe(false);
    await Bun.sleep(500);
    expect(await liveWaveRunners(WAVE())).toHaveLength(1);
    expect([(await getWave()).running, (await getWave()).interrupted]).toEqual([true, false]);
    // The runner saw the pokes: their marker is gone.
    await until(() => !existsSync(wavePokePath(WAVE())));
  });

});

describe("a wave never waits silently (invariant 8)", () => {
  test("tasks that can never start: the runner rests, the wave builds with attention and says why once; waves.add drops them", async () => {
    await waveRepo();
    // a was cancelled after b finished; c waits for a and can never start.
    setState("a", "cancelled");
    await appendWaveEvent(WAVE(), { kind: "tasks", tasks: [{ key: "c", title: "Add d", request: "add d", after: ["a"], id: crypto.randomUUID() }] });
    expect(await runWave(WAVE())).toBe(0);
    const wave = await getWave();
    expect([wave.stage, wave.running, wave.interrupted, wave.tasks.map((task) => task.state)]).toEqual(["building", false, false, ["cancelled", "done", "pending"]]);
    const said = (await timeline()).filter((event) => event.kind === "stage");
    expect(said).toEqual([{ at: expect.any(String), kind: "stage", stage: "building", reason: null, detail: expect.stringContaining("task c can never start") }]);
    const waited = await waitWave(10_000);
    expect([waited.timedOut, waited.attention, waited.waves[0].stage]).toEqual([false, [WAVE()], "building"]);
    // A second look says nothing new.
    await runWave(WAVE());
    expect((await timeline()).filter((event) => event.kind === "stage")).toHaveLength(1);
    // The supervisor adds a task: c leaves the wave (cancelled), the new one is pending.
    const added = await holding(async () => ((await callAction("waves.add", { id: WAVE(), tasks: [{ key: "c2", title: "Add d again", request: "add d", after: ["b"] }] })) as { wave: WaveView }).wave);
    expect([added.stage, added.tasks.map((task) => [task.key, task.state]), added.counts]).toEqual([
      "building",
      [["a", "cancelled"], ["b", "done"], ["c", "cancelled"], ["c2", "pending"]],
      { total: 2, done: 1 },
    ]);
    expect((await timeline()).at(-1)).toMatchObject({ kind: "tasks", dropped: ["c"] });
  }, 30_000);

  test("a task that fails to launch blocks the wave (infra, the error in its stage event); waves.retry builds again", async () => {
    const repo = await waveRepo();
    await appendWaveEvent(WAVE(), { kind: "tasks", tasks: [{ key: "c", title: "Add d", request: "add d", after: ["a"], id: crypto.randomUUID() }] });
    // The launch refuses before it creates anything: the wave's branch is gone.
    const tip = git(repo, "rev-parse", BRANCH);
    git(repo, "branch", "-D", BRANCH);
    expect(await runWave(WAVE())).toBe(0);
    const wave = await getWave();
    expect([wave.stage, wave.reason, wave.running, wave.tasks.map((task) => task.state)]).toEqual(["blocked", "infra", false, ["done", "done", "pending"]]);
    expect((await timeline()).at(-1)).toMatchObject({ kind: "stage", stage: "blocked", reason: "infra", detail: expect.stringContaining(`starting its task c failed: ${repo}: branch ${BRANCH} does not exist locally`) });
    const waited = await waitWave(10_000);
    expect([waited.timedOut, waited.attention]).toEqual([false, [WAVE()]]);
    // Fixed: a retry with a task not started builds again (not a review).
    git(repo, "branch", BRANCH, tip);
    const retried = await holding(async () => ((await callAction("waves.retry", { id: WAVE() })) as { wave: WaveView }).wave);
    expect(retried.stage).toBe("building");
  }, 30_000);

  test("waves.add while it reviews kills the review at once: the runner loses its stage change, removes the worktree, builds on", async () => {
    const repo = await waveRepo();
    // A record of the added task already exists (as a crashed launch would leave it): the runner adopts it, so nothing launches.
    const record: TaskRecord = {
      id: taskId(3),
      repo,
      worktree: join(caseDir, "task-x"),
      branch: "task-x",
      title: "Fix b",
      sessionId: `session-${RUN}-${caseSerial()}-x`,
      sessionDir: join(caseDir, "sessions"),
      createdAt: "2026-01-01T00:00:03.000Z",
      tag: "factory/w1",
      plan: null,
      wave: WAVE(),
      origin: null,
    };
    await writeTask(record);
    setState("x", "done");
    process.env.FAKE_REVIEW_SLEEP = "120000";
    await appendWaveEvent(WAVE(), { kind: "stage", stage: "reviewing", reason: null });
    const run = runWave(WAVE());
    await until(() => existsSync(promptLog));
    // The next reviewer answers at once.
    delete process.env.FAKE_REVIEW_SLEEP;
    const added = Date.now();
    // The added task's id is the record's, as the launch that crashed took it.
    const uuid = spyOn(crypto, "randomUUID").mockReturnValue(taskId(3) as ReturnType<typeof crypto.randomUUID>);
    await callAction("waves.add", { id: WAVE(), tasks: [{ key: "x", title: "Fix b", request: "fix b", after: ["a"] }] });
    uuid.mockRestore();
    await until(async () => (await timeline()).some((event) => event.kind === "task" && event.key === "x"), 10_000);
    expect(Date.now() - added).toBeLessThan(10_000);
    expect(await run).toBe(0);
    const events = await timeline();
    expect(events.map((event) => event.stage ?? event.kind)).toEqual(["tasks", "task", "task", "reviewing", "gate", "tasks", "building", "task", "reviewing", "gate", "review", "merging", "merge", "merged"]);
    expect(events.find((event) => event.kind === "task" && event.key === "x")?.taskId).toBe(taskId(3));
    expect(existsSync(reviewWorktree(repo))).toBe(false);
    expect(git(repo, "log", "--format=%s", "main")).toBe("feat: add c\nfeat: add b\ninit");
  }, 30_000);
});

describe("resuming from the log", () => {
  test("an interrupted merging stage merges", async () => {
    const repo = await waveRepo();
    await appendWaveEvent(WAVE(), { kind: "stage", stage: "reviewing", reason: null });
    await appendWaveEvent(WAVE(), { kind: "review", round: 1, sessionId: null, model: null, verdict: "approved", status: "ok", findings: [], usage: null, wallMs: 1 });
    await appendWaveEvent(WAVE(), { kind: "stage", stage: "merging", reason: null });
    expect(await runWave(WAVE())).toBe(0);
    expect((await getWave()).stage).toBe("merged");
    expect(git(repo, "log", "--format=%s", "main")).toBe("feat: add c\nfeat: add b\ninit");
    expect((await timeline()).slice(-2).map((event) => event.stage ?? event.kind)).toEqual(["merge", "merged"]);
    expect(existsSync(reviewWorktree(repo))).toBe(false);
  });

});

/** The log of a wave whose review approved it: the runner resumes at the merge. */
async function approvedForMerge(): Promise<void> {
  await appendWaveEvent(WAVE(), { kind: "stage", stage: "reviewing", reason: null });
  await appendWaveEvent(WAVE(), { kind: "review", round: 1, sessionId: null, model: null, verdict: "approved", status: "ok", findings: [], usage: null, wallMs: 1 });
  await appendWaveEvent(WAVE(), { kind: "stage", stage: "merging", reason: null });
}

describe("the merge takes the review worktree as it is (invariant 2)", () => {
  test("a worktree that holds anything but its commit before the merge blocks it as dirty, named; the file stays, the target unmoved", async () => {
    const repo = await waveRepo();
    git(repo, "worktree", "add", "--quiet", reviewWorktree(repo), BRANCH);
    writeFileSync(join(reviewWorktree(repo), "notes.txt"), "mine\n");
    await approvedForMerge();
    await runWave(WAVE());
    expect([(await getWave()).stage, (await getWave()).reason, (await getWave()).merge]).toEqual(["blocked", "dirty", null]);
    expect((await timeline()).at(-1)?.detail).toContain("notes.txt");
    expect(readFileSync(join(reviewWorktree(repo), "notes.txt"), "utf8")).toBe("mine\n");
    expect(git(repo, "log", "--format=%s", "main")).toBe("init");
  });

  test("a merge gate that rewrites a tracked file blocks it as dirty: the gated tree is not the one that would merge", async () => {
    const repo = await waveRepo('gates: []\nmerge_gates:\n  - ["sh", "-c", "echo changed > b.txt"]\n');
    await approvedForMerge();
    await runWave(WAVE());
    const wave = await getWave();
    expect([wave.stage, wave.reason, wave.merge, wave.gates.map((gate) => [gate.phase, gate.passed])]).toEqual(["blocked", "dirty", null, [["merge", true]]]);
    expect(git(repo, "log", "--format=%s", "main")).toBe("init");
    expect(git(repo, "rev-parse", `refs/heads/${BRANCH}`)).not.toBe(git(repo, "rev-parse", "main"));
  });

  test("what a merge gate leaves untracked is removed: the target gets the wave's commits only, the worktree goes", async () => {
    const repo = await waveRepo('gates: []\nmerge_gates:\n  - ["sh", "-c", "echo x > out.log"]\n');
    await approvedForMerge();
    await runWave(WAVE());
    expect([(await getWave()).stage, (await getWave()).gates.map((gate) => [gate.phase, gate.passed])]).toEqual(["merged", [["merge", true]]]);
    expect(git(repo, "log", "--format=%s", "main")).toBe("feat: add c\nfeat: add b\ninit");
    expect(git(repo, "ls-tree", "-r", "--name-only", "main")).toBe("a.txt\nb.txt\nc.txt\nfactory.yaml");
    // `git worktree remove` (never forced) refuses a worktree with untracked files: it went, so out.log was gone.
    expect(existsSync(reviewWorktree(repo))).toBe(false);
  });
});

describe("a runner stopped from outside", () => {
  test("SIGTERM while it reviews leaves the wave interrupted, not blocked: nothing recorded, the worktree kept; a resume reviews again", async () => {
    const repo = await waveRepo();
    process.env.FAKE_REVIEW_SLEEP = "120000";
    await appendWaveEvent(WAVE(), { kind: "stage", stage: "reviewing", reason: null });
    expect(await pokeWave(WAVE())).toBe(true);
    await until(() => existsSync(promptLog));
    const [pid] = await liveWaveRunners(WAVE());
    process.kill(pid, "SIGTERM");
    await until(async () => (await liveWaveRunners(WAVE())).length === 0);
    const wave = await getWave();
    expect([wave.stage, wave.reason, wave.interrupted, wave.reviews, wave.actions.includes("waves.retry")]).toEqual(["reviewing", null, true, [], true]);
    expect((await timeline()).map((event) => event.stage ?? event.kind)).toEqual(["tasks", "task", "task", "reviewing", "gate"]);
    expect(existsSync(reviewWorktree(repo))).toBe(true);
    delete process.env.FAKE_REVIEW_SLEEP;
    expect(await runWave(WAVE())).toBe(0);
    expect((await getWave()).stage).toBe("merged");
    expect(git(repo, "log", "--format=%s", "main")).toBe("feat: add c\nfeat: add b\ninit");
  }, 30_000);
});
