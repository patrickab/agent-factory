import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionFiles } from "./session-files.ts";

const call = (name: string, args: object) => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "toolCall", id: "x", name, arguments: args }] },
});

test("collects read, edit and write paths relative to the worktree", () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-"));
  const file = join(dir, "s.jsonl");
  const lines = [
    { type: "session", id: "s" },
    call("read", { path: "/wt/src/a.ts", offset: 1 }),
    call("edit", { path: "src/b.ts", edits: [] }),
    call("write", { path: "/wt/c.md", content: "" }),
    call("read", { path: "/etc/passwd" }),
    call("read", { path: "../other/x.ts" }),
    call("bash", { command: "cat /wt/d.ts" }),
    call("read", { path: "/wt/src/a.ts" }),
  ];
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\nnot json {\n`);
  expect([...sessionFiles(file, "/wt")].sort()).toEqual(["c.md", "src/a.ts", "src/b.ts"]);
});

test("a missing session file has no files", () => {
  expect(sessionFiles("/nonexistent/s.jsonl", "/wt").size).toBe(0);
});
