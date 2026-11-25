/**
 * Notifications delivered by the extension, against a temp factory home: task records with an origin and session files
 * holding their state, a fake `pi` that notes `sendMessage`. No runner, no model.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import factory from "./index.ts";
import { startNotifier, type Notifier } from "./notifier.ts";
import { TASK_SESSION_ENV } from "../runner.ts";
import { writeTask, type TaskRecord } from "../tasks.ts";

const scratch = mkdtempSync(join(tmpdir(), "factory-notifier-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;
const stops: (() => void)[] = [];
// These tests may run inside a factory task's own Pi (the runner sets it): each test sets it itself.
const savedTaskSession = process.env[TASK_SESSION_ENV];
afterAll(() => {
  if (savedTaskSession === undefined) delete process.env[TASK_SESSION_ENV];
  else process.env[TASK_SESSION_ENV] = savedTaskSession;
});

beforeEach(() => {
  delete process.env[TASK_SESSION_ENV];
  counter += 1;
  process.env.PI_CODING_AGENT_DIR = join(scratch, `agent-${counter}`);
});
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  delete process.env[TASK_SESSION_ENV];
});

const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

/** A task of `origin` whose session holds the state `state`. Answers the session file's path. */
async function taskOf(n: number, origin: string | null, state: string): Promise<{ record: TaskRecord; file: string }> {
  const sessionDir = join(process.env.PI_CODING_AGENT_DIR!, "factory", "sessions", "repo");
  const record: TaskRecord = {
    id: ID(n),
    repo: join(scratch, "repo"),
    worktree: join(scratch, `wt-${n}`),
    branch: `task-${n}`,
    title: `task ${n}`,
    sessionId: `session-${counter}-${n}`,
    sessionDir,
    createdAt: `2026-01-01T00:00:0${n}.000Z`,
    tag: "team/a",
    plan: null,
    wave: null,
    origin,
  };
  mkdirSync(sessionDir, { recursive: true });
  const file = join(sessionDir, `2026-01-01T00-00-00-000Z_${record.sessionId}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "custom", customType: "factory-state", data: { state, round: 1, reason: "gates_failed" }, timestamp: "2026-01-01T00:01:00.000Z" })}\n`);
  await writeTask(record);
  return { record, file };
}

/** The extension in a session `sessionId`; `branch` = the session's entries. */
function piSession(sessionId: string, branch: { type: string; customType?: string; data?: unknown }[] = []) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const sent: { message: { customType: string; content: string }; options: unknown }[] = [];
  const pi = {
    registerCommand: () => undefined,
    registerTool: () => undefined,
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
    appendEntry: () => undefined,
    sendUserMessage: () => undefined,
    sendMessage: (message: { customType: string; content: string }, options: unknown) => sent.push({ message, options }),
    setModel: async () => true,
  };
  const ctx = {
    cwd: scratch,
    ui: { setStatus: () => undefined, notify: () => undefined },
    sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
  };
  factory(pi as unknown as ExtensionAPI);
  const emit = (name: string) => handlers.get(name)?.({}, ctx);
  stops.push(() => void emit("session_shutdown"));
  return { sent, emit };
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

describe("the extension delivers notices", () => {
  test("on start: the notice of its own task, as a message that starts a turn; another session's is left alone", async () => {
    await taskOf(1, "sess-A", "blocked");
    await taskOf(2, "sess-B", "blocked");
    const a = piSession("sess-A");
    await a.emit("session_start");
    await until(() => a.sent.length > 0);
    await Bun.sleep(100);
    expect(a.sent).toHaveLength(1);
    expect(a.sent[0].options).toEqual({ triggerTurn: true });
    expect(a.sent[0].message.customType).toBe("factory-notice");
    expect(a.sent[0].message.content).toStartWith(`factory: task ${ID(1).slice(0, 8)} is blocked\ntask ${ID(1).slice(0, 8)}  blocked: gates_failed`);
    const b = piSession("sess-B");
    await b.emit("session_start");
    await until(() => b.sent.length > 0);
    expect(b.sent[0].message.content).toContain(`task ${ID(2).slice(0, 8)}`);
  });

  test("when a record changes; once, also after a restart of the session", async () => {
    const { file } = await taskOf(1, "sess-A", "done");
    const a = piSession("sess-A");
    await a.emit("session_start");
    await Bun.sleep(200);
    expect(a.sent).toEqual([]);
    appendFileSync(file, `${JSON.stringify({ type: "custom", customType: "factory-question", data: { text: "Which branch?" } })}\n`);
    appendFileSync(file, `${JSON.stringify({ type: "custom", customType: "factory-state", data: { state: "waiting_answer", round: 1, reason: "asked" }, timestamp: "2026-01-01T00:02:00.000Z" })}\n`);
    await until(() => a.sent.length > 0);
    expect(a.sent[0].message.content).toStartWith("factory: a coder asks");
    expect(a.sent[0].message.content).toContain("question: Which branch?");
    await a.emit("session_shutdown");
    const again = piSession("sess-A");
    await again.emit("session_start");
    await Bun.sleep(300);
    expect(again.sent).toEqual([]);
  });

  test("two sessions of the same origin racing deliver once", async () => {
    await taskOf(1, "sess-A", "blocked");
    const sent: string[] = [];
    const one = startNotifier({ origin: "sess-A", send: () => sent.push("one"), isTaskSession: () => false });
    const two = startNotifier({ origin: "sess-A", send: () => sent.push("two"), isTaskSession: () => false });
    stops.push(one.stop, two.stop);
    await Promise.all([one.look(), two.look(), one.look(), two.look()]);
    expect(sent).toHaveLength(1);
  });

  test("no notice for a task without origin", async () => {
    await taskOf(1, null, "blocked");
    const sent: string[] = [];
    const notifier: Notifier = startNotifier({ origin: "sess-A", send: (text) => sent.push(text), isTaskSession: () => false });
    stops.push(notifier.stop);
    await notifier.look();
    expect(sent).toEqual([]);
  });

  test("a task's own session delivers nothing: a runner's Pi, or a session holding a factory-task entry", async () => {
    await taskOf(1, "sess-A", "blocked");
    process.env[TASK_SESSION_ENV] = "1";
    const runner = piSession("sess-A");
    await runner.emit("session_start");
    delete process.env[TASK_SESSION_ENV];
    const own = piSession("sess-A", [{ type: "custom", customType: "factory-task", data: {} }]);
    await own.emit("session_start");
    await Bun.sleep(300);
    expect(runner.sent).toEqual([]);
    expect(own.sent).toEqual([]);
  });
});
