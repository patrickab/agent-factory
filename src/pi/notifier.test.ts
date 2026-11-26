/**
 * Notifications delivered by the extension, against a temp factory home: task records with an origin and session files
 * holding their state, a fake `pi` that notes `sendMessage`. No runner, no model.
 */
import { afterAll, afterEach, describe, expect } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { caseDigits, caseSerial, caseTests } from "../test-case.ts";
import factory from "./index.ts";
import { startNotifier, type Notifier } from "./notifier.ts";
import { TASK_SESSION_ENV } from "../runner.ts";
import { writeTask, type TaskRecord } from "../tasks.ts";
import { createWave } from "../waves.ts";
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
function piSession(sessionId: string, branch: { type: string; customType?: string; data?: unknown }[] = [], mode?: string) {
  const widgets: (string[] | undefined)[] = [];
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
    mode,
    ui: {
      setStatus: () => undefined,
      notify: () => undefined,
      // The widget as rendered 60 columns wide; undefined when removed.
      setWidget: (_key: string, content: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined) =>
        widgets.push(content?.(undefined, undefined).render(60)),
    },
    sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
  };
  factory(pi as unknown as ExtensionAPI);
  const emit = (name: string) => handlers.get(name)?.({}, ctx);
  stops.push(() => void emit("session_shutdown"));
  return { sent, emit, widgets };
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
  test("a report arrives once as a factory report with its text and path; another session's scout is left alone", async () => {
    const dir = await scoutOf(1, "sess-A");
    await scoutOf(2, "sess-B", "B's report");
    const a = piSession("sess-A");
    await a.emit("session_start");
    await Bun.sleep(200);
    expect(a.sent).toEqual([]);
    await scoutDone(dir, "MISSING\n1. nothing");
    await until(() => a.sent.length > 0);
    expect(a.sent[0].message.customType).toBe("factory-notice");
    expect(a.sent[0].message.content).toStartWith(`factory: scout ${ID(1).slice(0, 8)} reported`);
    expect(a.sent[0].message.content).toContain("MISSING\n1. nothing");
    expect(a.sent[0].message.content).toContain(`report: ${join(dir, "report.md")}`);
    expect(a.sent[0].message.details).toEqual({ key: `scout:${ID(1)}:report`, card: expect.objectContaining({ v: 1, kind: "scout", tone: "quiet", title: `scout ${ID(1).slice(0, 8)} reported`, text: "MISSING\n1. nothing" }) });
    await a.emit("session_shutdown");
    const again = piSession("sess-A");
    await again.emit("session_start");
    await Bun.sleep(300);
    expect(again.sent).toEqual([]);
  });

  test("a scout a call waits for is left to the call", async () => {
    await scoutOf(1, "sess-A", "the report");
    const sent: string[] = [];
    const notifier = startNotifier({ origin: "sess-A", send: (text) => sent.push(text), isTaskSession: () => false, skipScout: (id) => id === ID(1) });
    stops.push(() => notifier.stop());
    await notifier.look();
    expect(sent).toEqual([]);
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

  test("a finished, delivered task is not read again while its session file is unchanged", async () => {
    const { file } = await taskOf(1, "sess-A", "done");
    const errors: unknown[] = [];
    const notifier = startNotifier({ origin: "sess-A", send: () => undefined, isTaskSession: () => false, onError: (error) => errors.push(error) });
    stops.push(notifier.stop);
    await notifier.look();
    // Unreadable, same size and mtime: a look that read it again would fail.
    chmodSync(file, 0o000);
    try {
      await notifier.look();
      await notifier.look();
      expect(errors).toEqual([]);
    } finally {
      chmodSync(file, 0o644);
    }
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

describe("the session's waves widget", () => {
  const declare = (n: number, origin: string) =>
    createWave({ id: ID(n), repo: join(scratch, "repo"), tag: `ui/w${n}`, plan: null, title: `wave ${n}`, request: "r", branch: `main-ui-w${n}`, target: "main", base: "abc", origin, createdAt: `2026-01-01T00:00:0${n}.000Z`, overrides: {} });

  test("in the terminal UI: the waves this session declared, above the editor", async () => {
    await declare(1, "sess-A");
    await declare(2, "sess-B");
    const a = piSession("sess-A", [], "tui");
    await a.emit("session_start");
    await until(() => a.widgets.some((lines) => lines !== undefined));
    const lines = a.widgets.findLast((shown) => shown !== undefined)!;
    expect(lines[0]).toStartWith("Factory · 1 active");
    expect(lines.slice(1).map((line) => line.trim().split(/\s+/)[1])).toEqual(["ui/w1"]);
  });

  test("a line with wide characters is cut to the width it is rendered at", async () => {
    await createWave({ id: ID(3), repo: join(scratch, "repo"), tag: "ui/w3", plan: null, title: "日本語のタイトルがとても長くて端末の幅に収まらない🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀", request: "r", branch: "main-ui-w3", target: "main", base: "abc", origin: "sess-W", createdAt: "2026-01-01T00:00:03.000Z", overrides: {} });
    const a = piSession("sess-W", [], "tui");
    await a.emit("session_start");
    await until(() => a.widgets.some((lines) => lines !== undefined));
    const lines = a.widgets.findLast((shown) => shown !== undefined)!;
    expect(lines[1]).toContain("ui/w3");
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
  });

  test("no widget in RPC or print mode, nor in a task's own session; none without waves", async () => {
    await declare(1, "sess-A");
    const rpc = piSession("sess-A", [], "rpc");
    const print = piSession("sess-A", [], "print");
    const own = piSession("sess-A", [{ type: "custom", customType: "factory-task", data: {} }], "tui");
    const none = piSession("sess-C", [], "tui");
    for (const session of [rpc, print, own, none]) await session.emit("session_start");
    await Bun.sleep(300);
    for (const session of [rpc, print, own, none]) expect(session.widgets.filter((lines) => lines !== undefined)).toEqual([]);
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
    expect(sent[1]).toContain("the gates of main pass");
    // Ended: never read again.
    await notifier.look();
    expect(sent).toHaveLength(2);
  });

  test("an announced interrupted proof is not read again until its record changes", async () => {
    const own = proofOf(3, "sess-A");
    const sent: string[] = [];
    const notifier = startNotifier({ origin: "sess-A", send: (text) => sent.push(text), isTaskSession: () => false });
    stops.push(() => notifier.stop());
    await notifier.look();
    expect(sent).toHaveLength(1);
    // Rewritten into a proof of another origin without a stamp change being possible to hide: unchanged record, not read.
    const { mtimeMs } = statSync(own);
    const text = readFileSync(own, "utf8").replace("sess-A", "sess-B");
    writeFileSync(own, text);
    utimesSync(own, mtimeMs / 1000, mtimeMs / 1000);
    await notifier.look();
    expect(sent).toHaveLength(1);
  });
});
