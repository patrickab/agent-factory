/**
 * Review per task over real git repos in a temp dir: the wave's tasks rest `reviewing` in worktrees of their own, the
 * reviewer is the fake `pi` answering with `$FAKE_VERDICT_<key>`, and the task's Pi is the same fake playing the
 * `/factory reviewed` it is handed: approved, it merges; rejected, it changes a file and rests `reviewing` again.
 */
import { describe, expect } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callAction } from "./core.ts";
import { noted, prompts, until } from "./core-test-kit.ts";
import { reviewNext } from "./review-each.ts";
import { readDiffText } from "./review.ts";
import { lockTask, taskLockPath, tasksById } from "./tasks.ts";
import { unlockFile } from "./lock.ts";
import { waveReviewsDir } from "./wave-poke.ts";
import { reviewEachDeps, runWave } from "./wave-runner.ts";
import { caseDir, eachWave, sessionPath, useWaveFixture, WAVE } from "./wave-test-kit.ts";
import { appendWaveEvent, readWave } from "./waves.ts";
import { NO_USAGE } from "./util.ts";

const test = useWaveFixture();

type Call = { key: string; prompt: string; tools: string; diff: string | null; base: string; start: number; end: number };
const taskCalls = () => noted<Call>("reviewed").filter((call) => call.key !== "wave");
/** The verdicts handed to the tasks, in order. */
const handed = () => prompts().map((prompt) => JSON.parse(prompt.slice("/factory reviewed ".length)) as { round: number; review: { approved: boolean; findings: { severity: string }[] } });
const taskReviews = async () => (await readWave(WAVE())).fold.taskReviews;

describe("review per task", () => {
  test("approve: the verdict goes to the task, which merges; the reviewer gets the diff only through read_diff", async () => {
    await eachWave(["a"]);
    expect(await runWave(WAVE())).toBe(0);
    expect(handed().map((command) => command.review.approved)).toEqual([true]);
    const [call] = taskCalls();
    expect(readDiffText(call!.diff!)).toContain("+a one");
    expect(call!.prompt).not.toContain("a one");
    // The reviewer judges with a shell, it never edits; the task's base is in its environment.
    expect(call!.tools.split(",").filter((tool) => ["write", "edit", "bash"].includes(tool))).toEqual(["bash"]);
    expect((await taskReviews()).map((review) => [review.key, review.round, review.verdict, review.base])).toEqual([["a", 1, "approved", call!.base]]);
    // Every task done: the wave then reviews and merges as before.
    expect((await readWave(WAVE())).fold.stage).toBe("merged");
  });

  test("the supervisor's messages to the task are in its review prompt", async () => {
    await eachWave(["a"]);
    appendFileSync(sessionPath("a"), `${JSON.stringify({ type: "message", message: { role: "user", content: "add a.txt" } })}\n${JSON.stringify({ type: "message", message: { role: "user", content: "also name it loudly" } })}\n`);
    expect(await runWave(WAVE())).toBe(0);
    expect(taskCalls()[0]!.prompt).toContain("also name it loudly");
    expect(taskCalls()[0]!.prompt).not.toContain("### Message 2");
  });

  test("a major finding goes to the task's next round; its second review reads only what changed since", async () => {
    await eachWave(["a"]);
    process.env.FAKE_VERDICT_a = "reject approve";
    expect(await runWave(WAVE())).toBe(0);
    const [first, second] = handed();
    expect([first!.round, first!.review.findings.map((finding) => finding.severity), second!.review.approved]).toEqual([1, ["major", "minor"], true]);
    const two = readDiffText(taskCalls()[1]!.diff!);
    expect([two.includes("fix.txt"), two.includes("+a one")]).toEqual([true, false]);
    expect((await taskReviews()).map((review) => [review.round, review.verdict])).toEqual([
      [1, "rejected"],
      [2, "approved"],
    ]);
  });

  test("a reviewer that changes the worktree: put back with the task's own work, its verdict void, the log names the file", async () => {
    await eachWave(["a"]);
    const { worktree } = (await tasksById()).values().next().value!;
    process.env.FAKE_REVIEW_WRITE = join(worktree, "edit.txt");
    const logged: string[] = [];
    const { fold } = await readWave(WAVE());
    expect(await reviewNext(fold, new Map([["a", "reviewing"]]), { ...reviewEachDeps, env: process.env, log: (text) => logged.push(text) })).toBe(true);
    expect([existsSync(join(worktree, "edit.txt")), readFileSync(join(worktree, "a.txt"), "utf8")]).toEqual([false, "a one\n"]);
    expect((await taskReviews()).map((review) => review.verdict)).toEqual(["failed"]);
    expect(logged.some((line) => line.includes("edit.txt") && !line.includes(caseDir))).toBe(true);
  });

  test("two tasks done at once are reviewed one after another", async () => {
    await eachWave(["a", "b"]);
    process.env.FAKE_REVIEW_SLEEP = "300";
    expect(await runWave(WAVE())).toBe(0);
    const [a, b] = taskCalls();
    expect([a!.key, b!.key]).toEqual(["a", "b"]);
    expect(b!.start).toBeGreaterThanOrEqual(a!.end);
  });

  test("a restart mid-review reviews that round again on the resumed session; a recorded verdict not yet applied is only handed over", async () => {
    await eachWave(["a", "b"]);
    // A runner died during a's review: its session holds the read diff, no event says so.
    const dir = waveReviewsDir(WAVE());
    mkdirSync(dir, { recursive: true });
    const lines = [
      { type: "session", version: 3, id: WAVE(), cwd: dir },
      { type: "message", id: "u1", parentId: null, message: { role: "user", content: [{ type: "text", text: "Review task a" }] } },
      { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read_diff", arguments: {} }] } },
      { type: "message", id: "r1", parentId: "a1", message: { role: "toolResult", toolCallId: "c1", toolName: "read_diff", content: [{ type: "text", text: "EARLIER-DIFF" }] } },
    ];
    writeFileSync(join(dir, `2026-01-01T00-00-00-000Z_${WAVE()}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    // b's verdict was recorded, its hand-over never happened.
    const b = (await readWave(WAVE())).events.find((event) => event.kind === "task" && event.key === "b") as { taskId: string };
    await appendWaveEvent(WAVE(), { kind: "task_review", key: "b", taskId: b.taskId, round: 1, tree: "t", base: "b", contracts: null, sessionId: WAVE(), model: null, verdict: "approved", status: "ok", findings: [], usage: NO_USAGE, wallMs: 1 });
    expect(await runWave(WAVE())).toBe(0);
    expect(taskCalls().map((call) => call.key)).toEqual(["a"]);
    expect(handed()).toHaveLength(2);
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

  test("a verdict whose hand-overs all fail blocks the wave (infra) once; waves.retry hands the recorded verdict over again", async () => {
    await eachWave(["a"]);
    const taskId = (await tasksById()).values().next().value!.id;
    await appendWaveEvent(WAVE(), { kind: "task_review", key: "a", taskId, round: 1, tree: "t", base: "b", contracts: null, sessionId: "s", model: null, verdict: "approved", status: "ok", findings: [], usage: NO_USAGE, wallMs: 0 });
    process.env.FAKE_PI_EXIT = "1";
    // A runner that has not released the task's lock: `busy` is no try used up, however often it comes.
    await lockTask(taskId);
    const { fold } = await readWave(WAVE());
    const deps = { ...reviewEachDeps, env: process.env, log: () => {} };
    for (let look = 0; look < 5; look++) expect(await reviewNext(fold, new Map([["a", "reviewing"]]), deps)).toBe(true);
    await unlockFile(taskLockPath(taskId));
    await runWave(WAVE());
    const blocked = (await readWave(WAVE())).fold;
    expect([blocked.stage, blocked.reason]).toEqual(["blocked", "infra"]);
    expect(blocked.detail).toContain("task a");
    expect(blocked.detail).not.toContain(caseDir);
    expect(noted("reviewing")).toEqual([]);
    // The runner starts anew with a working task: the verdict is handed over, not reviewed again.
    delete process.env.FAKE_PI_EXIT;
    await callAction("waves.retry", { id: WAVE() });
    await until(async () => (await readWave(WAVE())).fold.stage === "merged", 20_000);
    expect(handed().map((command) => command.review.approved)).toEqual([true]);
    expect(taskCalls()).toEqual([]);
  }, 40_000);
});
