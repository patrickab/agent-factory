/**
 * A gate step run once more when it fails, for the three gate loops (a task's round, a task's merge, a wave's review
 * and merge).
 *
 * - Provides `runGateStep`: the step's result and, when it failed and then passed, its `flaky` names (the failing test
 *   names read from the first run's output, else the command). A flaky step counts as passed
 * - No rerun after exit `INFRA_EXIT`, a kill or a timeout: those are not the step's to repeat
 */
import { INFRA_EXIT } from "./pipeline.ts";
import type { CommandResult } from "./run.ts";
import { passed } from "./state.ts";

export interface GateStep {
  /** The last run's result, its `durationMs` the time of both runs. */
  result: CommandResult;
  /** The failing test names of a step that failed and then passed; null otherwise. */
  flaky: string[] | null;
}

/** At most this many names are recorded for one step. */
const MAX_NAMES = 20;

/** Lines that name a failing test: bun, jest, vitest, mocha-like marks, go, pytest. */
const FAILING_TEST = [/^\(fail\)\s+(.+?)(?:\s+\[[\d.]+\s*m?s\])?$/, /^[✗✕×]\s+(.+?)(?:\s+\(\d+(?:\.\d+)?\s*m?s\))?$/, /^--- FAIL:\s+(\S+)/, /^FAILED\s+(\S+)/];

/** The failing test names in a run's output, at most `MAX_NAMES`, in order and without repeats. */
export function failingTests(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split("\n")) {
    const text = line.trim();
    for (const pattern of FAILING_TEST) {
      const name = pattern.exec(text)?.[1]?.trim();
      if (name && !names.includes(name)) names.push(name);
    }
    if (names.length >= MAX_NAMES) break;
  }
  return names.slice(0, MAX_NAMES);
}

/** Whether a failed run may run again: not after exit `INFRA_EXIT`, a kill or a timeout. */
export function rerunnable(result: CommandResult): boolean {
  return !passed(result) && !result.killed && !result.timedOut && result.exitCode !== null && result.exitCode !== INFRA_EXIT;
}

/** Runs `argv` with `run`, once more when it failed and may (`rerunnable`) and `stop` does not say otherwise. */
export async function runGateStep(argv: readonly string[], run: () => Promise<CommandResult>, stop: () => boolean = () => false): Promise<GateStep> {
  const first = await run();
  if (!rerunnable(first) || stop()) return { result: first, flaky: null };
  const second = await run();
  const result = { ...second, durationMs: first.durationMs + second.durationMs };
  if (!passed(second)) return { result, flaky: null };
  const names = failingTests(first.output);
  return { result, flaky: names.length > 0 ? names : [argv.join(" ")] };
}
