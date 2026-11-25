/**
 * The wave runner over real git repos in a temp dir: the wave's tasks are records whose sessions say `done`, their
 * work commits on the wave's branch, and the reviewer is a fake `pi` on PATH (`--mode json`, a `submit_verdict` call
 * whose findings `$FAKE_VERDICT` chooses). `runWave` runs in this process; the poke tests start real detached runners.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callAction } from "./core.ts";
import { worktreePath } from "./launch.ts";
import { writeTask, type TaskRecord } from "./tasks.ts";
import { liveWaveRunners, pokeWave, stopWaveRunners, wavePokePath } from "./wave-poke.ts";
import { runWave } from "./wave-runner.ts";
import { appendWaveEvent, createWave, listWaves, lockWave, unlockWave, type WaveView } from "./waves.ts";

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
import { join } from "node:path";
const args = process.argv.slice(2);
if (!args.includes("json")) process.exit(3);
const dir = args[args.indexOf("--session-dir") + 1];
const id = "11111111-2222-4333-8444-555555555555";
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "2026-01-01T00-00-00-000Z_" + id + ".jsonl"), JSON.stringify({ type: "session", id }) + "\\n");
writeFileSync(process.env.FAKE_PROMPT_LOG, args.at(-1));
const findings = process.env.FAKE_VERDICT === "reject" ? [{ file: "b.txt", line: 1, severity: "major", text: "b is wrong" }] : [];
const emit = (record) => console.log(JSON.stringify(record));
emit({ type: "session", id });
emit({ type: "tool_execution_end", toolName: "submit_verdict", isError: false, result: { details: { findings } } });
emit({ type: "message_end", message: { role: "assistant", usage: { input: 100, output: 20, cost: { total: 0.5 } } } });
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
  delete process.env.FAKE_VERDICT;
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

const WAVE = "30000000-0000-4000-8000-000000000001";
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
      sessionId: `session-${spec.key}`,
      sessionDir: join(caseDir, "sessions"),
      createdAt: `2026-01-01T00:00:0${index + 1}.000Z`,
      tag: "factory/w1",
      plan: null,
      wave: WAVE,
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
      { at: expect.any(String), round: 1, sessionId: "11111111-2222-4333-8444-555555555555", model: null, verdict: "approved", status: "ok", findings: [], usage: { input: 100, output: 20, cost: 0.5 }, wallMs: expect.any(Number) },
    ]);
    expect(wave.gates.map((gate) => [gate.phase, gate.passed])).toEqual([["review", true]]);
    expect(wave.usage).toEqual({ input: 100, output: 20, cost: 0.5 });
    const timeline = (await callAction("waves.timeline", { id: WAVE })) as { events: { kind: string; stage?: string }[] };
    expect(timeline.events.map((event) => event.stage ?? event.kind)).toEqual(["tasks", "task", "task", "reviewing", "gate", "review", "merging", "merge", "merged"]);
    // The reviewer got the wave's whole diff and its request verbatim.
    const prompt = readFileSync(promptLog, "utf8");
    expect(prompt).toContain(`Review the wave "Wave one": the branch ${BRANCH}, rebased onto main, merges into it.`);
    expect(prompt.endsWith("## Instructions from the supervisor\n\nCheck b and c.\nKeep it small.\n")).toBe(true);
    expect(existsSync(reviewWorktree(repo))).toBe(false);
  });

  test("merge review: an approved wave waits for approve, its worktree removed", async () => {
    const repo = await waveRepo(undefined, "done", { merge: "review" });
    await runWave(WAVE);
    expect((await getWave()).stage).toBe("waiting_approve");
    expect(git(repo, "log", "--format=%s", "main")).toBe("init");
    expect(existsSync(reviewWorktree(repo))).toBe(false);
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
