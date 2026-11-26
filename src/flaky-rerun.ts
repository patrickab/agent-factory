/**
 * A gate step run once more when it fails, for the three gate loops (a task's round, a task's merge, a wave's review
 * and merge).
 *
 * - Provides `runGateStep`: the step's result and, when it failed and then passed, its `flaky` names (the failing test
 *   names read from the first run's output, else the command). A flaky step counts as passed
 * - No rerun after exit `INFRA_EXIT`, a kill or a timeout: those are not the step's to repeat
 * - A step that reruns its own failures says so in its output (`FLAKY_MARK`, `RERAN_MARK` lines, as
 *   `scripts/changed-tests.ts` prints them): it is not run again, and its `FLAKY_MARK` names are its flaky names
 * - Every run holds a test slot (`test-slots.ts`) while its command runs: `run` gets the slot's env for the command
 */
import type { CommandResult } from "./run.ts";
import { INFRA_EXIT, passed } from "./state.ts";
import { type SlotPool, slotPool, withSlot } from "./test-slots.ts";

export interface GateStep {
  /** The last run's result, its `durationMs` the time of both runs. */
  result: CommandResult;
  /** The failing test names of a step that failed and then passed; null otherwise. */
  flaky: string[] | null;
}

/** A line `gate-flaky: <name>`: the step reran `<name>` itself, and it passed then. */
export const FLAKY_MARK = "gate-flaky: ";
/** A line `gate-reran: <name>`: the step reran `<name>` itself, and it failed again. */
export const RERAN_MARK = "gate-reran: ";

/** The names a step's output marks as rerun inside it: `flaky` (passed then), `reran` whether it reran anything. */
export function innerReruns(output: string): { flaky: string[]; reran: boolean } {
  const flaky: string[] = [];
  let reran = false;
  for (const line of output.split("\n")) {
    const text = line.trim();
    if (text.startsWith(RERAN_MARK)) reran = true;
    if (!text.startsWith(FLAKY_MARK)) continue;
    reran = true;
    const name = text.slice(FLAKY_MARK.length).trim();
    if (name !== "" && !flaky.includes(name) && flaky.length < MAX_NAMES) flaky.push(name);
  }
  return { flaky, reran };
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

/**
 * Runs `argv` with `run`, once more when it failed and may (`rerunnable`), did not rerun inside (`innerReruns`) and
 * `stop` does not say otherwise. Each run holds a slot of `pool` and gets its env (`slotEnv`) to add to the command's;
 * a wait for a slot that `stop` ends answers as a killed run.
 */
export async function runGateStep(argv: readonly string[], run: (env: Record<string, string>) => Promise<CommandResult>, stop: () => boolean = () => false, pool: SlotPool = slotPool()): Promise<GateStep> {
  const slotted = () => withSlot(pool, stop, run);
  const first = await slotted();
  const inner = innerReruns(first.output);
  if (passed(first)) return { result: first, flaky: inner.flaky.length > 0 ? inner.flaky : null };
  if (inner.reran || !rerunnable(first) || stop()) return { result: first, flaky: null };
  const second = await slotted();
  const result = { ...second, durationMs: first.durationMs + second.durationMs };
  if (!passed(second)) return { result, flaky: null };
  const names = [...new Set([...failingTests(first.output), ...innerReruns(second.output).flaky])].slice(0, MAX_NAMES);
  return { result, flaky: names.length > 0 ? names : [argv.join(" ")] };
}
