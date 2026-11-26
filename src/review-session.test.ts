import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STUB_PREFIX, stubEarlierRounds } from "./review-session.ts";

type Line = Record<string, unknown>;

const header = { type: "session", version: 3, id: "rs-wave", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/w" };
const at = "2026-01-01T00:00:01.000Z";
const user = (id: string, parentId: string | null, text: string) => ({ type: "message", id, parentId, timestamp: at, message: { role: "user", content: [{ type: "text", text }], timestamp: 1 } });
const call = (id: string, parentId: string, callId: string) => ({ type: "message", id, parentId, timestamp: at, message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: "read_diff", arguments: {} }], stopReason: "toolUse", timestamp: 1 } });
const result = (id: string, parentId: string, callId: string, text: string) => ({ type: "message", id, parentId, timestamp: at, message: { role: "toolResult", toolCallId: callId, toolName: "read_diff", content: [{ type: "text", text }], isError: false, timestamp: 1 } });
const edit = (id: string, parentId: string, targetId: string, replacement: unknown) => ({ type: "context_edit", id, parentId, timestamp: at, targetId, replacement });

function sessionFile(lines: Line[], trailingNewline = true): string {
  const file = join(mkdtempSync(join(tmpdir(), "rs-stub-")), "s.jsonl");
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + (trailingNewline ? "\n" : ""));
  return file;
}
const read = (file: string): Line[] => readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Line);
const appended = (file: string, before: number) => read(file).slice(before);

describe("stubEarlierRounds", () => {
  test("replaces every tool result by a stub, chained from the leaf", () => {
    const lines = [header, user("u1", null, "review"), call("a1", "u1", "c1"), result("r1", "a1", "c1", "DIFF-1"), call("a2", "r1", "c2"), result("r2", "a2", "c2", "DIFF-2")];
    const file = sessionFile(lines);
    expect(stubEarlierRounds(file)).toBe(2);
    const [first, second] = appended(file, lines.length);
    expect(first).toMatchObject({ type: "context_edit", parentId: "r2", targetId: "r1", replacement: { content: [{ type: "text", text: `${STUB_PREFIX} read_diff result of an earlier review` }] } });
    expect(second).toMatchObject({ type: "context_edit", parentId: first.id, targetId: "r2" });
    expect(first.id).toMatch(/^[0-9a-f]{8}$/);
  });

  test("stubs only what is not a stub yet: a second call appends nothing", () => {
    const lines = [header, user("u1", null, "review"), call("a1", "u1", "c1"), result("r1", "a1", "c1", "DIFF-1")];
    const file = sessionFile(lines);
    expect(stubEarlierRounds(file)).toBe(1);
    const size = readFileSync(file, "utf8");
    expect(stubEarlierRounds(file)).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(size);
  });

  test("a later round's result is stubbed, the earlier stub stays", () => {
    const lines = [
      header,
      user("u1", null, "review 1"),
      call("a1", "u1", "c1"),
      result("r1", "a1", "c1", "DIFF-1"),
      edit("e1", "r1", "r1", { content: [{ type: "text", text: `${STUB_PREFIX} round 1` }] }),
      user("u2", "e1", "review 2"),
      call("a2", "u2", "c2"),
      result("r2", "a2", "c2", "DIFF-2"),
    ];
    const file = sessionFile(lines);
    expect(stubEarlierRounds(file)).toBe(1);
    expect(appended(file, lines.length)[0]).toMatchObject({ parentId: "r2", targetId: "r2" });
  });

  test("a result whose own text is a stub, or a string replacement that is one, is left", () => {
    const lines = [header, user("u1", null, "x"), call("a1", "u1", "c1"), result("r1", "a1", "c1", `${STUB_PREFIX} already`), call("a2", "r1", "c2"), result("r2", "a2", "c2", "DIFF"), edit("e1", "r2", "r2", { content: `${STUB_PREFIX} s` })];
    expect(stubEarlierRounds(sessionFile(lines))).toBe(0);
  });

  test("a later edit that is not a stub wins over an earlier stub; an omission is replaced by a stub", () => {
    const lines = [
      header,
      user("u1", null, "x"),
      call("a1", "u1", "c1"),
      result("r1", "a1", "c1", "DIFF-1"),
      edit("e1", "r1", "r1", { content: [{ type: "text", text: `${STUB_PREFIX} s` }] }),
      edit("e2", "e1", "r1", { content: [{ type: "text", text: "back" }] }),
      call("a2", "e2", "c2"),
      result("r2", "a2", "c2", "DIFF-2"),
      edit("e3", "r2", "r2", null),
    ];
    const file = sessionFile(lines);
    expect(stubEarlierRounds(file)).toBe(2);
    expect(appended(file, lines.length).map((line) => line.targetId)).toEqual(["r1", "r2"]);
  });

  test("only the active branch counts: a result on an abandoned branch is left", () => {
    const lines = [header, user("u1", null, "x"), call("a1", "u1", "c1"), result("r1", "a1", "c1", "OLD"), call("a2", "u1", "c2"), result("r2", "a2", "c2", "DIFF")];
    const file = sessionFile(lines);
    expect(stubEarlierRounds(file)).toBe(1);
    expect(appended(file, lines.length)[0]).toMatchObject({ targetId: "r2", parentId: "r2" });
  });

  test("no tool result leaves the file untouched; a missing last newline is completed", () => {
    const none = sessionFile([header, user("u1", null, "x")]);
    const before = readFileSync(none, "utf8");
    expect(stubEarlierRounds(none)).toBe(0);
    expect(readFileSync(none, "utf8")).toBe(before);
    const lines = [header, user("u1", null, "x"), call("a1", "u1", "c1"), result("r1", "a1", "c1", "DIFF")];
    const file = sessionFile(lines, false);
    expect(stubEarlierRounds(file)).toBe(1);
    expect(read(file)).toHaveLength(lines.length + 1);
  });
});

// Against the installed Pi: a model faked by a local OpenAI-compatible server that records every request. Round n reads
// `round<n>.patch`; before rounds 2 and 3 the session file gets its stubs from outside, then Pi resumes it by
// `--session-id`. No request of a later round may hold an earlier round's file text. Runs only with
// `FACTORY_TEST_REAL_PI=1` and an installed `pi`.
const pi = process.env.FACTORY_TEST_REAL_PI === "1" ? Bun.which("pi") : null;
describe.skipIf(!pi)("a session resumed by the installed pi", () => {
  test(
    "holds the stubs, not the earlier tool results",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "rs-pi-"));
      const [work, sessions, agent] = ["work", "sessions", "agent"].map((name) => join(root, name));
      for (const dir of [work, sessions, agent]) mkdirSync(dir);
      for (const n of [1, 2, 3]) writeFileSync(join(work, `round${n}.patch`), `RS-SECRET-ROUND-${n}\n`);
      const extension = join(root, "fake-model.ts");
      writeFileSync(
        extension,
        `export default function (pi: any) {
  pi.registerProvider("rsfake", { name: "rsfake", baseUrl: process.env.RS_FAKE_URL, apiKey: "local", api: "openai-completions",
    models: [{ id: "m", name: "m", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }] });
}
`,
      );
      const requests: string[] = [];
      const chunk = (choice: unknown) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [choice] })}\n\n`;
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          const text = await request.text();
          requests.push(text);
          const body = JSON.parse(text) as { messages: { role: string; content: unknown }[] };
          const last = body.messages.at(-1);
          const events =
            last?.role === "user"
              ? [
                  chunk({ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path: (JSON.stringify(last.content).match(/round\d\.patch/) ?? [""])[0] }) } }] }, finish_reason: null }),
                  chunk({ index: 0, delta: {}, finish_reason: "tool_calls" }),
                ]
              : [chunk({ index: 0, delta: { role: "assistant", content: "verdict" }, finish_reason: null }), chunk({ index: 0, delta: {}, finish_reason: "stop" })];
          return new Response(`${events.join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
        },
      });
      try {
        for (const n of [1, 2, 3]) {
          if (n > 1) {
            const file = readdirSync(sessions).find((name) => name.endsWith("_rs-wave.jsonl"));
            expect(file).toBeDefined();
            expect(stubEarlierRounds(join(sessions, file as string))).toBe(1);
          }
          const from = requests.length;
          const run = Bun.spawn(
            [pi as string, "--mode", "json", "-p", "--tools", "read", "-ne", "-e", extension, "--no-skills", "--no-prompt-templates", "--no-themes", "--session-dir", sessions, "--session-id", "rs-wave", "--model", "rsfake/m", `review round${n}.patch`],
            { cwd: work, env: { ...process.env, RS_FAKE_URL: `http://127.0.0.1:${server.port}/v1`, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1" }, stdout: "pipe", stderr: "pipe" },
          );
          const [code, , stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);
          if (code !== 0) throw new Error(`pi exited ${code}: ${stderr}`);
          // Round 1 creates the session; a later round resumes it.
          expect(stderr.includes("creating a new session")).toBe(n === 1);
          const round = requests.slice(from);
          expect(round.length).toBe(2);
          for (const earlier of [1, 2, 3].filter((k) => k < n)) expect(round.join("\n")).not.toContain(`RS-SECRET-ROUND-${earlier}`);
          expect(round.at(-1)).toContain(`RS-SECRET-ROUND-${n}`);
          if (n > 1) expect(round[0]).toContain(STUB_PREFIX);
        }
      } finally {
        server.stop(true);
      }
    },
    60_000,
  );
});
