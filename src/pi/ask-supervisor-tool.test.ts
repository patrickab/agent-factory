/** The `factory_ask_supervisor` tool as `index.ts` registers and gates it, against a fake `pi`/`ctx` on a throwaway repo. */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import factory from "./index.ts";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "factory-ask-tool-test-")));
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function gitIn(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

let counter = 0;
function repoWithTask(): string {
  counter += 1;
  const repo = join(scratch, `repo-${counter}`);
  mkdirSync(repo);
  gitIn(repo, "init", "--quiet", "--initial-branch", "main");
  gitIn(repo, "config", "user.name", "Factory Test");
  gitIn(repo, "config", "user.email", "factory@test.invalid");
  writeFileSync(join(repo, "factory.yaml"), "gates: []\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "--quiet", "-m", "base");
  const worktree = join(scratch, `wt-${counter}`);
  gitIn(repo, "worktree", "add", "--quiet", "-b", "task", worktree);
  writeFileSync(join(worktree, "a.txt"), "a\n");
  gitIn(worktree, "add", "a.txt");
  gitIn(worktree, "commit", "--quiet", "-m", "feat: add a");
  return worktree;
}

interface Tool {
  name: string;
  execute: (
    id: string,
    params: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<{ isError?: boolean; content: { text: string }[]; details?: unknown; terminate?: boolean }>;
}

function session(cwd: string, branch: { customType: string; data: unknown }[]) {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const tools = new Map<string, Tool>();
  const entries: { customType: string; data: any }[] = [];
  /** Message entries after `branch`, as Pi records them before it runs their tool calls. */
  const messages: { type: "message"; message: unknown }[] = [];
  const flags = { pending: false };
  const pi = {
    registerCommand: () => undefined,
    registerMessageRenderer: () => undefined,
    registerShortcut: () => undefined,
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    on: (name: string, handler: (event: any, ctx: any) => unknown) => handlers.set(name, handler),
    appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
    sendUserMessage: () => undefined,
    sendMessage: () => undefined,
    setModel: async () => true,
  };
  const ctx = {
    cwd,
    isIdle: () => true,
    abort: () => undefined,
    hasPendingMessages: () => flags.pending,
    ui: { setStatus: () => undefined, notify: () => undefined },
    model: undefined,
    modelRegistry: { find: () => undefined },
    sessionManager: { getSessionId: () => "tool-session", getBranch: () => [...branch.map((entry) => ({ type: "custom", ...entry })), ...messages] },
  };
  factory(pi as unknown as ExtensionAPI);
  const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx);
  const sections: Record<string, string> = {};
  return {
    tools,
    entries,
    messages,
    flags,
    sections,
    emit,
    /** A user message that opens a run, as Pi sends it: `input`, then `before_agent_start`. */
    message: async () => {
      await emit("input", { text: "also do x", source: "rpc" });
      await emit("before_agent_start", { messageType: "user", systemPromptOptions: { sections } });
    },
    ask: (params: unknown) => tools.get("factory_ask_supervisor")!.execute("call", params, undefined, undefined, ctx),
  };
}

const custom = (customType: string, data: unknown) => ({ customType, data });
const taskEntry = () =>
  custom("factory-task", { title: "Add a", request: "add a", settings: { branch: "main", merge: "auto", maxRounds: 3, review: false, models: {} }, branch: "task", mainBranch: "main", baseSha: "x" });
describe("factory_ask_supervisor", () => {
  test("records the question and waiting_answer and ends the turn; refused outside a running coder turn or without a question", async () => {
    const worktree = repoWithTask();
    const pi = session(worktree, [taskEntry(), custom("factory-round", { round: 1, trigger: "start" }), custom("factory-state", { state: "blocked", round: 1, reason: "max_rounds: gates" })]);
    await pi.emit("session_start");
    expect(pi.tools.has("factory_ask_supervisor")).toBe(true);
    expect((await pi.ask({ question: "Which table?" })).isError).toBe(true);

    await pi.message();
    expect((await pi.ask({ question: " " })).isError).toBe(true);
    const asked = await pi.ask({ question: "Which table?" });
    expect(asked).toMatchObject({ terminate: true, details: { question: "Which table?" } });
    expect(asked.isError).toBeUndefined();
    expect(pi.entries.slice(-2)).toEqual([
      { customType: "factory-question", data: { text: "Which table?" } },
      { customType: "factory-state", data: { state: "waiting_answer", round: 2, reason: "question" } },
    ]);
    expect((await pi.ask({ question: "And another?" })).isError).toBe(true);
  });

  test("refused next to another tool call in the same message or while a message is queued: the turn could not end with it (m6)", async () => {
    const worktree = repoWithTask();
    const pi = session(worktree, [taskEntry(), custom("factory-round", { round: 1, trigger: "start" }), custom("factory-state", { state: "blocked", round: 1, reason: "max_rounds: gates" })]);
    await pi.emit("session_start");
    await pi.message();
    const toolCall = (name: string) => ({ type: "toolCall", id: name, name, arguments: {} });
    pi.messages.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "I ask" }, toolCall("factory_ask_supervisor"), toolCall("read")] } });
    expect((await pi.ask({ question: "Which table?" })).isError).toBe(true);

    pi.messages.push({ type: "message", message: { role: "assistant", content: [toolCall("factory_ask_supervisor")] } });
    pi.flags.pending = true;
    expect((await pi.ask({ question: "Which table?" })).isError).toBe(true);
    expect(pi.entries.filter((entry) => entry.customType === "factory-question")).toEqual([]);

    pi.flags.pending = false;
    expect(await pi.ask({ question: "Which table?" })).toMatchObject({ terminate: true });
    expect(pi.entries.at(-1)).toEqual({ customType: "factory-state", data: { state: "waiting_answer", round: 2, reason: "question" } });
  });
});
