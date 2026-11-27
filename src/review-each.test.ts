/**
 * Review per task over real git repos in a temp dir: the wave's tasks rest `reviewing` in worktrees of their own, the
 * reviewer is a fake `pi` on PATH that answers with `$FAKE_VERDICT_<key>`. The hand-over to the
 * task is replaced by one that plays the task: it records the command and moves the task's state on.
 */
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDiffText } from "./review.ts";
import { writeTask, type TaskRecord } from "./tasks.ts";
import { stopWaveRunners, waveReviewsDir } from "./wave-poke.ts";
import { reviewEachDeps, runWave } from "./wave-runner.ts";
import { appendWaveEvent, createWave, foldWave, listWaves, readWave } from "./waves.ts";
import { NO_USAGE } from "./util.ts";

const savedEnv = { ...process.env };
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "factory-review-each-test-")));
const fakeBin = join(scratch, "bin");
const callLog = join(scratch, "reviewer-calls.jsonl");

/** The fake reviewer: makes its session file when missing; notes in `$FAKE_CALLS` its argv, the diff, start and end. */
mkdirSync(fakeBin);
writeFileSync(
  join(fakeBin, "pi"),
  `#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const dir = args[args.indexOf("--session-dir") + 1];
const given = args.includes("--session-id") ? args[args.indexOf("--session-id") + 1] : null;
const id = given ?? "11111111-2222-4333-8444-555555555555";
mkdirSync(dir, { recursive: true });
const existing = readdirSync(dir).find((name) => name.endsWith("_" + id + ".jsonl"));
const file = join(dir, existing ?? "2026-01-01T00-00-00-000Z_" + id + ".jsonl");
if (!existsSync(file)) writeFileSync(file, JSON.stringify({ type: "session", version: 3, id, cwd: process.cwd() }) + "\\n");
const start = Date.now();
if (process.env.FAKE_REVIEW_SLEEP) await Bun.sleep(Number(process.env.FAKE_REVIEW_SLEEP));
const diffFile = process.env.FACTORY_REVIEW_DIFF;
const prompt = args.at(-1);
const key = given ? (/Review task (\\S+)/.exec(prompt) ?? [])[1] : "wave";
const verdict = process.env["FAKE_VERDICT_" + key] ?? "approve";
const findings = verdict === "reject" ? [{ file: "x.txt", line: 1, severity: "major", text: "x is wrong" }, { file: "x.txt", line: null, severity: "minor", text: "style" }] : [];
appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ key, args, diff: diffFile ? readFileSync(diffFile, "utf8") : null, start, end: Date.now() }) + "\\n");
const emit = (record) => console.log(JSON.stringify(record));
emit({ type: "session", id });
emit({ type: "tool_execution_end", toolName: "submit_verdict", isError: false, result: { details: { findings } } });
emit({ type: "message_end", message: { role: "assistant", usage: { input: 10, output: 2, cacheRead: 90, cacheWrite: 3, cost: { total: 0.25 } } } });
`,
);
chmodSync(join(fakeBin, "pi"), 0o755);

let caseDir: string;
let caseCount = 0;
const RUN = randomBytes(2).toString("hex");
let WAVE: string;
const BRANCH = "main-factory-each";

beforeEach(() => {
  caseDir = join(scratch, `case-${++caseCount}`);
  mkdirSync(caseDir);
  WAVE = `31000000-${RUN}-4000-8000-00000000000${caseCount}`;
  Object.assign(process.env, {
    PATH: `${fakeBin}:${savedEnv.PATH ?? ""}`,
    HOME: scratch,
    PI_CODING_AGENT_DIR: join(caseDir, "agent"),
    FAKE_CALLS: callLog,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "test",
    GIT_COMMITTER_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_EMAIL: "test@example.com",
  });
  rmSync(callLog, { force: true });
  reviewEachDeps.delivered.clear();
});

afterEach(async () => {
  delete reviewEachDeps.deliver;
  for (const wave of await listWaves()) await stopWaveRunners(wave.declaration.id);
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

type Call = { key: string; args: string[]; diff: string | null; start: number; end: number };
const calls = (): Call[] => (existsSync(callLog) ? readFileSync(callLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Call) : []);
const taskCalls = () => calls().filter((call) => call.key !== "wave");

/** The task `key`'s session file (one per task). */
const sessionPath = (key: string) => join(caseDir, "sessions", `2026-01-01T00-00-00-000Z_session-${RUN}-${caseCount}-${key}.jsonl`);
/** Appends a `factory-state` entry to the task's session. */
const setState = (key: string, state: string, round: number) => appendFileSync(sessionPath(key), `${JSON.stringify({ type: "custom", customType: "factory-state", data: { state, round, reason: "r" } })}\n`);

/**
 * A repo on `main` with a wave whose tasks `keys` each have a worktree off the
 * wave's branch holding an uncommitted file `<key>.txt`, and a session resting in `state` (round 1).
 */
async function eachWave(keys: string[], state = "reviewing"): Promise<string> {
  const repo = join(caseDir, "repo");
  mkdirSync(repo);
  git(repo, "init", "--quiet", "-b", "main");
  writeFileSync(join(repo, "factory.yaml"), 'gates:\n  - ["true"]\n');
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "init");
  const base = git(repo, "rev-parse", "main");
  git(repo, "branch", BRANCH);
  await createWave({ id: WAVE, repo, tag: "factory/each", plan: null, title: "Each wave", request: "Check it.", branch: BRANCH, target: "main", base, origin: null, createdAt: "2026-01-01T00:00:00.000Z", overrides: {} });
  await appendWaveEvent(WAVE, { kind: "tasks", tasks: keys.map((key) => ({ key, title: `Add ${key}`, request: `add ${key}.txt`, after: [], id: crypto.randomUUID() })) });
  mkdirSync(join(caseDir, "sessions"), { recursive: true });
  for (const [index, key] of keys.entries()) {
    const worktree = join(caseDir, `task-${key}`);
    git(repo, "worktree", "add", "--quiet", "-b", `task-${key}`, worktree, BRANCH);
    writeFileSync(join(worktree, `${key}.txt`), `${key} one\n`);
    const record: TaskRecord = {
      id: `41000000-${RUN}-4000-8000-0000000${caseCount}000${index}`,
      repo,
      worktree,
      branch: `task-${key}`,
      title: `Add ${key}`,
      sessionId: `session-${RUN}-${caseCount}-${key}`,
      sessionDir: join(caseDir, "sessions"),
      createdAt: `2026-01-01T00:00:0${index + 1}.000Z`,
      tag: "factory/each",
      plan: null,
      wave: WAVE,
      origin: null,
    };
    await writeTask(record);
    writeFileSync(sessionPath(key), "");
    setState(key, state, 1);
    await appendWaveEvent(WAVE, { kind: "task", key, taskId: record.id, sessionId: record.sessionId });
  }
  return repo;
}

/** The commands handed to the tasks, by key; `act` plays the task on each one. */
function playTasks(act: (key: string, command: { round: number; review: { approved: boolean; findings: { severity: string; text: string }[] } }) => void) {
  const handed: { key: string; text: string }[] = [];
  reviewEachDeps.deliver = async (record, text) => {
    const key = record.branch.slice("task-".length);
    handed.push({ key, text });
    act(key, JSON.parse(text.slice("/factory reviewed ".length)));
  };
  return handed;
}

const taskReviews = async () => foldWave((await readWave(WAVE)).declaration, (await readWave(WAVE)).events).taskReviews ?? [];

describe("review per task", () => {
  test("approve: the verdict goes to the task, which merges; the reviewer gets the diff only through read_diff", async () => {
    await eachWave(["a"]);
    const handed = playTasks((key) => setState(key, "done", 1));
    expect(await runWave(WAVE)).toBe(0);
    expect(handed.map((hand) => hand.key)).toEqual(["a"]);
    const [call] = taskCalls();
    expect(readDiffText(call!.diff!)).toContain("+a one");
    expect(call!.args.at(-1)).not.toContain("a one");
    expect((await taskReviews()).map((review) => [review.key, review.round, review.verdict])).toEqual([["a", 1, "approved"]]);
    // Every task done: the wave then reviews and merges as before.
    expect(foldWave((await readWave(WAVE)).declaration, (await readWave(WAVE)).events).stage).toBe("merged");
  });

  test("a major finding goes to the task's next round; its second review reads only what changed since", async () => {
    await eachWave(["a"]);
    process.env.FAKE_VERDICT_a = "reject";
    const handed = playTasks((key, command) => {
      if (!command.review.approved) {
        // The coder's next round: it changes the file and rests reviewing again.
        writeFileSync(join(caseDir, `task-${key}`, `${key}.txt`), `${key} two\n`);
        setState(key, "running", 2);
        process.env.FAKE_VERDICT_a = "approve";
        setState(key, "reviewing", 2);
      } else setState(key, "done", 2);
    });
    expect(await runWave(WAVE)).toBe(0);
    expect(handed).toHaveLength(2);
    const first = JSON.parse(handed[0]!.text.slice("/factory reviewed ".length));
    expect(first.round).toBe(1);
    expect(first.review.findings.map((finding: { severity: string }) => finding.severity)).toEqual(["major", "minor"]);
    const [, two] = taskCalls();
    expect(readDiffText(two!.diff!)).toContain("-a one\n+a two");
    expect((await taskReviews()).map((review) => [review.round, review.verdict])).toEqual([
      [1, "rejected"],
      [2, "approved"],
    ]);
  });

  test("two tasks done at once are reviewed one after another", async () => {
    await eachWave(["a", "b"]);
    process.env.FAKE_REVIEW_SLEEP = "300";
    playTasks((key) => setState(key, "done", 1));
    expect(await runWave(WAVE)).toBe(0);
    const [a, b] = taskCalls();
    expect([a!.key, b!.key]).toEqual(["a", "b"]);
    expect(b!.start).toBeGreaterThanOrEqual(a!.end);
  });

  test("a restart mid-review reviews that round again on the resumed session; a recorded verdict not yet applied is only handed over", async () => {
    await eachWave(["a", "b"]);
    // A runner died during a's review: its session holds the read diff, no event says so.
    const dir = waveReviewsDir(WAVE);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `2026-01-01T00-00-00-000Z_${WAVE}.jsonl`);
    const lines = [
      { type: "session", version: 3, id: WAVE, cwd: dir },
      { type: "message", id: "u1", parentId: null, message: { role: "user", content: [{ type: "text", text: "Review task a" }] } },
      { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read_diff", arguments: {} }] } },
      { type: "message", id: "r1", parentId: "a1", message: { role: "toolResult", toolCallId: "c1", toolName: "read_diff", content: [{ type: "text", text: "EARLIER-DIFF" }] } },
    ];
    writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    // b's verdict was recorded, its hand-over never happened.
    const b = (await readWave(WAVE)).events.find((event) => event.kind === "task" && event.key === "b") as { taskId: string };
    await appendWaveEvent(WAVE, { kind: "task_review", key: "b", taskId: b.taskId, round: 1, tree: "t", base: "b", contracts: null, sessionId: WAVE, model: null, verdict: "approved", status: "ok", findings: [], usage: NO_USAGE, wallMs: 1 });
    const handed = playTasks((key) => setState(key, "done", 1));
    expect(await runWave(WAVE)).toBe(0);
    expect(taskCalls().map((call) => call.key)).toEqual(["a"]);
    expect(handed.map((hand) => hand.key).sort()).toEqual(["a", "b"]);
  });
});

describe("read_diff", () => {
  test("paths keep only those files or directories, the list of every changed path first", () => {
    const patch = "diff --git a/src/x.ts b/src/x.ts\n+x\ndiff --git a/y.ts b/y.ts\n+y\n";
    const json = JSON.stringify({ paths: ["src/x.ts", "y.ts"], patch });
    expect(readDiffText(json)).toContain("+x\ndiff --git a/y.ts");
    const only = readDiffText(json, ["src/"]);
    expect(only).toContain("+x");
    expect(only).not.toContain("+y");
    expect(readDiffText(json, ["z.ts"])).toContain("None of z.ts changed");
  });
});
