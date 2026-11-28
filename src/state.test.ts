import { describe, expect, test } from "bun:test";
import { applyEntry, approvedFrom, followUpMessages, mergeFailedPrompt, rebuild, RETRY_PROMPT, roundsUsed, spentUntil, type Finding, type Task } from "./state.ts";

const task: Task = {
  title: "Add notes",
  request: "Create notes.txt",
  settings: { branch: "main", merge: "auto", maxRounds: 3, review: true, models: {} },
  branch: "task",
  mainBranch: "main",
  baseSha: "abc",
};

const custom = (customType: string, data: unknown, timestamp = "t") => ({ type: "custom", customType, data, timestamp });
const finding = (severity: Finding["severity"]): Finding => ({ file: "a.ts", line: 1, severity, text: "x" });

describe("rebuild", () => {
  test("a branch without a factory-task entry holds no task", () => {
    expect(rebuild([{ type: "message" }, custom("other", {}), custom("factory-state", { state: "done", round: 1, reason: "" })])).toBeUndefined();
  });

  test("follows rounds, states and merges in entry order", () => {
    const snapshot = rebuild([
      custom("factory-task", task),
      custom("factory-round", { round: 1, trigger: "start" }),
      custom("factory-state", { state: "running", round: 1, reason: "start" }),
      { type: "message" },
      custom("factory-gate", { round: 1, phase: "gates", argv: ["t"], exitCode: 0, killed: false, durationMs: 1, outputTail: "" }),
      custom("factory-round", { round: 2, trigger: "gates" }),
      custom("factory-merge-intent", { commit: "def", before: "abc" }),
      custom("factory-merge", { ok: false, commit: null, error: "x", depsSynced: false }),
    ]);
    expect(snapshot).toMatchObject({ state: "running", round: 2, mergeIntent: null, failure: "x" });
    const gated = applyEntry(applyEntry(snapshot, "factory-round", { round: 3, trigger: "gates" }), "factory-gate", { round: 3, phase: "merge_gates", argv: ["t"], exitCode: 1, killed: false, durationMs: 1, outputTail: "" });
    expect(applyEntry(gated, "factory-merge", { ok: false, commit: null, error: "x", depsSynced: false })?.failure).toBe("t (exit 1)");
    const done = rebuild([
      custom("factory-task", task),
      custom("factory-round", { round: 1, trigger: "start" }),
      custom("factory-merge", { ok: false, commit: null, error: "x", depsSynced: false }),
      custom("factory-merge", { ok: true, commit: "def", error: null, depsSynced: false }),
      custom("factory-state", { state: "done", round: 1, reason: "merged" }),
    ]);
    expect(done).toEqual({ task, state: "done", round: 1, runFirstRound: 1, reason: "merged", at: "t", mergeIntent: null, failure: null, review: null, minors: [], flaky: [], mergedCommit: "def", commitMessage: null, spent: expect.any(Object) });
  });

  test("message and retry open a run with a fresh round budget", () => {
    let snapshot = rebuild([custom("factory-task", task), custom("factory-round", { round: 1, trigger: "start" }), custom("factory-round", { round: 2, trigger: "gates" })]);
    expect(roundsUsed(snapshot!)).toBe(2);
    snapshot = applyEntry(snapshot, "factory-round", { round: 3, trigger: "message" });
    expect(roundsUsed(snapshot!)).toBe(1);
    snapshot = applyEntry(snapshot, "factory-round", { round: 4, trigger: "review" });
    snapshot = applyEntry(snapshot, "factory-round", { round: 5, trigger: "retry" });
    expect(snapshot).toMatchObject({ round: 5, runFirstRound: 5 });
  });

  test("a conflict round opens a run on a task at rest, inside a run or a merge it spends the run's budget", () => {
    const run = rebuild([custom("factory-task", task), custom("factory-round", { round: 1, trigger: "start" })])!;
    expect(applyEntry({ ...run, state: "blocked" }, "factory-round", { round: 2, trigger: "conflict" })).toMatchObject({ runFirstRound: 2 });
    expect(applyEntry({ ...run, state: "merging" }, "factory-round", { round: 2, trigger: "conflict" })).toMatchObject({ runFirstRound: 1 });
    expect(applyEntry(run, "factory-round", { round: 2, trigger: "conflict" })).toMatchObject({ runFirstRound: 1 });
  });

  test("the minor findings of every review are kept with their round, oldest first", () => {
    const review = (round: number) => custom("factory-review", { round, status: "ok", approved: false, findings: [finding("major"), { ...finding("minor"), text: `m${round}` }] });
    expect(rebuild([custom("factory-task", task), review(1), review(2)])?.minors.map((minor) => [minor.round, minor.text])).toEqual([[1, "m1"], [2, "m2"]]);
  });

  test("a factory-question and waiting_answer rebuild into the resting state with the open question; the answer clears it", () => {
    const entries = [
      custom("factory-task", task),
      custom("factory-round", { round: 1, trigger: "start" }),
      custom("factory-state", { state: "running", round: 1, reason: "start" }),
      custom("factory-question", { text: "Which table?" }),
      custom("factory-state", { state: "waiting_answer", round: 1, reason: "question" }),
    ];
    const asked = rebuild(entries);
    expect(asked).toMatchObject({ state: "waiting_answer", round: 1, runFirstRound: 1, reason: "question", question: "Which table?" });
    const answered = rebuild([...entries, custom("factory-state", { state: "running", round: 1, reason: "answer" })]);
    expect(answered).toMatchObject({ state: "running", round: 1, runFirstRound: 1 });
    expect(answered?.question).toBeUndefined();
  });

  test("the time between states sums by state, a gate's time moves to gates; a final state counts until it was entered", () => {
    const at = (minute: number) => `2025-01-02T10:${String(minute).padStart(2, "0")}:00.000Z`;
    const state = (minute: number, state: string) => custom("factory-state", { state, round: 1, reason: "" }, at(minute));
    const gate = (minute: number, phase: string, durationMs: number) => custom("factory-gate", { round: 1, phase, argv: ["t"], exitCode: 0, killed: false, durationMs, outputTail: "" }, at(minute));
    const snapshot = rebuild([
      custom("factory-task", task, at(0)),
      state(0, "running"),
      gate(10, "gates", 120_000),
      state(12, "reviewing"),
      state(15, "running"),
      state(20, "waiting_answer"),
      state(30, "running"),
      state(40, "merging"),
      gate(44, "merge_gates", 180_000),
      state(45, "done"),
    ])!;
    const minutes = Object.fromEntries(Object.entries(spentUntil(snapshot, false, at(59))).map(([key, ms]) => [key, ms / 60_000]));
    expect(minutes).toEqual({ running: 25, gates: 5, reviewing: 3, waiting_answer: 10, merging: 2 });
  });
});

describe("verdict rules", () => {
  test("approved needs status ok and no blocker or major finding", () => {
    expect(approvedFrom("ok", [])).toBe(true);
    expect(approvedFrom("ok", [finding("minor")])).toBe(true);
    expect(approvedFrom("ok", [finding("minor"), finding("major")])).toBe(false);
    expect(approvedFrom("ok", [finding("blocker")])).toBe(false);
    expect(approvedFrom("malformed", [])).toBe(false);
    expect(approvedFrom("no_diff", [])).toBe(false);
  });
});

describe("followUpMessages", () => {
  const user = (content: unknown) => ({ type: "message", message: { role: "user", content } });

  test("the user's messages after the request in order, without commands, retry prompts and feedback", () => {
    const branch = [
      user("before the task"),
      custom("factory-task", task),
      custom("factory-round", { round: 1, trigger: "start" }),
      user("Create notes.txt"),
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
      custom("factory-state", { state: "waiting_approve", round: 1, reason: "passed" }),
      custom("factory-round", { round: 2, trigger: "message" }),
      user([{ type: "text", text: "also add a second line: follow-up" }]),
      { type: "custom_message", customType: "factory-feedback", content: "Round 2: the review found problems." },
      user("/factory approve"),
      user(RETRY_PROMPT),
      user(mergeFailedPrompt("rebase onto main failed")),
      user("and a third line"),
    ];
    expect(followUpMessages(branch)).toEqual(["also add a second line: follow-up", "and a third line"]);
  });

  test("a branch without a task, or with only its request, has none", () => {
    expect(followUpMessages([user("hello")])).toEqual([]);
    expect(followUpMessages([custom("factory-task", task), user("Create notes.txt")])).toEqual([]);
  });
});
