/**
 * Notifications delivered by the extension, against a temp factory home: task records with an origin and session files
 * holding their state, a fake `pi` that notes `sendMessage`. No runner, no model.
 */
import { afterAll, afterEach, describe, expect } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { caseDigits, caseSerial, caseTests } from "../test-case.ts";
import factory from "./index.ts";
import { startNotifier } from "./notifier.ts";
import { TASK_SESSION_ENV } from "../runner.ts";
import { writeTask, type TaskRecord } from "../tasks.ts";
import { appendScoutEvent, scoutDir, writeScoutDeclaration } from "../scouts.ts";

const scratch = mkdtempSync(join(tmpdir(), "factory-notifier-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const stops: (() => void)[] = [];
// These tests may run inside a factory task's own Pi (the runner sets it): each test sets it itself.
const savedTaskSession = process.env[TASK_SESSION_ENV];
afterAll(() => {
  if (savedTaskSession === undefined) delete process.env[TASK_SESSION_ENV];
  else process.env[TASK_SESSION_ENV] = savedTaskSession;
});

const test = caseTests(() => {
  delete process.env[TASK_SESSION_ENV];
  process.env.PI_CODING_AGENT_DIR = join(scratch, `agent-${caseSerial()}`);
});
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  delete process.env[TASK_SESSION_ENV];
});

const ID = (n: number) => `00000000-0000-4000-8000-${caseDigits(caseSerial() * 10 + n)}`;

/** A task of `origin` whose session holds the state `state`. Answers the session file's path. */
async function taskOf(n: number, origin: string | null, state: string): Promise<{ record: TaskRecord; file: string }> {
  const sessionDir = join(process.env.PI_CODING_AGENT_DIR!, "factory", "sessions", "repo");
  const record: TaskRecord = {
    id: ID(n),
    repo: join(scratch, "repo"),
    worktree: join(scratch, `wt-${n}`),
    branch: `task-${n}`,
    title: `task ${n}`,
    sessionId: `session-${caseSerial()}-${n}`,
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
  const sent: { message: { customType: string; content: string; details?: unknown }; options: unknown }[] = [];
  const pi = {
    registerCommand: () => undefined,
    registerMessageRenderer: () => undefined,
    registerShortcut: () => undefined,
    registerTool: () => undefined,
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
    appendEntry: () => undefined,
    sendUserMessage: () => undefined,
    sendMessage: (message: { customType: string; content: string; details?: unknown }, options: unknown) => sent.push({ message, options }),
    setModel: async () => true,
  };
  const ctx = {
    cwd: scratch,
    ui: { setStatus: () => undefined, notify: () => undefined, setWidget: () => undefined },
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

/** A scout session `origin` started; `report` makes it done with that report. Answers its directory. */
async function scoutOf(n: number, origin: string, report?: string): Promise<string> {
  const caller = { kind: "session" as const, id: origin };
  const dir = scoutDir(caller, ID(n));
  await writeScoutDeclaration(dir, { id: ID(n), caller, repo: join(scratch, "repo"), cwd: scratch, concern: "how a works", questions: [], store: "app/plan", commit: "abc", model: null, createdAt: "2026-01-01T00:00:00.000Z" });
  await appendScoutEvent(dir, { kind: "state", state: "running" });
  if (report !== undefined) await scoutDone(dir, report);
  return dir;
}

async function scoutDone(dir: string, report: string): Promise<void> {
  writeFileSync(join(dir, "report.md"), report);
  await appendScoutEvent(dir, { kind: "state", state: "done" });
}

describe("scout reports to the session that started them", () => {
  test("a report arrives once as a factory report with its text; another session's scout is left alone", async () => {
    const dir = await scoutOf(1, "sess-A");
    await scoutOf(2, "sess-B", "B's report");
    const a = piSession("sess-A");
    await a.emit("session_start");
    await Bun.sleep(200);
    expect(a.sent).toEqual([]);
    await scoutDone(dir, "MISSING\n1. nothing");
    await until(() => a.sent.length > 0);
    expect(a.sent[0].message.customType).toBe("factory-notice");
    expect(a.sent[0].message.content).toContain("MISSING\n1. nothing");
    await a.emit("session_shutdown");
    const again = piSession("sess-A");
    await again.emit("session_start");
    await Bun.sleep(300);
    expect(again.sent).toEqual([]);
  });
});

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
    expect(a.sent[0].message.content).toContain(ID(1).slice(0, 8));
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
    expect(a.sent).toHaveLength(1);
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

describe("gate proofs", () => {
  /** A proof of `origin` with the runner note `pid`, `lines` after its declaration. */
  function proofOf(n: number, origin: string, lines: object[] = []): string {
    const dir = join(process.env.PI_CODING_AGENT_DIR!, "factory", "proofs");
    mkdirSync(dir, { recursive: true });
    const declaration = { id: ID(n), repo: join(scratch, "repo"), branch: "main", commit: "0".repeat(40), origin, createdAt: "2026-01-01T00:00:00.000Z" };
    writeFileSync(join(dir, `${ID(n)}.pid`), "999999999 1\n");
    const file = join(dir, `${ID(n)}.jsonl`);
    writeFileSync(file, [declaration, ...lines].map((line) => `${JSON.stringify(line)}\n`).join(""));
    return file;
  }

  test("an interrupted proof that later ends is reported again with its result; another origin's proof is read once", async () => {
    const own = proofOf(1, "sess-A");
    const other = proofOf(2, "sess-B");
    const sent: string[] = [];
    const notifier = startNotifier({ origin: "sess-A", send: (text) => sent.push(text), isTaskSession: () => false });
    stops.push(() => notifier.stop());
    await notifier.look();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("interrupted");
    // Read again, the other one would now give a `passed` notice of sess-A too: it is not read again.
    const end = { kind: "end", state: "passed", at: "2026-01-01T00:01:00.000Z" };
    appendFileSync(own, `${JSON.stringify(end)}\n`);
    writeFileSync(other, [{ id: ID(2), repo: join(scratch, "repo"), branch: "main", commit: "0".repeat(40), origin: "sess-A", createdAt: "2026-01-01T00:00:00.000Z" }, end].map((line) => `${JSON.stringify(line)}\n`).join(""));
    await notifier.look();
    expect(sent).toHaveLength(2);
    // Ended: never read again.
    await notifier.look();
    expect(sent).toHaveLength(2);
  });
});
