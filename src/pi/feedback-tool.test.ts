/** The `feedback` tool against the shared fake `memory-store` on PATH: where an entry lands, and that the call never ends the turn. */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readStore, writeFakeMemoryStore, writeStore } from "../fake-memory-store.ts";
import { type FeedbackEntry, FEEDBACK_PATH, waveFeedback } from "../feedback.ts";
import { registerFeedbackTool } from "./feedback-tool.ts";

const scratch = mkdtempSync(join(tmpdir(), "factory-feedback-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const bin = join(scratch, "bin");
const root = join(scratch, "store");
writeFakeMemoryStore(bin);
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.FAKE_STORE_ROOT = root;

type Result = { isError?: boolean; content: { text: string }[]; terminate?: boolean; details?: unknown };
function tool(plan: string | null) {
  let execute: ((...args: unknown[]) => Promise<Result>) | undefined;
  const pi = { registerTool: (t: { execute: typeof execute }) => (execute = t.execute) };
  registerFeedbackTool(pi as unknown as ExtensionAPI, { role: "coder", context: async () => ({ task: "task-1", wave: "wave-1", plan }) });
  return (params: unknown) => execute!("call", params, undefined, undefined, {});
}

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
});
/** A strict store (as the real CLI) with the directories `dirs` declared. */
const store = (name: string, dirs: string[]) => writeStore(root, name, { memories: {}, docs: {}, dirs });
const entries = (name: string) => (readStore(root, name).memories[FEEDBACK_PATH] ?? []).map((text) => JSON.parse(text) as FeedbackEntry);

describe("feedback", () => {
  test("an entry lands in the store with its task, wave and role, and the turn goes on", async () => {
    store("plan", ["run"]);
    const result = await tool("plan")({ kind: "context", what: "read 40 files", cost: "2 rounds" });
    expect(result.isError).toBeUndefined();
    expect(result.terminate).toBeUndefined();
    const [stored] = entries("plan");
    expect(stored).toMatchObject({ kind: "context", what: "read 40 files", cost: "2 rounds", task: "task-1", wave: "wave-1", role: "coder" });
    await tool("plan")({ kind: "runtime", what: "waited" });
    expect((await waveFeedback("plan", "wave-1")).map((entry) => entry.what)).toEqual(["read 40 files", "waited"]);
    expect(await waveFeedback("plan", "other")).toEqual([]);
  });

  test("without a store the result holds it", async () => {
    const held = { task: "task-1", wave: "wave-1", role: "coder" };
    const call = tool(null);
    const result = await call({ kind: "runtime", what: "waited" });
    expect([result.isError, result.details]).toMatchObject([undefined, { kind: "runtime", what: "waited", ...held }]);
    const missing = await tool("no-such-store")({ kind: "tools", what: "guessed" });
    expect([missing.isError, missing.details]).toMatchObject([undefined, { kind: "tools", what: "guessed", ...held }]);
  });
});
