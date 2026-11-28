/**
 * A gate step run once more when it fails; a flaky step (failed, then passed) counts as passed.
 * - No rerun after exit `INFRA_EXIT`, a kill or a timeout: those are not the step's to repeat
 * - A step that reruns its own failures says so in the last line of its output (`rerunsTrailer`): it is not run
 *   again. A mark anywhere else (a test's own output) is not read
 * - Every run holds a test slot (`test-slots.ts`) while its command runs
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

/** The trailer `gate-reruns: {"flaky": [...], "reran": [...]}`: names the step reran itself, passing then (`flaky`) or failing again (`reran`). */
export const RERUNS_MARK = "gate-reruns: ";

/** The trailer line of a step that reran `flaky` (passed then) and `reran` (failed again) itself; null when it reran nothing. */
export function rerunsTrailer(flaky: readonly string[], reran: readonly string[]): string | null {
  return flaky.length === 0 && reran.length === 0 ? null : `${RERUNS_MARK}${JSON.stringify({ flaky, reran })}`;
}

/** What the output's last line, its trailer (`rerunsTrailer`), says the step reran: `flaky` (passed then), `reran` whether it reran anything. */
export function innerReruns(output: string): { flaky: string[]; reran: boolean } {
  const last = output.trimEnd().split("\n").at(-1)?.trim() ?? "";
  if (!last.startsWith(RERUNS_MARK)) return { flaky: [], reran: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(last.slice(RERUNS_MARK.length));
  } catch {
    return { flaky: [], reran: false };
  }
  const names = (value: unknown) => (Array.isArray(value) ? value.filter((name): name is string => typeof name === "string" && name.trim() !== "").map((name) => name.trim()) : []);
  const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const flaky = [...new Set(names(record.flaky))].slice(0, MAX_NAMES);
  return { flaky, reran: flaky.length > 0 || names(record.reran).length > 0 };
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
