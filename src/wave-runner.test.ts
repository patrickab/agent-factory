/**
 * The wave runner over real git repos in a temp dir: the wave's tasks are records whose sessions say `done`, their
 * work commits on the wave's branch, and the reviewer is a fake `pi` on PATH (`--mode json`, an approving `submit_verdict`
 * call). `runWave` runs in this process; the poke tests start real detached runners.
 */
import { describe, expect, spyOn } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callAction } from "./core.ts";
import { expectError, git, noted, until } from "./core-test-kit.ts";
import { liveWaveRunners, pokeWave, wavePokePath } from "./wave-poke.ts";
import { writeTask } from "./tasks.ts";
import { runWave } from "./wave-runner.ts";
import { BRANCH, caseDir, commit, getWave, holding, reviewWorktree, setState, taskRecord, useWaveFixture, WAVE, waveRepo } from "./wave-test-kit.ts";
import { appendWaveEvent, readWave, type WaveView } from "./waves.ts";
import { NO_USAGE } from "./util.ts";

const test = useWaveFixture();

type Event = { at?: string; kind: string; stage?: string; reason?: string | null; detail?: string; dropped?: string[]; key?: string; taskId?: string };
const timeline = async () => (await readWave(WAVE())).events as Event[];
type WaitResult = { waves: WaveView[]; attention: string[]; timedOut: boolean };
const waitWave = async (timeoutMs: number) => (await callAction("tasks.wait", { wave: WAVE(), timeoutMs })) as WaitResult;

describe("the wave runner", () => {

  test("waves.add moves a rejected wave again and pokes the runner", async () => {
    await waveRepo();
    await appendWaveEvent(WAVE(), { kind: "stage", stage: "rejected", reason: null });
    // A live runner holds the wave (this process): the poke leaves its marker and starts none.
    await holding(async () => {
      const added = ((await callAction("waves.add", { id: WAVE(), tasks: [{ key: "fix", title: "Fix b", request: "fix b", after: ["a"] }] })) as { wave: WaveView }).wave;
      expect([added.stage, added.counts]).toEqual(["building", { total: 3, done: 2 }]);
      expect(existsSync(wavePokePath(WAVE()))).toBe(true);
      expect(await liveWaveRunners(WAVE())).toEqual([]);
    });
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
    expect([view.stage, view.reason]).toEqual(["blocked", "conflict"]);
    expect([git(repo, "rev-parse", BRANCH), git(repo, "rev-parse", "main")]).toEqual([wave, main]);
    expect(view.reviews).toEqual([]);
    expect([view.tasks.map((task) => task.key), (await readWave(WAVE())).events.filter((event) => event.kind === "conflict").length]).toEqual([["a", "b"], 2]);
  });

  test("merge review: waves.approve only from waiting_approve, then the runner merges", async () => {
    const repo = await waveRepo(undefined, "done", { merge: "review" });
    await appendWaveEvent(WAVE(), { kind: "stage", stage: "reviewing", reason: null });
    await expectError(callAction("waves.approve", { id: WAVE() }), "refused");
    await runWave(WAVE());
    const waiting = await getWave();
    expect([waiting.stage, waiting.actions.includes("waves.approve")]).toEqual(["waiting_approve", true]);
    const approved = ((await callAction("waves.approve", { id: WAVE() })) as { wave: WaveView }).wave;
    expect(approved.stage).toBe("merging");
    await until(async () => (await getWave()).stage === "merged");
    expect(git(repo, "log", "--format=%s", "main")).toBe("feat: add c\nfeat: add b\ninit");
    await expectError(callAction("waves.approve", { id: WAVE() }), "refused");
    expect((await getWave()).stage).toBe("merged");
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
    // The runner saw the pokes: their marker is gone, and it is still the only one.
    await until(() => !existsSync(wavePokePath(WAVE())));
    expect(await liveWaveRunners(WAVE())).toHaveLength(1);
    expect([(await getWave()).running, (await getWave()).interrupted]).toEqual([true, false]);
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
    expect(said).toEqual([{ at: expect.any(String), kind: "stage", stage: "building", reason: null, detail: expect.any(String) }]);
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
    const last = (await timeline()).at(-1);
    expect(last).toMatchObject({ kind: "stage", stage: "blocked", reason: "infra", detail: expect.any(String) });
    expect(JSON.stringify(last)).not.toContain(repo);
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
    const record = taskRecord(repo, "x", 3);
    await writeTask(record);
    setState("x", "done");
    process.env.FAKE_REVIEW_SLEEP = "120000";
    await appendWaveEvent(WAVE(), { kind: "stage", stage: "reviewing", reason: null });
    const run = runWave(WAVE());
    await until(() => noted("reviewing").length > 0);
    // The next reviewer answers at once.
    delete process.env.FAKE_REVIEW_SLEEP;
    // The added task's id is the record's, as the launch that crashed took it.
    const uuid = spyOn(crypto, "randomUUID").mockReturnValue(record.id as ReturnType<typeof crypto.randomUUID>);
    await callAction("waves.add", { id: WAVE(), tasks: [{ key: "x", title: "Fix b", request: "fix b", after: ["a"] }] });
    uuid.mockRestore();
    await until(async () => (await timeline()).some((event) => event.kind === "task" && event.key === "x"), 10_000);
    expect(await run).toBe(0);
    // The killed review recorded no verdict: one review, of the wave with the added task.
    expect((await getWave()).reviews).toHaveLength(1);
    expect((await timeline()).find((event) => event.kind === "task" && event.key === "x")?.taskId).toBe(record.id);
    expect(existsSync(reviewWorktree(repo))).toBe(false);
    expect(git(repo, "log", "--format=%s", "main")).toBe("feat: add c\nfeat: add b\ninit");
  }, 30_000);
});

describe("resuming from the log", () => {
  test("an interrupted merging stage merges", async () => {
    const repo = await waveRepo();
    await approvedForMerge();
    expect(await runWave(WAVE())).toBe(0);
    expect((await getWave()).stage).toBe("merged");
    expect(git(repo, "log", "--format=%s", "main")).toBe("feat: add c\nfeat: add b\ninit");
    expect(existsSync(reviewWorktree(repo))).toBe(false);
  });
});

/** The log of a wave whose review approved it: the runner resumes at the merge. */
async function approvedForMerge(): Promise<void> {
  await appendWaveEvent(WAVE(), { kind: "stage", stage: "reviewing", reason: null });
  await appendWaveEvent(WAVE(), { kind: "review", round: 1, sessionId: null, model: null, verdict: "approved", status: "ok", findings: [], usage: NO_USAGE, wallMs: 1 });
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
    await until(() => noted("reviewing").length > 0);
    const [pid] = await liveWaveRunners(WAVE());
    process.kill(pid, "SIGTERM");
    await until(async () => (await liveWaveRunners(WAVE())).length === 0);
    const wave = await getWave();
    expect([wave.stage, wave.reason, wave.interrupted, wave.reviews, wave.actions.includes("waves.retry")]).toEqual(["reviewing", null, true, [], true]);
    expect(existsSync(reviewWorktree(repo))).toBe(true);
    delete process.env.FAKE_REVIEW_SLEEP;
    expect(await runWave(WAVE())).toBe(0);
    expect((await getWave()).stage).toBe("merged");
    expect(git(repo, "log", "--format=%s", "main")).toBe("feat: add c\nfeat: add b\ninit");
  }, 30_000);
});
