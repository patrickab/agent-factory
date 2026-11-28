import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFindings, readReviewerOutput, runReview } from "./review.ts";
import type { CommandOptions, CommandResult } from "./run.ts";
import type { Finding, Task } from "./state.ts";

const line = (event: unknown) => JSON.stringify(event);
const verdictEnd = (findings: unknown, isError = false) =>
  line({ type: "tool_execution_end", toolName: "submit_verdict", isError, result: { details: { findings } } });
const assistantEnd = (usage: unknown) => line({ type: "message_end", message: { role: "assistant", usage } });

describe("parseFindings", () => {
  test("accepts findings, a missing line becomes null", () => {
    expect(parseFindings([{ file: "a.ts", severity: "minor", text: "typo" }, { file: "b.ts", line: 3, severity: "blocker", text: "crash" }])).toEqual([
      { file: "a.ts", line: null, severity: "minor", text: "typo" },
      { file: "b.ts", line: 3, severity: "blocker", text: "crash" },
    ]);
  });

  test.each([
    [{ findings: [] }],
    [["x"]],
    [[{ file: "", line: 1, severity: "minor", text: "t" }]],
    [[{ file: "a", line: 1.5, severity: "minor", text: "t" }]],
    [[{ file: "a", line: 1, severity: "critical", text: "t" }]],
    [[{ file: "a", line: 1, severity: "minor" }]],
  ])("rejects %j", (value) => {
    expect(typeof parseFindings(value)).toBe("string");
  });
});

describe("readReviewerOutput", () => {
  const finding: Finding = { file: "src/cart.js", line: 5, severity: "blocker", text: "off by one" };

  test("reads session id, the verdict and the summed usage", () => {
    const stdout = [
      line({ type: "session", id: "abc-123" }),
      assistantEnd({ input: 4, output: 100, cacheRead: 10, cacheWrite: 50, cost: { total: 0.001 } }),
      line({ type: "message_end", message: { role: "user", usage: { input: 999 } } }),
      assistantEnd({ input: 6, output: 20, cacheRead: 60, cacheWrite: 0, cost: { total: 0.002 } }),
      verdictEnd([finding]),
    ].join("\n");
    expect(readReviewerOutput(stdout)).toEqual({
      findings: [finding],
      sessionId: "abc-123",
      usage: { input: 10, output: 120, cacheRead: 70, cacheWrite: 50, cost: 0.003 },
    });
  });

  test("a rejected call is no verdict, the last valid call wins", () => {
    expect(readReviewerOutput(verdictEnd([finding], true)).findings).toBeNull();
    expect(readReviewerOutput([verdictEnd([finding]), verdictEnd([])].join("\n")).findings).toEqual([]);
    expect(readReviewerOutput([verdictEnd([]), verdictEnd("nonsense")].join("\n")).findings).toEqual([]);
  });

  test("no call and broken lines give no verdict", () => {
    const output = readReviewerOutput(`${line({ type: "session", id: "s1" })}\n{"type":"tool_execution_end","toolNa`);
    expect(output.findings).toBeNull();
    expect(output.sessionId).toBe("s1");
  });
});

describe("runReview", () => {
  const reviewsDir = mkdtempSync(join(tmpdir(), "factory-reviews-test-"));
  // The worktree under review: the reviewer's run compares it before and after.
  const root = join(reviewsDir, "repo");
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--allow-empty", "-m", "init"], { cwd: root });
  afterAll(() => rmSync(reviewsDir, { recursive: true, force: true }));
  const task: Task = {
    title: "Fix the cart",
    request: "The total is off by one.",
    settings: { branch: "main", merge: "auto", maxRounds: 3, review: true, models: {} },
    branch: "task",
    mainBranch: "main",
    baseSha: "abc",
  };
  const blocker: Finding = { file: "src/cart.js", line: 5, severity: "blocker", text: "off by one" };
  const child = (overrides: Partial<CommandResult> = {}): CommandResult => ({
    exitCode: 0,
    killed: false,
    timedOut: false,
    durationMs: 42,
    stdout: [line({ type: "session", id: "abc-123" }), verdictEnd([blocker])].join("\n"),
    stdoutTruncated: false,
    output: "",
    ...overrides,
  });
  const review = (result: CommandResult, calls: { argv: string[]; options: CommandOptions }[] = [], patch = "diff --git a/src/cart.js b/src/cart.js\n", followUps: string[] = [], cancelled = false) =>
    runReview({
      exec: async (argv, options) => {
        calls.push({ argv, options });
        return result;
      },
      root,
      round: 2,
      task,
      followUps,
      diff: { base: "tree", paths: ["src/cart.js"], patch },
      model: "anthropic/claude-haiku-5-5",
      rolePrompt: "Be strict.",
      reviewsDir,
      cancelled: () => cancelled,
    });

  test("maps the child's verdict", async () => {
    expect(await review(child())).toMatchObject({ round: 2, status: "ok", approved: false, findings: [blocker] });
  });

  test.each([
    ["aborted", { killed: true, exitCode: null }, false],
    // Cancelled: no verdict, even one the child wrote before it was stopped.
    ["aborted", {}, true],
    ["failed", { exitCode: 1 }, false],
    ["malformed", { stdout: line({ type: "session", id: "abc-123" }) }, false],
  ] as const)("a child that ends %s yields no findings and no approval", async (status, result, cancelled) => {
    expect(await review(child(result), [], undefined, [], cancelled)).toMatchObject({ status, approved: false, findings: [] });
  });

  test("an empty patch is no_diff and starts no child", async () => {
    const calls: { argv: string[]; options: CommandOptions }[] = [];
    expect(await review(child(), calls, "\n")).toMatchObject({ status: "no_diff", approved: false, findings: [], sessionFile: null });
    expect(calls).toEqual([]);
  });
});
