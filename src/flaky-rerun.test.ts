import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { failingTests, RERUNS_MARK, rerunsTrailer, runGateStep } from "./flaky-rerun.ts";
import type { CommandResult } from "./run.ts";

function result(exitCode: number | null, output = "", over: Partial<CommandResult> = {}): CommandResult {
  return { exitCode, killed: false, timedOut: false, durationMs: 5, stdout: "", stdoutTruncated: false, output, ...over };
}

/** A step whose runs return `results` in turn, the number of runs in `runs()`. */
function stepOf(...results: CommandResult[]): { run: () => Promise<CommandResult>; runs: () => number } {
  let count = 0;
  return { run: async () => results[Math.min(count++, results.length - 1)], runs: () => count };
}

describe("failingTests", () => {
  test("reads bun, jest, go and pytest failures, without timings or repeats", () => {
    const output = ["(pass) a > ok [1ms]", "(fail) a > b [12.50ms]", "  ✕ adds (3 ms)", "--- FAIL: TestX (0.01s)", "FAILED tests/t.py::test_y - boom", "(fail) a > b [1ms]"].join("\n");
    expect(failingTests(output)).toEqual(["a > b", "adds", "TestX", "tests/t.py::test_y"]);
  });

  test("nothing it can read: no names", () => {
    expect(failingTests("Error: something broke\n")).toEqual([]);
  });
});

describe("runGateStep", () => {
  test("a passing step runs once", async () => {
    const step = stepOf(result(0));
    expect(await runGateStep(["t"], step.run)).toEqual({ result: result(0), flaky: null });
    expect(step.runs()).toBe(1);
  });

  test("fails then passes: passed, flaky with the failing test names, the time of both runs", async () => {
    const step = stepOf(result(1, "(fail) slow > under load [9ms]\n"), result(0, "all good"));
    const { result: last, flaky } = await runGateStep(["bun", "test"], step.run);
    expect([last.exitCode, last.durationMs, last.output, flaky, step.runs()]).toEqual([0, 10, "all good", ["slow > under load"], 2]);
  });

  test("fails then passes with no test names in its output: flaky names the command", async () => {
    const step = stepOf(result(1, "boom"), result(0));
    expect((await runGateStep(["make", "check"], step.run)).flaky).toEqual(["make check"]);
  });

  test("fails twice: failed, not flaky", async () => {
    const step = stepOf(result(1, "first"), result(2, "second"));
    const { result: last, flaky } = await runGateStep(["t"], step.run);
    expect([last.exitCode, last.output, flaky, step.runs()]).toEqual([2, "second", null, 2]);
  });

  test.each([
    ["exit 75", result(75)],
    ["a kill", result(null, "", { killed: true })],
    ["a timeout", result(null, "", { killed: true, timedOut: true })],
    ["a signal", result(null)],
  ])("no rerun after %s", async (_name, first) => {
    const step = stepOf(first, result(0));
    expect(await runGateStep(["t"], step.run)).toEqual({ result: first, flaky: null });
    expect(step.runs()).toBe(1);
  });

  test("no rerun when stop says so", async () => {
    const step = stepOf(result(1), result(0));
    expect((await runGateStep(["t"], step.run, () => true)).result.exitCode).toBe(1);
    expect(step.runs()).toBe(1);
  });
});

describe("a step that reruns inside (scripts/changed-tests.ts)", () => {
  test("passes with a flaky trailer: passed once, flaky with the marked names", async () => {
    const step = stepOf(result(0, `ok src/a.test.ts\nchanged-tests: 1 passed\n${rerunsTrailer(["src/a.test.ts"], [])}\n`));
    expect(await runGateStep(["bun", "scripts/changed-tests.ts"], step.run)).toMatchObject({ flaky: ["src/a.test.ts"] });
    expect(step.runs()).toBe(1);
  });

  test("fails after its own rerun: not run again", async () => {
    const step = stepOf(result(1, `(fail) x\n${rerunsTrailer([], ["src/b.test.ts"])}\n`), result(0));
    expect(await runGateStep(["bun", "scripts/changed-tests.ts"], step.run)).toMatchObject({ result: { exitCode: 1 }, flaky: null });
    expect(step.runs()).toBe(1);
  });

  test("a mark that is not the last line (a test printed it) is not read: the step runs once more", async () => {
    const printed = `${RERUNS_MARK}${JSON.stringify({ flaky: [], reran: ["src/b.test.ts"] })}`;
    const step = stepOf(result(1, `${printed}\n(fail) x\nchanged-tests: 0 passed, 1 failed\n`), result(0));
    expect(await runGateStep(["bun", "scripts/changed-tests.ts"], step.run)).toMatchObject({ result: { exitCode: 0 }, flaky: ["x"] });
    expect(step.runs()).toBe(2);
    const passing = stepOf(result(0, `gate-flaky: src/a.test.ts\n${printed.replace("reran", "flaky")}\nchanged-tests: 1 passed\n`));
    expect((await runGateStep(["t"], passing.run)).flaky).toBeNull();
  });
});

test("flaky-rerun.ts reaches pipeline.ts through no import: no cycle", () => {
  const seen = new Set<string>();
  const visit = (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    for (const match of readFileSync(path, "utf8").matchAll(/^import (?!type )[^;]*?from "(\.{1,2}\/[^"]+)"/gm)) visit(join(dirname(path), match[1]));
  };
  visit(join(import.meta.dirname, "flaky-rerun.ts"));
  expect([...seen].some((path) => path.endsWith("/pipeline.ts"))).toBe(false);
});
