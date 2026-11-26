/** The `feedback` tool against a fake `memory-store` on PATH: where an entry lands, and that the call never ends the turn. */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type FeedbackEntry, waveFeedback } from "../feedback.ts";
import { registerFeedbackTool } from "./feedback-tool.ts";

const scratch = mkdtempSync(join(tmpdir(), "factory-feedback-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const bin = join(scratch, "bin");
const root = join(scratch, "store");
mkdirSync(bin);
// ls: exit 0 when the store directory exists; create: mkdir; apply: appends the op's text as a line; read: "- [n] text", newest first.
writeFileSync(
  join(bin, "memory-store"),
  `#!/bin/sh
cmd=$1; name=$2; dir="${root}/$name"
case "$cmd" in
  ls) [ -d "$dir" ] || exit 1;;
  create) mkdir -p "$dir";;
  apply) printf '%s\\n' "$4" | bun -e 'const ops=JSON.parse(require("fs").readFileSync(0,"utf8"));require("fs").appendFileSync(process.argv[1],ops.map((o)=>o.text).join("\\n")+"\\n")' "$dir/log";;
  read) [ -f "$dir/log" ] || exit 0; n=0; tac "$dir/log" | while read -r line; do n=$((n+1)); echo "- [f$n] $line"; done;;
esac
`,
);
chmodSync(join(bin, "memory-store"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

type Result = { isError?: boolean; content: { text: string }[]; terminate?: boolean };
function tool(kept: FeedbackEntry[], plan: string | null) {
  let execute: ((...args: unknown[]) => Promise<Result>) | undefined;
  const pi = { registerTool: (t: { execute: typeof execute }) => (execute = t.execute) };
  registerFeedbackTool(pi as unknown as ExtensionAPI, { role: "coder", context: async () => ({ task: "task-1", wave: "wave-1", plan }), keep: (entry) => kept.push(entry) });
  return (params: unknown) => execute!("call", params, undefined, undefined, {});
}

beforeEach(() => rmSync(root, { recursive: true, force: true }));
const store = (name: string) => mkdirSync(join(root, name), { recursive: true });

describe("feedback", () => {
  test("an entry lands in the store with its task, wave and role, and the turn goes on", async () => {
    store("plan");
    const kept: FeedbackEntry[] = [];
    const result = await tool(kept, "plan")({ kind: "context", what: "read 40 files", cost: "2 rounds" });
    expect(result.isError).toBeUndefined();
    expect(result.terminate).toBeUndefined();
    const stored = JSON.parse(readFileSync(join(root, "plan", "log"), "utf8"));
    expect(stored).toMatchObject({ kind: "context", what: "read 40 files", cost: "2 rounds", task: "task-1", wave: "wave-1", role: "coder" });
    expect(await waveFeedback("plan", "wave-1")).toEqual([stored]);
    expect(await waveFeedback("plan", "other")).toEqual([]);
  });

  test("without a store it stays on the task", async () => {
    const kept: FeedbackEntry[] = [];
    const call = tool(kept, null);
    expect((await call({ kind: "runtime", what: "waited" })).isError).toBeUndefined();
    expect(kept.map((entry) => entry.what)).toEqual(["waited"]);
    const missing = tool(kept, "no-such-store");
    expect((await missing({ kind: "tools", what: "guessed" })).isError).toBeUndefined();
    expect(kept).toHaveLength(2);
  });

  test("an unknown kind is refused", async () => {
    store("plan");
    const kept: FeedbackEntry[] = [];
    const result = await tool(kept, "plan")({ kind: "gripe", what: "x" });
    expect(result.isError).toBe(true);
    expect(kept).toEqual([]);
  });
});
