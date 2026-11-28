import { describe, expect, test } from "bun:test";
import { DEFAULT_PROTECTED, type FactoryConfig } from "./config.ts";
import { reviewedDrafts, runMerge, runRound, type PipelineSteps } from "./pipeline.ts";
import type { CommandResult } from "./run.ts";
import { type Draft, type MergeData, type ReviewData, type ReviewStatus, type Settings, type Snapshot } from "./state.ts";

const config: FactoryConfig = {
  hooks: { after_create: [], after_merge: [] },
  gates: [["lint"], ["test"]],
  merge_gates: [["lint"], ["test"]],
  task_gates: [],
  protected: DEFAULT_PROTECTED,
};

function snapshotOf(settings: Partial<Settings> = {}, round = 1, runFirstRound = 1): Snapshot {
  return {
    task: {
      title: "T",
      request: "R",
      settings: { branch: "main", merge: "auto", maxRounds: 3, review: true, models: {}, ...settings },
      branch: "task",
      mainBranch: "main",
      baseSha: "abc",
    },
    state: "running",
    round,
    runFirstRound,
    reason: "start",
    at: null,
    mergeIntent: null,
    failure: null,
    review: null,
    minors: [],
    flaky: [],
    mergedCommit: null,
    commitMessage: null,
    spent: { since: "", ms: {} },
  };
}

function commandResult(exitCode: number | null, output = ""): CommandResult {
  return { exitCode, killed: exitCode === null, timedOut: false, durationMs: 5, stdout: output, stdoutTruncated: false, output };
}

function reviewOf(status: ReviewStatus, severities: ("blocker" | "major" | "minor")[] = []): ReviewData {
  const findings = severities.map((severity) => ({ file: "a.ts", line: 1, severity, text: `${severity} problem` }));
  const approved = status === "ok" && severities.every((severity) => severity === "minor");
  return { round: 1, status, approved, findings, model: "m", sessionFile: null, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, wallMs: 1 };
}

const merged: MergeData = { ok: true, commit: "def", error: null, depsSynced: false };

/** Steps where everything passes, with the calls recorded in `calls`. */
function fakeSteps(overrides: Partial<PipelineSteps> = {}): PipelineSteps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    status: () => undefined,
    cancelled: () => false,
    pendingMessages: () => false,
    config: () => config,
    runCommand: async (argv) => {
      calls.push(argv.join(" "));
      return commandResult(0);
    },
    diff: async () => ({ base: "tree", paths: ["src/a.ts"], patch: "diff" }),
    review: async () => {
      calls.push("review");
      return reviewOf("ok");
    },
    merge: async () => {
      calls.push("merge");
      return { gates: [], result: { kind: "merged", merge: merged } };
    },
    openRebase: async () => null,
    askCommitMessage: () => false,
    inWave: async () => false,
    ...overrides,
  };
}

const kinds = (entries: Draft[]) => entries.map((entry) => (entry.type === "custom" ? entry.customType : entry.type));
const lastState = (entries: Draft[]) => entries.flatMap((entry) => (entry.type === "custom" && entry.customType === "factory-state" ? [entry.data] : [])).at(-1);

describe("runRound", () => {
  test("a passing auto round runs gates and review in order and ends merging, the merge itself is the caller's", async () => {
    const steps = fakeSteps();
    const result = await runRound(snapshotOf(), steps);
    expect(steps.calls).toEqual(["lint", "test", "review"]);
    expect(kinds(result.entries)).toEqual(["factory-gate", "factory-gate", "factory-review", "factory-state"]);
    expect(result.entries[0]).toMatchObject({ data: { round: 1, phase: "gates", argv: ["lint"], exitCode: 0 } });
    expect(lastState(result.entries)).toEqual({ state: "merging", round: 1, reason: "passed" });
    expect(result.continue).toBe(false);
  });

  test.each(["auto", "review"] as const)("a message queued during a passing %s round opens a message round instead of the merge or the wait", async (merge) => {
    const steps = fakeSteps({ pendingMessages: () => true });
    const result = await runRound(snapshotOf({ merge }), steps);
    expect(kinds(result.entries).slice(-2)).toEqual(["factory-round", "factory-state"]);
    expect(result.entries.at(-2)).toMatchObject({ data: { round: 2, trigger: "message" } });
    expect(lastState(result.entries)).toEqual({ state: "running", round: 2, reason: "message" });
    expect(result.entries.some((entry) => entry.type === "custom" && ["merging", "waiting_approve"].includes((entry.data as { state?: string }).state ?? ""))).toBe(false);
    expect(result.continue).toBe(true);
  });

  test("a message queued during a round that ends blocked opens a message round after the blocked state", async () => {
    const steps = fakeSteps({ pendingMessages: () => true, review: async () => reviewOf("malformed") });
    const result = await runRound(snapshotOf(), steps);
    const states = result.entries.flatMap((entry) => (entry.type === "custom" && entry.customType === "factory-state" ? [(entry.data as { state: string; reason: string }).reason] : []));
    expect(states).toEqual(["review_malformed", "message"]);
    expect(result.continue).toBe(true);
  });

  test("merge review waits for approve without merging", async () => {
    const steps = fakeSteps();
    const result = await runRound(snapshotOf({ merge: "review" }), steps);
    expect(steps.calls).not.toContain("merge");
    expect(lastState(result.entries)).toEqual({ state: "waiting_approve", round: 1, reason: "passed" });
  });

  test("review off skips the reviewer", async () => {
    const steps = fakeSteps();
    await runRound(snapshotOf({ review: false }), steps);
    expect(steps.calls).toEqual(["lint", "test"]);
  });

  test("a failing gate stops the round and gives the coder its output in the next round", async () => {
    const steps = fakeSteps({ runCommand: async (argv) => commandResult(argv[0] === "lint" ? 2 : 0, "E501 line too long") });
    const result = await runRound(snapshotOf(), steps);
    expect(kinds(result.entries)).toEqual(["factory-gate", "factory-round", "custom_message"]);
    expect(result.entries[1]).toMatchObject({ data: { round: 2, trigger: "gates" } });
    expect(result.entries[2]).toMatchObject({ customType: "factory-feedback", display: true, details: { round: 1, trigger: "gates" } });
    expect((result.entries[2] as { content: string }).content).toContain("E501 line too long");
    expect(result.continue).toBe(true);
  });

  test("a gate that exits 75 blocks the task as infra, with no feedback and no round for the coder", async () => {
    const steps = fakeSteps({ runCommand: async (argv) => commandResult(argv[0] === "lint" ? 75 : 0, "noise\neslint is missing\n") });
    const result = await runRound(snapshotOf(), steps);
    expect(kinds(result.entries)).toEqual(["factory-gate", "factory-state"]);
    expect(lastState(result.entries)).toMatchObject({ state: "blocked", reason: "infra: eslint is missing" });
    expect(result.continue).toBe(false);
  });

  test("the last round of the budget ends blocked, with the feedback and no new round", async () => {
    const result = await runRound(snapshotOf({ maxRounds: 3 }, 3), fakeSteps({ runCommand: async () => commandResult(1) }));
    expect(kinds(result.entries)).toEqual(["factory-gate", "custom_message", "factory-state"]);
    expect(lastState(result.entries)).toEqual({ state: "blocked", round: 3, reason: "max_rounds: gates" });
    expect(result.continue).toBe(false);
  });

  test("the budget counts from the first round of the run", async () => {
    const result = await runRound(snapshotOf({ maxRounds: 2 }, 4, 4), fakeSteps({ runCommand: async () => commandResult(1) }));
    expect(result.continue).toBe(true);
    expect(result.entries[1]).toMatchObject({ data: { round: 5, trigger: "gates" } });
  });

  test("a diff that touches a protected path is a round problem and is never reviewed or merged", async () => {
    const steps = fakeSteps({ diff: async () => ({ base: "tree", paths: ["src/a.ts", "factory.yaml", ".factory/agents/coder.md"], patch: "diff" }) });
    const result = await runRound(snapshotOf(), steps);
    expect(steps.calls).toEqual(["lint", "test"]);
    expect(result.entries.at(-2)).toMatchObject({ data: { round: 2, trigger: "protected" } });
    const named = (result.entries.at(-1) as { content: string }).content;
    expect([named.includes("factory.yaml"), named.includes(".factory/agents/coder.md"), named.includes("src/a.ts")]).toEqual([true, true, false]);
    expect(result.continue).toBe(true);
  });

  test("blocker and major findings go back to the coder, minor ones do not stop the merge", async () => {
    const rejected = await runRound(snapshotOf(), fakeSteps({ review: async () => reviewOf("ok", ["minor", "major"]) }));
    expect(kinds(rejected.entries).slice(-3)).toEqual(["factory-review", "factory-round", "custom_message"]);
    expect(rejected.entries.at(-2)).toMatchObject({ data: { round: 2, trigger: "review" } });
    const feedback = (rejected.entries.at(-1) as { content: string }).content;
    expect([feedback.includes("major problem"), feedback.includes("minor problem")]).toEqual([true, false]);

    const approved = await runRound(snapshotOf(), fakeSteps({ review: async () => reviewOf("ok", ["minor"]) }));
    expect(lastState(approved.entries)).toMatchObject({ state: "merging" });
  });

  test.each(["malformed", "failed"] as const)("a %s review blocks the task without a coder round", async (status) => {
    const steps = fakeSteps({ review: async () => reviewOf(status) });
    const result = await runRound(snapshotOf(), steps);
    expect(lastState(result.entries)).toEqual({ state: "blocked", round: 1, reason: `review_${status}` });
    expect(steps.calls).not.toContain("merge");
    expect(result.continue).toBe(false);
  });

  test("a review without a diff counts as passed", async () => {
    const result = await runRound(snapshotOf(), fakeSteps({ review: async () => reviewOf("no_diff") }));
    expect(lastState(result.entries)).toMatchObject({ state: "merging" });
  });

  test.each(["start", "message", "retry"] as const)("a %s round without a change ends done/no_changes: no review, no merge, no approve", async (trigger) => {
    const steps = fakeSteps({ diff: async () => ({ base: "tree", tree: "tree", paths: [], patch: "" }) });
    const result = await runRound({ ...snapshotOf({ merge: "review" }), reason: trigger }, steps);
    expect(lastState(result.entries)).toEqual({ state: "done", round: 1, reason: "no_changes" });
    expect(kinds(result.entries)).not.toContain("factory-review");
    expect(steps.calls).not.toContain("review");
    expect(steps.calls).not.toContain("merge");
    expect(result.continue).toBe(false);
  });

  test("a cancel during a gate ends cancelled, with the killed gate recorded", async () => {
    let cancelled = false;
    const steps = fakeSteps({
      cancelled: () => cancelled,
      runCommand: async () => {
        cancelled = true;
        return commandResult(null);
      },
    });
    const result = await runRound(snapshotOf(), steps);
    expect(kinds(result.entries)).toEqual(["factory-gate", "factory-state"]);
    expect(result.entries[0]).toMatchObject({ data: { exitCode: null, killed: true } });
    expect(lastState(result.entries)).toEqual({ state: "cancelled", round: 1, reason: "cancelled" });
  });
});

test("a rebase the coder left open goes back to the coder before any hook or gate runs", async () => {
  const steps = fakeSteps({ openRebase: async () => ["notes.txt"] });
  const result = await runRound(snapshotOf({}, 2, 1), steps);
  expect(result.continue).toBe(true);
  expect(result.entries[0]).toMatchObject({ data: { round: 3, trigger: "conflict" } });
  expect((result.entries[1] as { content: string }).content).toContain("notes.txt");
  expect(steps.calls).toEqual([]);
});

describe("runMerge", () => {
  const merging = (...args: Parameters<typeof snapshotOf>): Snapshot => ({ ...snapshotOf(...args), state: "merging" });
  const gate = { round: 2, phase: "merge_gates" as const, argv: ["lint"], exitCode: 0, killed: false, durationMs: 1, outputTail: "" };

  test("records the merge gates before the merge and reports the merge as merged", async () => {
    const steps = fakeSteps({ merge: async () => ({ gates: [gate], result: { kind: "merged", merge: { ...merged, tree: null } } }) });
    const entries = await runMerge(merging({}, 2), config, steps);
    expect(kinds(entries)).toEqual(["factory-gate", "factory-merge", "factory-state"]);
    expect(lastState(entries)).toEqual({ state: "done", round: 2, reason: "merged" });
  });

  test("a failed after_merge hook is recorded and leaves the task done with a reason that says so", async () => {
    const hook = { ...gate, phase: "after_merge" as const, argv: ["uv", "sync"], exitCode: 1, outputTail: "no network" };
    const data: MergeData = { ok: true, commit: "def", error: "after_merge failed: uv sync: no network", depsSynced: false };
    const entries = await runMerge(merging({}, 2), config, fakeSteps({ merge: async () => ({ gates: [hook], result: { kind: "merged", merge: data } }) }));
    expect(entries[0]).toMatchObject({ customType: "factory-gate", data: { phase: "after_merge", exitCode: 1 } });
    expect(entries[1]).toMatchObject({ customType: "factory-merge", data: { ok: true, error: "after_merge failed: uv sync: no network" } });
    expect(lastState(entries)).toEqual({ state: "done", round: 2, reason: "merged, after_merge failed" });
  });

  const failed: MergeData = { ok: false, commit: null, error: "fast-forward of main refused", depsSynced: false };

  test("a failed merge blocks the task", async () => {
    const entries = await runMerge(merging(), config, fakeSteps({ merge: async () => ({ gates: [], result: { kind: "failed", merge: failed } }) }));
    expect(entries.at(-2)).toMatchObject({ customType: "factory-merge", data: failed });
    expect(lastState(entries)).toEqual({ state: "blocked", round: 1, reason: "merge_failed" });
  });

  test("a rebase conflict merges nothing and opens a conflict round within the budget, then blocks with max_rounds: conflict", async () => {
    const conflicting = fakeSteps({ merge: async () => ({ gates: [], result: { kind: "conflict", files: ["notes.txt"] } }) });
    const entries = await runMerge(merging({ maxRounds: 3 }, 2, 1), config, conflicting);
    expect(kinds(entries)).toEqual(["factory-round", "custom_message", "factory-state"]);
    expect(entries[0]).toMatchObject({ data: { round: 3, trigger: "conflict" } });
    expect(entries[1]).toMatchObject({ details: { round: 2, trigger: "conflict" } });
    expect((entries[1] as { content: string }).content).toContain("notes.txt");
    expect(lastState(entries)).toEqual({ state: "running", round: 3, reason: "conflict" });

    const last = await runMerge(merging({ maxRounds: 3 }, 3, 1), config, conflicting);
    expect(kinds(last)).toEqual(["custom_message", "factory-state"]);
    expect(lastState(last)).toEqual({ state: "blocked", round: 3, reason: "max_rounds: conflict" });
  });

  test("a merge gate that fails on the rebased branch goes back to the coder as a gates round, nothing merged", async () => {
    const failedGate = { argv: ["test"], result: commandResult(1, "FAILED test_new_thing") };
    const entries = await runMerge(merging({ maxRounds: 3 }, 2, 1), config, fakeSteps({ merge: async () => ({ gates: [], result: { kind: "gate_failed", gate: failedGate } }) }));
    expect(kinds(entries)).toEqual(["factory-round", "custom_message", "factory-state"]);
    expect((entries[1] as { content: string }).content).toContain("FAILED test_new_thing");
    expect(lastState(entries)).toEqual({ state: "running", round: 3, reason: "gates" });
  });

  test("a merge gate that exits 75 blocks the task as infra", async () => {
    const failedGate = { argv: ["test"], result: commandResult(75, "pi-host/node_modules is missing") };
    const entries = await runMerge(merging({}, 1, 1), config, fakeSteps({ merge: async () => ({ gates: [], result: { kind: "gate_failed", gate: failedGate } }) }));
    expect(lastState(entries)).toEqual({ state: "blocked", round: 1, reason: "infra: pi-host/node_modules is missing" });
  });


});

describe("review per task", () => {
  test("a passed round of a wave's task rests reviewing: no review of its own, no merge", async () => {
    const steps = fakeSteps({ inWave: async () => true });
    const result = await runRound(snapshotOf(), steps);
    expect(steps.calls).toEqual(["lint", "test"]);
    expect(lastState(result.entries)).toEqual({ state: "reviewing", round: 1, reason: "passed" });
    expect(result.continue).toBe(false);
  });

  test("approved: the review is recorded and the task merges; minor findings start no round", () => {
    const snapshot = { ...snapshotOf(), state: "reviewing" as const };
    const result = reviewedDrafts(snapshot, reviewOf("ok", ["minor"]));
    expect(kinds(result.entries)).toEqual(["factory-review", "factory-state"]);
    expect(lastState(result.entries)).toEqual({ state: "merging", round: 1, reason: "approved" });
  });

  test("a major finding: the next round with only the blocker and major findings, within the run's rounds", () => {
    const snapshot = { ...snapshotOf(), state: "reviewing" as const };
    const result = reviewedDrafts(snapshot, reviewOf("ok", ["major", "minor"]));
    expect(result.continue).toBe(true);
    expect(kinds(result.entries)).toEqual(["factory-review", "factory-round", "custom_message", "factory-state"]);
    expect(lastState(result.entries)).toEqual({ state: "running", round: 2, reason: "review" });
    const feedback = result.entries.find((entry) => entry.type === "custom_message");
    expect(feedback?.type === "custom_message" && feedback.content).toContain("[major] a.ts:1: major problem");
    expect(feedback?.type === "custom_message" && feedback.content).not.toContain("minor problem");
  });

  test("out of rounds: blocked, max_rounds: review", () => {
    const snapshot = { ...snapshotOf({ maxRounds: 2 }, 2, 1), state: "reviewing" as const };
    const result = reviewedDrafts(snapshot, reviewOf("ok", ["blocker"]));
    expect(result.continue).toBe(false);
    expect(lastState(result.entries)).toEqual({ state: "blocked", round: 2, reason: "max_rounds: review" });
  });

  test("no verdict blocks the task", () => {
    const snapshot = { ...snapshotOf(), state: "reviewing" as const };
    expect(lastState(reviewedDrafts(snapshot, reviewOf("malformed")).entries)).toEqual({ state: "blocked", round: 1, reason: "review_malformed" });
  });
});
