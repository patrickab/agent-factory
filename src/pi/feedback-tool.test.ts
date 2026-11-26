/** The `feedback` tool against the shared fake `memory-store` on PATH: where an entry lands, and that the call never ends the turn. */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
const calls = join(scratch, "calls.log");
writeFakeMemoryStore(bin);
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.FAKE_STORE_ROOT = root;
process.env.FAKE_STORE_LOG = calls;

type Result = { isError?: boolean; content: { text: string }[]; terminate?: boolean };
function tool(kept: FeedbackEntry[], plan: string | null) {
  let execute: ((...args: unknown[]) => Promise<Result>) | undefined;
  const pi = { registerTool: (t: { execute: typeof execute }) => (execute = t.execute) };
  registerFeedbackTool(pi as unknown as ExtensionAPI, { role: "coder", context: async () => ({ task: "task-1", wave: "wave-1", plan }), keep: (entry) => kept.push(entry) });
  return (params: unknown) => execute!("call", params, undefined, undefined, {});
}

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(calls, { force: true });
});
/** A strict store (as the real CLI) with the directories `dirs` declared. */
const store = (name: string, dirs: string[]) => writeStore(root, name, { memories: {}, docs: {}, dirs });
const storeCalls = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []);
const entries = (name: string) => (readStore(root, name).memories[FEEDBACK_PATH] ?? []).map((text) => JSON.parse(text) as FeedbackEntry);

describe("feedback", () => {
  test("an entry lands in the store with its task, wave and role in one call, and the turn goes on", async () => {
    store("plan", ["run"]);
    const kept: FeedbackEntry[] = [];
    const result = await tool(kept, "plan")({ kind: "context", what: "read 40 files", cost: "2 rounds" });
    expect(result.isError).toBeUndefined();
    expect(result.terminate).toBeUndefined();
    const [stored] = entries("plan");
    expect(stored).toMatchObject({ kind: "context", what: "read 40 files", cost: "2 rounds", task: "task-1", wave: "wave-1", role: "coder" });
    expect(storeCalls().map((line) => line.split(" ")[0])).toEqual(["apply"]);
    // The next entry goes into the memory the first created, in one call too.
    await tool(kept, "plan")({ kind: "runtime", what: "waited" });
    expect(entries("plan").map((entry) => entry.what)).toEqual(["read 40 files", "waited"]);
    expect(storeCalls().map((line) => line.split(" ")[0])).toEqual(["apply", "apply"]);
    expect((await waveFeedback("plan", "wave-1")).map((entry) => entry.what)).toEqual(["read 40 files", "waited"]);
    expect(await waveFeedback("plan", "other")).toEqual([]);
  });

  test("a store without the directory run gets it declared, then the entry", async () => {
    store("plan", ["map"]);
    const kept: FeedbackEntry[] = [];
    await tool(kept, "plan")({ kind: "tools", what: "guessed" });
    expect(entries("plan").map((entry) => entry.what)).toEqual(["guessed"]);
    expect(storeCalls().map((line) => line.split(" ")[0])).toEqual(["apply", "create", "apply"]);
    expect(readStore(root, "plan").dirs).toEqual(["map", "run"]);
  });

  test("without a store it stays on the task", async () => {
    const kept: FeedbackEntry[] = [];
    const call = tool(kept, null);
    expect((await call({ kind: "runtime", what: "waited" })).isError).toBeUndefined();
    expect(kept.map((entry) => entry.what)).toEqual(["waited"]);
    const missing = tool(kept, "no-such-store");
    expect((await missing({ kind: "tools", what: "guessed" })).isError).toBeUndefined();
    expect(kept).toHaveLength(2);
    // A missing store is never created.
    expect(storeCalls().map((line) => line.split(" ")[0])).toEqual(["apply"]);
  });

  test("an unknown kind is refused", async () => {
    store("plan", ["run"]);
    const kept: FeedbackEntry[] = [];
    const result = await tool(kept, "plan")({ kind: "gripe", what: "x" });
    expect(result.isError).toBe(true);
  });
});
