/**
 * Per-test ids. `caseTests` wraps bun's `test`: the body runs in its own scope with a serial of its own, so an id built
 * from `caseSerial()` stays the test's even when the body outlives its timeout and the next test has started.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { test as bunTest } from "bun:test";

const scope = new AsyncLocalStorage<number>();
let serial = 0;

/** The running test's serial, 1 and up; 0 outside a test body. */
export const caseSerial = (): number => scope.getStore() ?? 0;

/** `n` as the last group of an id: 12 digits. */
export const caseDigits = (n = caseSerial()): string => String(n).padStart(12, "0");

/** A `test` whose body (after `setup`, when given) runs in a scope of its own. */
export function caseTests(setup?: () => void | Promise<void>): (name: string, body: () => unknown, timeoutMs?: number) => void {
  return (name, body, timeoutMs) =>
    bunTest(
      name,
      () =>
        scope.run(++serial, async () => {
          await setup?.();
          return body();
        }),
      timeoutMs,
    );
}
