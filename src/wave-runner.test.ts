/**
 * The wave runner over real git repos in a temp dir: the wave's tasks are records whose sessions say `done`, their
 * work commits on the wave's branch, and the reviewer is a fake `pi` on PATH (`--mode json`, a `submit_verdict` call
 * whose findings `$FAKE_VERDICT` chooses). `runWave` runs in this process; the poke tests start real detached runners.
 */
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { callAction } from "./core.ts";
import { worktreePath } from "./launch.ts";
import { writeTask, type TaskRecord } from "./tasks.ts";
import { liveWaveRunners, pokeWave, stopWaveRunners, wavePokePath, waveReviewsDir } from "./wave-poke.ts";
import { pathFree, runWave } from "./wave-runner.ts";
import { appendWaveEvent, createWave, foldWave, listWaves, lockWave, readWave, unlockWave, type WaveView } from "./waves.ts";
import { MERGE_PUSH_PENDING } from "./remote.ts";
import { pendingMarks } from "./sync.ts";

const savedEnv = { ...process.env };
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "factory-wave-runner-test-")));
const fakeBin = join(scratch, "bin");
const promptLog = join(scratch, "reviewer-prompt.txt");
const argvLog = join(scratch, "reviewer-argv.txt");

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
writeFileSync(process.env.FAKE_ARGV_LOG, args.join("\\n"));
if (process.env.FAKE_REVIEW_SLEEP) await Bun.sleep(Number(process.env.FAKE_REVIEW_SLEEP));
const findings = process.env.FAKE_VERDICT === "reject" ? [{ file: "b.txt", line: 1, severity: "major", text: "b is wrong" }] : [];
const emit = (record) => console.log(JSON.stringify(record));
emit({ type: "session", id });
emit({ type: "tool_execution_end", toolName: "submit_verdict", isError: false, result: { details: { findings } } });
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
    FAKE_ARGV_LOG: argvLog,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "test",
    GIT_COMMITTER_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_EMAIL: "test@example.com",
  });
  delete process.env.FAKE_VERDICT;
  delete process.env.FAKE_REVIEW_SLEEP;
  rmSync(promptLog, { force: true });
});

afterEach(async () => {
  for (const wave of await listWaves()) await stopWaveRunners(wave.declaration.id);
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(cwd: string, file: string, text: string, message: string): string {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", "-A");
  git(cwd, "commit", "--quiet", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(50);
  }
}

/** Part of every fixed id and session id here: a concurrent test run (another worktree) never matches these runners. */
const RUN = randomBytes(2).toString("hex");
const WAVE = `30000000-${RUN}-4000-8000-000000000001`;
const BRANCH = "main-factory-w1";
const taskId = (n: number) => `40000000-0000-4000-8000-00000000000${n}`;

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
  await createWave({ id: WAVE, repo, tag: "factory/w1", plan: null, title: "Wave one", request: "Check b and c.\nKeep it small.", branch: BRANCH, target: "main", base, origin: null, createdAt: "2026-01-01T00:00:00.000Z", overrides });
  const specs = [
    { key: "a", title: "Add b", request: "add b", after: [] },
    { key: "b", title: "Add c", request: "add c", after: ["a"] },
  ];
  await appendWaveEvent(WAVE, { kind: "tasks", tasks: specs });
  for (const [index, spec] of specs.entries()) {
    const record: TaskRecord = {
      id: taskId(index + 1),
      repo,
      worktree: join(caseDir, `task-${spec.key}`),
      branch: `task-${spec.key}`,
      title: spec.title,
      sessionId: `session-${RUN}-${spec.key}`,
      sessionDir: join(caseDir, "sessions"),
      createdAt: `2026-01-01T00:00:0${index + 1}.000Z`,
      tag: "factory/w1",
      plan: null,
      wave: WAVE,
      origin: null,
    };
    await writeTask(record);
    mkdirSync(record.sessionDir, { recursive: true });
    const entry = { type: "custom", customType: "factory-state", data: { state, round: 1, reason: "r" } };
    writeFileSync(join(record.sessionDir, `2026-01-01T00-00-00-000Z_${record.sessionId}.jsonl`), `${JSON.stringify(entry)}\n`);
    await appendWaveEvent(WAVE, { kind: "task", key: spec.key, taskId: record.id, sessionId: record.sessionId });
  }
  return repo;
}

const getWave = async () => ((await callAction("waves.get", { id: WAVE })) as { wave: WaveView }).wave;
type Event = { at?: string; kind: string; stage?: string; reason?: string | null; detail?: string; dropped?: string[]; key?: string; taskId?: string };
const timeline = async () => ((await callAction("waves.timeline", { id: WAVE })) as { events: Event[] }).events;
type WaitResult = { waves: WaveView[]; attention: string[]; timedOut: boolean };
const waitWave = async (timeoutMs: number) => (await callAction("tasks.wait", { wave: WAVE, timeoutMs })) as WaitResult;
/** Overwrites the session of the wave's task `key` with one state. */
const setState = (key: string, state: string) =>
  writeFileSync(join(caseDir, "sessions", `2026-01-01T00-00-00-000Z_session-${RUN}-${key}.jsonl`), `${JSON.stringify({ type: "custom", customType: "factory-state", data: { state, round: 1, reason: "r" } })}\n`);
/** Holds the runner's lock in this process while `act` runs: a poke leaves its marker and starts no runner. */
async function holding<T>(act: () => Promise<T>): Promise<T> {
  await lockWave(WAVE);
  try {
    return await act();
  } finally {
    await unlockWave(WAVE);
  }
}
const reviewWorktree = (repo: string) => worktreePath(repo, `wave-${WAVE.slice(0, 8)}-review`);

describe("the wave runner", () => {
  test("a wave of two chained tasks runs to merged: the target holds both commits unsquashed, every step has its event", async () => {
    const repo = await waveRepo();
    // The target moved on meanwhile: the wave is rebased onto it, commit by commit.
    const moved = commit(repo, "d.txt", "d\n", "main: add d");
    expect(await runWave(WAVE)).toBe(0);
    const wave = await getWave();
    expect([wave.stage, wave.reason, wave.running, wave.interrupted, wave.counts]).toEqual(["merged", null, false, false, { total: 2, done: 2 }]);
    expect(git(repo, "log", "--format=%s", "main")).toBe("feat: add c\nfeat: add b\nmain: add d\ninit");
    expect(git(repo, "rev-parse", `refs/heads/${BRANCH}`)).toBe(git(repo, "rev-parse", "main"));
    expect(wave.merge).toEqual({ at: expect.any(String), from: moved, to: git(repo, "rev-parse", "main"), queueMs: expect.any(Number) });
    expect(wave.reviews).toEqual([
      { at: expect.any(String), round: 1, sessionId: "11111111-2222-4333-8444-555555555555", model: null, verdict: "approved", status: "ok", findings: [], usage: { input: 100, output: 20, cacheRead: 900, cacheWrite: 30, cost: 0.5 }, wallMs: expect.any(Number) },
    ]);
    expect(wave.gates.map((gate) => [gate.phase, gate.passed])).toEqual([["review", true]]);
    expect(wave.usage).toEqual({ input: 100, output: 20, cacheRead: 900, cacheWrite: 30, cost: 0.5 });
    const timeline = (await callAction("waves.timeline", { id: WAVE })) as { events: { kind: string; stage?: string }[] };
    expect(timeline.events.map((event) => event.stage ?? event.kind)).toEqual(["tasks", "task", "task", "reviewing", "gate", "review", "merging", "merge", "merged"]);
    // The reviewer got the wave's whole diff and its request verbatim.
    const prompt = readFileSync(promptLog, "utf8");
    expect(prompt).toContain(`Review the wave "Wave one": the branch ${BRANCH}, rebased onto main, merges into it.`);
    const requestFile = join(waveReviewsDir(WAVE), "round-1.request.md");
    expect(prompt).toContain(requestFile);
    expect(readFileSync(requestFile, "utf8")).toContain("## Instructions from the supervisor\n\nCheck b and c.\nKeep it small.\n\n## Tasks of the wave\n");
    expect(existsSync(reviewWorktree(repo))).toBe(false);
  });

  test("a merged wave calls waveLanded: the other building wave's branch is rebased onto the target, its running task marked, both in the log", async () => {
    const repo = await waveRepo();
    // A second wave on main, building, with a running task off its branch.
    const other = `30000000-${RUN}-4000-8000-000000000002`;
    const otherBranch = "main-factory-w2";
    git(repo, "branch", otherBranch, "main");
    const work = join(caseDir, "work2");
    git(repo, "worktree", "add", "--quiet", work, otherBranch);
    commit(work, "e.txt", "e\n", "feat: add e");
    git(repo, "worktree", "remove", work);
    await createWave({ id: other, repo, tag: "factory/w2", plan: null, title: "Wave two", request: "r", branch: otherBranch, target: "main", base: git(repo, "rev-parse", "main"), origin: null, createdAt: "2026-01-01T00:00:00.000Z", overrides: {} });
    const running: TaskRecord = { id: taskId(7), repo, worktree: join(caseDir, "task-w2"), branch: "task-w2", title: "Two", sessionId: `session-${RUN}-w2`, sessionDir: join(caseDir, "sessions"), createdAt: "2026-01-01T00:00:07.000Z", tag: "factory/w2", plan: null, wave: other, origin: null };
    await writeTask(running);
    writeFileSync(join(running.sessionDir, `2026-01-01T00-00-00-000Z_${running.sessionId}.jsonl`), `${JSON.stringify({ type: "custom", customType: "factory-state", data: { state: "running", round: 1, reason: "r" } })}\n`);
    const lines: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => void lines.push(args.join(" ")));
    try {
      expect(await runWave(WAVE)).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect((await getWave()).stage).toBe("merged");
    expect(git(repo, "rev-parse", `${otherBranch}^`)).toBe(git(repo, "rev-parse", "main"));
    expect(lines.some((line) => line.includes(`wave ${other.slice(0, 8)}: ${otherBranch} rebased onto main, 1 task to sync`))).toBe(true);
    expect((await pendingMarks(running.id)).map((mark) => mark.branch)).toEqual([otherBranch]);
  });

  test("the reviewer's request file holds each done task's title, request and coder's last message, no cancelled task", async () => {
    await waveRepo();
    // Task a's coder said what it left open; a third task was cancelled (its record removed).
    const say = (text: string) => JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
    writeFileSync(join(caseDir, "sessions", `2026-01-01T00-00-00-000Z_session-${RUN}-a.jsonl`), [JSON.stringify({ type: "custom", customType: "factory-state", data: { state: "done", round: 1, reason: "r" } }), say("Risk: b.txt has no newline check.")].join("\n") + "\n");
    await appendWaveEvent(WAVE, { kind: "tasks", tasks: [{ key: "c", title: "Add nothing", request: "a cancelled request", after: [] }] });
    await appendWaveEvent(WAVE, { kind: "task", key: "c", taskId: taskId(9), sessionId: `session-${RUN}-c` });
    expect(await runWave(WAVE)).toBe(0);
    expect((await getWave()).stage).toBe("merged");
    const request = readFileSync(join(waveReviewsDir(WAVE), "round-1.request.md"), "utf8");
    expect(request).toBe(
      "# Wave one\n\n## Instructions from the supervisor\n\nCheck b and c.\nKeep it small.\n\n## Tasks of the wave\n\n" +
        "### Add b\n\n#### Request\n\nadd b\n\n#### The coder's last message\n\nRisk: b.txt has no newline check.\n\n" +
        "### Add c\n\n#### Request\n\nadd c\n\n#### The coder's last message\n\n(none)\n",
    );
    expect(request).not.toContain("a cancelled request");
    // Large text stays in the file: the prompt only names it.
    expect(readFileSync(promptLog, "utf8")).not.toContain("add b");
  });

  test("merge review: an approved wave waits for approve, its worktree removed", async () => {
    const repo = await waveRepo(undefined, "done", { merge: "review" });
    await runWave(WAVE);
    expect((await getWave()).stage).toBe("waiting_approve");
    expect(git(repo, "log", "--format=%s", "main")).toBe("init");
    expect(existsSync(reviewWorktree(repo))).toBe(false);
  });

  test("a wave resolved from stored settings (merge review, a reviewer model) waits for approve; its reviewer runs on that model", async () => {
    // waves.start stores the repository's settings resolved in the declaration (core.test.ts); the runner reads only it.
    const repo = await waveRepo(undefined, "done", { merge: "review", maxRounds: 2, review: false, models: { reviewer: "x/y" } });
    await runWave(WAVE);
    const wave = await getWave();
    expect([wave.stage, wave.reviews.map((review) => review.model)]).toEqual(["waiting_approve", ["x/y"]]);
    const argv = readFileSync(argvLog, "utf8").split("\n");
    expect(argv[argv.indexOf("--model") + 1]).toBe("x/y");
    expect(git(repo, "log", "--format=%s", "main")).toBe("init");
  });

  test("a rejected review rests rejected with its findings; waves.add moves the wave again and pokes the runner", async () => {
    process.env.FAKE_VERDICT = "reject";
    const repo = await waveRepo();
    await runWave(WAVE);
    const rejected = await getWave();
    expect(rejected.stage).toBe("rejected");
    expect(rejected.reviews.map((review) => [review.verdict, review.findings])).toEqual([["rejected", [{ severity: "major", file: "b.txt", line: 1, text: "b is wrong" }]]]);
    expect(git(repo, "log", "--format=%s", "main")).toBe("init");
    // A live runner holds the wave (this process): the poke leaves its marker and starts none.
    await lockWave(WAVE);
    try {
      const added = ((await callAction("waves.add", { id: WAVE, tasks: [{ key: "fix", title: "Fix b", request: "fix b", after: ["a"] }] })) as { wave: WaveView }).wave;
      expect([added.stage, added.counts]).toEqual(["building", { total: 3, done: 2 }]);
      expect(existsSync(wavePokePath(WAVE))).toBe(true);
      expect(await liveWaveRunners(WAVE)).toEqual([]);
    } finally {
      await unlockWave(WAVE);
    }
  });

  test("a rebase conflict blocks it with reason conflict and deletes nothing", async () => {
    const repo = await waveRepo();
    const wave = git(repo, "rev-parse", BRANCH);
    commit(repo, "b.txt", "main's b\n", "main: add b");
    const main = git(repo, "rev-parse", "main");
    await runWave(WAVE);
    expect([(await getWave()).stage, (await getWave()).reason]).toEqual(["blocked", "conflict"]);
    expect([git(repo, "rev-parse", BRANCH), git(repo, "rev-parse", "main")]).toEqual([wave, main]);
    expect((await getWave()).reviews).toEqual([]);
  });

  test("waves.retry after a blocked rebase: review and merge run again from the rebase, in a runner it starts", async () => {
    const repo = await waveRepo();
    const init = git(repo, "rev-parse", "main");
    commit(repo, "b.txt", "main's b\n", "main: add b");
    await runWave(WAVE);
    expect([(await getWave()).stage, (await getWave()).actions]).toEqual(["blocked", ["waves.add", "waves.retry", "waves.cancel", "waves.remove"]]);
    // The supervisor resolves it: the conflicting commit leaves the target.
    git(repo, "reset", "--quiet", "--hard", init);
    const retried = ((await callAction("waves.retry", { id: WAVE })) as { wave: WaveView }).wave;
    expect(retried.stage).toBe("reviewing");
    await until(async () => (await getWave()).stage === "merged");
    await until(async () => (await liveWaveRunners(WAVE)).length === 0);
    expect(git(repo, "log", "--format=%s", "main")).toBe("feat: add c\nfeat: add b\ninit");
    const timeline = (await callAction("waves.timeline", { id: WAVE })) as { events: { kind: string; stage?: string; reason?: string }[] };
    expect(timeline.events.map((event) => event.stage ?? event.kind)).toEqual(["tasks", "task", "task", "reviewing", "blocked", "reviewing", "gate", "review", "merging", "merge", "merged"]);
  }, 30_000);

  test("merge review: waves.approve only from waiting_approve, then the runner merges", async () => {
    const repo = await waveRepo(undefined, "done", { merge: "review" });
    await appendWaveEvent(WAVE, { kind: "stage", stage: "reviewing", reason: null });
    await expect(callAction("waves.approve", { id: WAVE })).rejects.toThrow("is reviewing, approve needs waiting_approve");
    await runWave(WAVE);
    const waiting = await getWave();
    expect([waiting.stage, waiting.actions.includes("waves.approve")]).toEqual(["waiting_approve", true]);
    const approved = ((await callAction("waves.approve", { id: WAVE })) as { wave: WaveView }).wave;
    expect(approved.stage).toBe("merging");
    await until(async () => (await getWave()).stage === "merged");
    expect(git(repo, "log", "--format=%s", "main")).toBe("feat: add c\nfeat: add b\ninit");
    await expect(callAction("waves.approve", { id: WAVE })).rejects.toThrow("is merged, approve needs waiting_approve");
  }, 30_000);

  test("a failing gate blocks it with reason gates, its output in the gate event; the wave's commits stay", async () => {
    const repo = await waveRepo('gates:\n  - ["sh", "-c", "echo gate broke; exit 1"]\n');
    await runWave(WAVE);
    const wave = await getWave();
    expect([wave.stage, wave.reason, wave.reviews]).toEqual(["blocked", "gates", []]);
    expect(wave.gates).toEqual([{ at: expect.any(String), phase: "review", passed: false, wallMs: expect.any(Number), log: expect.stringContaining("gate broke") }]);
    expect(git(repo, "log", "--format=%s", BRANCH)).toBe("feat: add c\nfeat: add b\ninit");
    expect(git(repo, "log", "--format=%s", "main")).toBe("init");
  });

  test("a gate exiting 75 blocks it with reason infra", async () => {
    await waveRepo('gates:\n  - ["sh", "-c", "exit 75"]\n');
    await runWave(WAVE);
    expect((await getWave()).reason).toBe("infra");
  });

  describe("merge_gates: once per wave, before the reviewer", () => {
    /** `gates` pass; `merge_gates` append a line to the count file and exit `exit`. */
    const config = (count: string, exit = 0) => `gates:\n  - ["true"]\nmerge_gates:\n  - ["sh", "-c", "echo run >> ${count}; exit ${exit}"]\n`;
    const runs = (count: string) => (existsSync(count) ? readFileSync(count, "utf8").split("\n").filter(Boolean).length : 0);

    test("failing merge_gates block the wave with reason gates before any reviewer starts", async () => {
      const count = join(caseDir, "merge-gates");
      const repo = await waveRepo(config(count, 1));
      await runWave(WAVE);
      const wave = await getWave();
      // A failed step runs once more before it counts.
      expect([wave.stage, wave.reason, wave.reviews, runs(count)]).toEqual(["blocked", "gates", [], 2]);
      expect(wave.gates.map((gate) => [gate.phase, gate.passed])).toEqual([["review", false]]);
      expect(existsSync(promptLog)).toBe(false);
      expect(git(repo, "log", "--format=%s", "main")).toBe("init");
    });

    test("the merge skips them when the target did not move since the review's run", async () => {
      const count = join(caseDir, "merge-gates");
      const repo = await waveRepo(config(count), "done", { merge: "review" });
      await runWave(WAVE);
      expect([(await getWave()).stage, runs(count)]).toEqual(["waiting_approve", 1]);
      // The gate event names the commit the suite passed on; the view does not show it (invariant 11).
      expect((await getWave()).gates).toEqual([{ at: expect.any(String), phase: "review", passed: true, wallMs: expect.any(Number), log: expect.any(String) }]);
      await holding(() => callAction("waves.approve", { id: WAVE }));
      await runWave(WAVE);
      const wave = await getWave();
      expect([wave.stage, runs(count), wave.gates.map((gate) => gate.phase)]).toEqual(["merged", 1, ["review"]]);
      expect(git(repo, "log", "--format=%s", "main")).toBe("feat: add c\nfeat: add b\ninit");
    }, 30_000);

    test("the merge runs them again when the target moved since", async () => {
      const count = join(caseDir, "merge-gates");
      const repo = await waveRepo(config(count), "done", { merge: "review" });
      await runWave(WAVE);
      expect([(await getWave()).stage, runs(count)]).toEqual(["waiting_approve", 1]);
      commit(repo, "d.txt", "d\n", "main: add d");
      await holding(() => callAction("waves.approve", { id: WAVE }));
      await runWave(WAVE);
      const wave = await getWave();
      expect([wave.stage, runs(count), wave.gates.map((gate) => [gate.phase, gate.passed])]).toEqual(["merged", 2, [["review", true], ["merge", true]]]);
      expect(git(repo, "log", "--format=%s", "main")).toBe("feat: add c\nfeat: add b\nmain: add d\ninit");
    }, 30_000);
  });

  describe("a failed gate runs once more", () => {
    /** `merge_gates` append a line to the count file and exit 1 on the runs in `failOn` (1-based). */
    const config = (count: string, failOn: number[]) =>
      `gates:\n  - ["true"]\nmerge_gates:\n  - ["sh", "-c", "echo run >> ${count}; n=$(wc -l < ${count}); case \\" ${failOn.join(" ")} \\" in *\\" $n \\"*) echo '(fail) wave > races'; exit 1;; esac"]\n`;
    const runs = (count: string) => (existsSync(count) ? readFileSync(count, "utf8").split("\n").filter(Boolean).length : 0);

    test("review: fails then passes, the wave goes on and its gate event records flaky", async () => {
      const count = join(caseDir, "merge-gates");
      await waveRepo(config(count, [1]), "done", { merge: "review" });
      await runWave(WAVE);
      const wave = await getWave();
      expect([wave.stage, runs(count)]).toEqual(["waiting_approve", 2]);
      expect(wave.gates).toEqual([{ at: expect.any(String), phase: "review", passed: true, wallMs: expect.any(Number), log: expect.any(String), flaky: ["wave > races"] }]);
    });

    test("merge: fails then passes, merged with flaky on the merge gate event", async () => {
      const count = join(caseDir, "merge-gates");
      const repo = await waveRepo(config(count, [2]), "done", { merge: "review" });
      await runWave(WAVE);
      commit(repo, "d.txt", "d\n", "main: add d");
      await holding(() => callAction("waves.approve", { id: WAVE }));
      await runWave(WAVE);
      const wave = await getWave();
      expect([wave.stage, runs(count)]).toEqual(["merged", 3]);
      expect(wave.gates.map((gate) => [gate.phase, gate.passed, gate.flaky])).toEqual([["review", true, undefined], ["merge", true, ["wave > races"]]]);
    }, 30_000);

    test.each([
      ["exit 75", "exit 75", "infra" as const],
      ["a kill", "kill -9 $$", "gates" as const],
    ])("no rerun after %s", async (_name, end, reason) => {
      const count = join(caseDir, "merge-gates");
      await waveRepo(`gates:\n  - ["true"]\nmerge_gates:\n  - ["sh", "-c", "echo run >> ${count}; ${end}"]\n`);
      await runWave(WAVE);
      const wave = await getWave();
      expect([wave.stage, wave.reason, runs(count)]).toEqual(["blocked", reason, 1]);
    });
  });

  test("a failing after_create hook blocks it (infra) and removes the review worktree it created: waves.retry prepares a fresh one", async () => {
    const mark = join(caseDir, "hook-may-pass");
    const repo = await waveRepo(`hooks:\n  after_create:\n    - ["test", "-e", "${mark}"]\ngates: []\n`);
    await runWave(WAVE);
    const blocked = await getWave();
    expect([blocked.stage, blocked.reason]).toEqual(["blocked", "infra"]);
    expect(existsSync(reviewWorktree(repo))).toBe(false);
    expect(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
    // The hook passes now: the retry creates the worktree again, its hook runs, the wave merges.
    writeFileSync(mark, "");
    await callAction("waves.retry", { id: WAVE });
    await until(async () => (await getWave()).stage === "merged");
    await until(async () => (await liveWaveRunners(WAVE)).length === 0);
    expect(git(repo, "log", "--format=%s", "main")).toBe("feat: add c\nfeat: add b\ninit");
  }, 30_000);

  test("an invalid factory.yaml blocks the wave as infra, naming the file; nothing is reviewed or merged", async () => {
    const repo = await waveRepo("gates: []\ntask_gate: []\n");
    await runWave(WAVE);
    const wave = await getWave();
    expect([wave.stage, wave.reason, wave.reviews]).toEqual(["blocked", "infra", []]);
    const timeline = (await callAction("waves.timeline", { id: WAVE })) as { events: { kind: string; detail?: string }[] };
    expect(timeline.events.at(-1)?.detail).toContain("factory.yaml: unknown key task_gate");
    expect(git(repo, "log", "--format=%s", "main")).toBe("init");
    expect(existsSync(reviewWorktree(repo))).toBe(false);
  });

  test("a review worktree created again after the review ran the after_create hooks again", async () => {
    const count = join(caseDir, "hook-count");
    await waveRepo(`hooks:\n  after_create:\n    - ["sh", "-c", "echo x >> ${count}"]\ngates: []\n`, "done", { merge: "review" });
    await runWave(WAVE);
    expect((await getWave()).stage).toBe("waiting_approve");
    expect(readFileSync(count, "utf8")).toBe("x\n");
    await callAction("waves.approve", { id: WAVE });
    await until(async () => (await getWave()).stage === "merged");
    await until(async () => (await liveWaveRunners(WAVE)).length === 0);
    expect(readFileSync(count, "utf8")).toBe("x\nx\n");
  }, 30_000);

  test("a dirty review worktree blocks it with reason dirty; the file and the worktree stay", async () => {
    const repo = await waveRepo('hooks:\n  after_create:\n    - ["sh", "-c", "echo x > stray.txt"]\ngates: []\n');
    await runWave(WAVE);
    expect([(await getWave()).stage, (await getWave()).reason]).toEqual(["blocked", "dirty"]);
    expect(readFileSync(join(reviewWorktree(repo), "stray.txt"), "utf8")).toBe("x\n");
    expect(git(repo, "log", "--format=%s", "main")).toBe("init");
  });

  test("a gate that rewrites a tracked file blocks it as dirty: nothing reviewed, the target unmoved", async () => {
    const repo = await waveRepo('gates:\n  - ["sh", "-c", "echo changed > b.txt"]\n');
    await runWave(WAVE);
    expect([(await getWave()).stage, (await getWave()).reason, (await getWave()).reviews]).toEqual(["blocked", "dirty", []]);
    expect(git(repo, "log", "--format=%s", "main")).toBe("init");
  });

  test("all tasks cancelled: the wave ends cancelled without a review", async () => {
    await waveRepo(undefined, "cancelled");
    await runWave(WAVE);
    expect([(await getWave()).stage, (await getWave()).reviews]).toEqual(["cancelled", []]);
  });

  test("a poke during a run does not start a second runner; the running one is the wave's view", async () => {
    // A task still runs: the runner waits for it and lives.
    await waveRepo(undefined, "running");
    expect(await pokeWave(WAVE)).toBe(true);
    await until(async () => (await liveWaveRunners(WAVE)).length === 1);
    expect(await pokeWave(WAVE)).toBe(false);
    expect(await pokeWave(WAVE)).toBe(false);
    await Bun.sleep(500);
    expect(await liveWaveRunners(WAVE)).toHaveLength(1);
    expect([(await getWave()).running, (await getWave()).interrupted]).toEqual([true, false]);
    // The runner saw the pokes: their marker is gone.
    await until(() => !existsSync(wavePokePath(WAVE)));
  });

  test("a runner started by hand while another holds the wave ends at once", async () => {
    await waveRepo(undefined, "running");
    await lockWave(WAVE);
    try {
      const child = Bun.spawn(["bun", join(import.meta.dirname, "wave-runner.ts"), WAVE], { env: process.env, stderr: "pipe" });
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stderr).text()).toContain("another runner holds the wave");
    } finally {
      await unlockWave(WAVE);
    }
  });
});

describe("a wave never waits silently (invariant 8)", () => {
  test("tasks that can never start: the runner rests, the wave builds with attention and says why once; waves.add drops them", async () => {
    await waveRepo();
    // a was cancelled after b finished; c waits for a and can never start.
    setState("a", "cancelled");
    await appendWaveEvent(WAVE, { kind: "tasks", tasks: [{ key: "c", title: "Add d", request: "add d", after: ["a"] }] });
    expect(await runWave(WAVE)).toBe(0);
    const wave = await getWave();
    expect([wave.stage, wave.running, wave.interrupted, wave.tasks.map((task) => task.state)]).toEqual(["building", false, false, ["cancelled", "done", "pending"]]);
    const said = (await timeline()).filter((event) => event.kind === "stage");
    expect(said).toEqual([{ at: expect.any(String), kind: "stage", stage: "building", reason: null, detail: expect.stringContaining("task c can never start") }]);
    const waited = await waitWave(10_000);
    expect([waited.timedOut, waited.attention, waited.waves[0].stage]).toEqual([false, [WAVE], "building"]);
    // A second look says nothing new.
    await runWave(WAVE);
    expect((await timeline()).filter((event) => event.kind === "stage")).toHaveLength(1);
    // The supervisor adds a task: c leaves the wave (cancelled), the new one is pending.
    const added = await holding(async () => ((await callAction("waves.add", { id: WAVE, tasks: [{ key: "c2", title: "Add d again", request: "add d", after: ["b"] }] })) as { wave: WaveView }).wave);
    expect([added.stage, added.tasks.map((task) => [task.key, task.state]), added.counts]).toEqual([
      "building",
      [["a", "cancelled"], ["b", "done"], ["c", "cancelled"], ["c2", "pending"]],
      { total: 2, done: 1 },
    ]);
    expect((await timeline()).at(-1)).toMatchObject({ kind: "tasks", dropped: ["c"] });
  }, 30_000);

  test("a task that fails to launch blocks the wave (infra, the error in its stage event); waves.retry builds again", async () => {
    const repo = await waveRepo();
    await appendWaveEvent(WAVE, { kind: "tasks", tasks: [{ key: "c", title: "Add d", request: "add d", after: ["a"] }] });
    // The launch refuses before it creates anything: the wave's branch is gone.
    const tip = git(repo, "rev-parse", BRANCH);
    git(repo, "branch", "-D", BRANCH);
    expect(await runWave(WAVE)).toBe(0);
    const wave = await getWave();
    expect([wave.stage, wave.reason, wave.running, wave.tasks.map((task) => task.state)]).toEqual(["blocked", "infra", false, ["done", "done", "pending"]]);
    expect((await timeline()).at(-1)).toMatchObject({ kind: "stage", stage: "blocked", reason: "infra", detail: expect.stringContaining(`starting its task c failed: ${repo}: branch ${BRANCH} does not exist locally`) });
    const waited = await waitWave(10_000);
    expect([waited.timedOut, waited.attention]).toEqual([false, [WAVE]]);
    // Fixed: a retry with a task not started builds again (not a review).
    git(repo, "branch", BRANCH, tip);
    const retried = await holding(async () => ((await callAction("waves.retry", { id: WAVE })) as { wave: WaveView }).wave);
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
      sessionId: `session-${RUN}-x`,
      sessionDir: join(caseDir, "sessions"),
      createdAt: "2026-01-01T00:00:03.000Z",
      tag: "factory/w1",
      plan: null,
      wave: WAVE,
      origin: null,
    };
    await writeTask(record);
    setState("x", "done");
    process.env.FAKE_REVIEW_SLEEP = "120000";
    await appendWaveEvent(WAVE, { kind: "stage", stage: "reviewing", reason: null });
    const run = runWave(WAVE);
    await until(() => existsSync(promptLog));
    // The next reviewer answers at once.
    delete process.env.FAKE_REVIEW_SLEEP;
    const added = Date.now();
    await callAction("waves.add", { id: WAVE, tasks: [{ key: "x", title: "Fix b", request: "fix b", after: ["a"] }] });
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
    await appendWaveEvent(WAVE, { kind: "stage", stage: "reviewing", reason: null });
    await appendWaveEvent(WAVE, { kind: "review", round: 1, sessionId: null, model: null, verdict: "approved", status: "ok", findings: [], usage: null, wallMs: 1 });
    await appendWaveEvent(WAVE, { kind: "stage", stage: "merging", reason: null });
    expect(await runWave(WAVE)).toBe(0);
    expect((await getWave()).stage).toBe("merged");
    expect(git(repo, "log", "--format=%s", "main")).toBe("feat: add c\nfeat: add b\ninit");
    expect((await timeline()).slice(-2).map((event) => event.stage ?? event.kind)).toEqual(["merge", "merged"]);
    expect(existsSync(reviewWorktree(repo))).toBe(false);
  });

  test("reviewing with a leftover review worktree: its leftovers block it as dirty, named; clean, it is reused", async () => {
    const repo = await waveRepo();
    // A runner killed outright during a gate left the worktree and the gate's output.
    git(repo, "worktree", "add", "--quiet", reviewWorktree(repo), BRANCH);
    writeFileSync(join(reviewWorktree(repo), "gate-output.log"), "x\n");
    await appendWaveEvent(WAVE, { kind: "stage", stage: "reviewing", reason: null });
    await runWave(WAVE);
    expect([(await getWave()).stage, (await getWave()).reason]).toEqual(["blocked", "dirty"]);
    const detail = (await timeline()).at(-1)?.detail ?? "";
    // No path in the event (invariant 10): the worktree is named by its wave; its path is in the runner's log only.
    expect(detail).not.toContain(reviewWorktree(repo));
    expect(detail).not.toContain(caseDir);
    expect(detail).toContain(`the review worktree of wave ${WAVE.slice(0, 8)}`);
    expect(detail).toContain("gate-output.log");
    expect(existsSync(join(reviewWorktree(repo), "gate-output.log"))).toBe(true);
    rmSync(join(reviewWorktree(repo), "gate-output.log"));
    expect((await holding(async () => ((await callAction("waves.retry", { id: WAVE })) as { wave: WaveView }).wave)).stage).toBe("reviewing");
    await runWave(WAVE);
    expect((await getWave()).stage).toBe("merged");
    expect(existsSync(reviewWorktree(repo))).toBe(false);
  });
});

/** The log of a wave whose review approved it: the runner resumes at the merge. */
async function approvedForMerge(): Promise<void> {
  await appendWaveEvent(WAVE, { kind: "stage", stage: "reviewing", reason: null });
  await appendWaveEvent(WAVE, { kind: "review", round: 1, sessionId: null, model: null, verdict: "approved", status: "ok", findings: [], usage: null, wallMs: 1 });
  await appendWaveEvent(WAVE, { kind: "stage", stage: "merging", reason: null });
}

describe("the merge takes the review worktree as it is (invariant 2)", () => {
  test("a worktree that holds anything but its commit before the merge blocks it as dirty, named; the file stays, the target unmoved", async () => {
    const repo = await waveRepo();
    git(repo, "worktree", "add", "--quiet", reviewWorktree(repo), BRANCH);
    writeFileSync(join(reviewWorktree(repo), "notes.txt"), "mine\n");
    await approvedForMerge();
    await runWave(WAVE);
    expect([(await getWave()).stage, (await getWave()).reason, (await getWave()).merge]).toEqual(["blocked", "dirty", null]);
    expect((await timeline()).at(-1)?.detail).toContain("notes.txt");
    expect(readFileSync(join(reviewWorktree(repo), "notes.txt"), "utf8")).toBe("mine\n");
    expect(git(repo, "log", "--format=%s", "main")).toBe("init");
  });

  test("a merge gate that rewrites a tracked file blocks it as dirty: the gated tree is not the one that would merge", async () => {
    const repo = await waveRepo('gates: []\nmerge_gates:\n  - ["sh", "-c", "echo changed > b.txt"]\n');
    await approvedForMerge();
    await runWave(WAVE);
    const wave = await getWave();
    expect([wave.stage, wave.reason, wave.merge, wave.gates.map((gate) => [gate.phase, gate.passed])]).toEqual(["blocked", "dirty", null, [["merge", true]]]);
    expect(git(repo, "log", "--format=%s", "main")).toBe("init");
    expect(git(repo, "rev-parse", `refs/heads/${BRANCH}`)).not.toBe(git(repo, "rev-parse", "main"));
  });

  test("what a merge gate leaves untracked is removed: the target gets the wave's commits only, the worktree goes", async () => {
    const repo = await waveRepo('gates: []\nmerge_gates:\n  - ["sh", "-c", "echo x > out.log"]\n');
    await approvedForMerge();
    await runWave(WAVE);
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
    await appendWaveEvent(WAVE, { kind: "stage", stage: "reviewing", reason: null });
    expect(await pokeWave(WAVE)).toBe(true);
    await until(() => existsSync(promptLog));
    const [pid] = await liveWaveRunners(WAVE);
    process.kill(pid, "SIGTERM");
    await until(async () => (await liveWaveRunners(WAVE)).length === 0);
    const wave = await getWave();
    expect([wave.stage, wave.reason, wave.interrupted, wave.reviews, wave.actions.includes("waves.retry")]).toEqual(["reviewing", null, true, [], true]);
    expect((await timeline()).map((event) => event.stage ?? event.kind)).toEqual(["tasks", "task", "task", "reviewing", "gate"]);
    expect(existsSync(reviewWorktree(repo))).toBe(true);
    delete process.env.FAKE_REVIEW_SLEEP;
    expect(await runWave(WAVE)).toBe(0);
    expect((await getWave()).stage).toBe("merged");
    expect(git(repo, "log", "--format=%s", "main")).toBe("feat: add c\nfeat: add b\ninit");
  }, 30_000);
});

describe("the wave on its forge (setting remote)", () => {
  const forgeLog = () => join(caseDir, "forge.log");
  const forgeBin = () => join(caseDir, "forge-bin");
  /** The fake `gh`/`glab`: each call's argv, as `[name, ...args]` JSON lines; `create` prints the request's URL. */
  const FAKE_FORGE = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
const name = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_FORGE_LOG, JSON.stringify([name, ...args]) + "\\n");
if (args[1] === "create") console.log(name === "gh" ? "https://github.com/acme/app/pull/7" : "Creating merge request\\nhttps://gitlab.com/acme/app/-/merge_requests/7");
`;

  beforeEach(() => {
    mkdirSync(forgeBin());
    for (const name of ["gh", "glab"]) {
      writeFileSync(join(forgeBin(), name), FAKE_FORGE);
      chmodSync(join(forgeBin(), name), 0o755);
    }
    // No real gh or glab is reachable: a directory holding one is left out of PATH (bun's own is kept).
    const system = (savedEnv.PATH ?? "").split(":").filter((dir) => dir !== "" && !existsSync(join(dir, "gh")) && !existsSync(join(dir, "glab")));
    process.env.PATH = [forgeBin(), fakeBin, dirname(process.execPath), ...system].join(":");
    process.env.FAKE_FORGE_LOG = forgeLog();
  });

  const calls = (): string[][] => (existsSync(forgeLog()) ? readFileSync(forgeLog(), "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]) : []);
  /** A bare repo as `origin`, reached through `insteadOf` from `url`, so the forge is the URL's. Returns its path. */
  function origin(repo: string, url = "https://github.com/acme/app.git"): string {
    const bare = join(caseDir, "origin.git");
    git(caseDir, "init", "--quiet", "--bare", bare);
    git(repo, "remote", "add", "origin", url);
    git(repo, "config", `url.${bare}.insteadOf`, url);
    return bare;
  }
  const refs = (bare: string) => git(bare, "for-each-ref", "--format=%(refname) %(objectname)");
  const remoteEvents = async () => (await timeline()).filter((event) => event.kind === "remote") as unknown as Record<string, unknown>[];

  test("off: no push, no forge call, no remote event; the wave merges", async () => {
    const repo = await waveRepo();
    const bare = origin(repo);
    expect(await runWave(WAVE)).toBe(0);
    const wave = await getWave();
    expect([wave.stage, wave.remote]).toEqual(["merged", null]);
    expect(refs(bare)).toBe("");
    expect(calls()).toEqual([]);
    expect(await remoteEvents()).toEqual([]);
  });

  test("on (GitHub): the branch pushed, the request opened once, a comment per verdict, the target pushed only after the merge", async () => {
    process.env.FAKE_VERDICT = "reject";
    const repo = await waveRepo(undefined, "done", { remote: true });
    const bare = origin(repo);
    await runWave(WAVE);
    const rejected = await getWave();
    expect(rejected.stage).toBe("rejected");
    const head = git(repo, "rev-parse", BRANCH);
    expect(rejected.remote).toEqual({ number: 7, url: "https://github.com/acme/app/pull/7", pushed: head, error: null });
    expect(git(bare, "rev-parse", BRANCH)).toBe(head);
    // The target is not the review's to publish: only the merge pushes it.
    expect(refs(bare)).not.toContain("refs/heads/main ");
    const [create, comment] = calls();
    expect(create.slice(0, 7)).toEqual(["gh", "pr", "create", "--base", "main", "--head", BRANCH]);
    expect(create).toContain("Wave one");
    expect(comment.slice(0, 4)).toEqual(["gh", "pr", "comment", "7"]);
    expect(comment[5]).toContain("round 1: rejected");
    expect(comment[5]).toContain("`b.txt:1`: b is wrong");
    expect((await timeline()).map((event) => event.stage ?? event.kind)).toEqual(["tasks", "task", "task", "reviewing", "remote", "remote", "gate", "review", "rejected", "remote"]);

    // A second review (the supervisor's fixes are in): the request is reused, its verdict commented, the merge pushed.
    delete process.env.FAKE_VERDICT;
    await appendWaveEvent(WAVE, { kind: "stage", stage: "reviewing", reason: null });
    expect(await runWave(WAVE)).toBe(0);
    const merged = await getWave();
    expect(merged.stage).toBe("merged");
    expect(calls().map((call) => call.slice(0, 3).join(" "))).toEqual(["gh pr create", "gh pr comment", "gh pr comment"]);
    expect(calls()[2][5]).toContain("round 2: approved");
    const main = git(repo, "rev-parse", "main");
    expect(merged.remote).toEqual({ number: 7, url: "https://github.com/acme/app/pull/7", pushed: main, error: null });
    expect(git(bare, "rev-parse", "main")).toBe(main);
    expect(git(bare, "rev-parse", BRANCH)).toBe(main);
    // The pending push is in the log before the resting stage, the push's own event after it.
    const kinds = (await timeline()).map((event) => event.stage ?? event.kind);
    expect(kinds.slice(-4)).toEqual(["merge", "remote", "merged", "remote"]);
    const [pending, done] = (await remoteEvents()).slice(-2);
    expect(pending.error).toBe(MERGE_PUSH_PENDING);
    expect(done.error).toBeNull();
  });

  test("a runner that dies between the merge and its push leaves the log saying the push is pending", async () => {
    const repo = await waveRepo(undefined, "done", { remote: true });
    origin(repo);
    await runWave(WAVE);
    // What the log held before the push: everything up to the merged stage.
    const { declaration, events } = await readWave(WAVE);
    const before = events.slice(0, events.findIndex((event) => event.kind === "stage" && event.stage === "merged") + 1);
    const fold = foldWave(declaration, before);
    expect(fold.stage).toBe("merged");
    expect(fold.remote?.error).toBe(MERGE_PUSH_PENDING);
  });

  test("on (GitLab): glab opens the merge request and notes the verdict", async () => {
    const repo = await waveRepo(undefined, "done", { remote: true });
    origin(repo, "git@gitlab.example.com:acme/app.git");
    await runWave(WAVE);
    const wave = await getWave();
    expect([wave.stage, wave.remote?.number, wave.remote?.url]).toEqual(["merged", 7, "https://gitlab.com/acme/app/-/merge_requests/7"]);
    const [create, note] = calls();
    expect(create.slice(0, 7)).toEqual(["glab", "mr", "create", "--source-branch", BRANCH, "--target-branch", "main"]);
    expect(note.slice(0, 4)).toEqual(["glab", "mr", "note", "7"]);
  });

  test("a refused push is recorded and the wave still merges; no request without the branch", async () => {
    const repo = await waveRepo(undefined, "done", { remote: true });
    const bare = origin(repo);
    writeFileSync(join(bare, "hooks", "pre-receive"), "#!/bin/sh\necho refused by policy >&2\nexit 1\n");
    chmodSync(join(bare, "hooks", "pre-receive"), 0o755);
    expect(await runWave(WAVE)).toBe(0);
    const wave = await getWave();
    expect(wave.stage).toBe("merged");
    expect(git(repo, "log", "--format=%s", "main")).toBe("feat: add c\nfeat: add b\ninit");
    expect(wave.remote?.error).toContain("git push exited 1");
    expect(wave.remote?.error).toContain("refused by policy");
    expect(calls()).toEqual([]);
    expect(refs(bare)).toBe("");
  });

  test("a missing CLI is recorded and the wave still merges; the target is pushed all the same", async () => {
    rmSync(join(forgeBin(), "gh"));
    const repo = await waveRepo(undefined, "done", { remote: true });
    const bare = origin(repo);
    expect(await runWave(WAVE)).toBe(0);
    const wave = await getWave();
    expect(wave.stage).toBe("merged");
    const events = await remoteEvents();
    expect(events.some((event) => typeof event.error === "string" && event.error.startsWith("gh pr could not run"))).toBe(true);
    expect([wave.remote?.number, wave.remote?.url, wave.remote?.pushed]).toEqual([null, null, git(repo, "rev-parse", "main")]);
    expect(git(bare, "rev-parse", "main")).toBe(git(repo, "rev-parse", "main"));
  });

  test("an origin that is no GitHub or GitLab: pushed, the request recorded unsupported", async () => {
    const repo = await waveRepo(undefined, "done", { remote: true });
    const bare = origin(repo, "https://git.example.com/acme/app.git");
    await runWave(WAVE);
    expect((await getWave()).stage).toBe("merged");
    expect((await remoteEvents()).some((event) => typeof event.error === "string" && event.error.startsWith("unsupported:"))).toBe(true);
    expect(calls()).toEqual([]);
    expect(git(bare, "rev-parse", "main")).toBe(git(repo, "rev-parse", "main"));
  });
});

describe("pathFree", () => {
  test("a single-segment absolute path goes too", () => {
    const declaration = { id: "20000000-aaaa-4000-8000-000000000003", repo: "/srv/repo" } as Parameters<typeof pathFree>[0];
    expect(pathFree(declaration, "cannot open /workspace")).toBe("cannot open <path>");
    expect(pathFree(declaration, "cannot open /workspace/x/y.ts")).toBe("cannot open <path>");
  });
});
