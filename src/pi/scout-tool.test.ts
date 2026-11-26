/**
 * The `scout` tool against a fake core (no scout child runs): both `wait` modes for a coder and for a supervisor
 * session, the coder's held reports, and one report per scout.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { claimNotices, readDelivered } from "../notified.ts";
import { pendingNotices, scoutNoticeKey } from "../notify.ts";
import { SCOUT_ID_ENV, type ScoutView } from "../scouts.ts";
import { createScoutTracker, registerScoutTool, SCOUT_TOOL_NAME, type ScoutCore } from "./scout-tool.ts";

let counter = 0;
beforeEach(() => {
  counter += 1;
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "factory-scout-tool-test-"));
});
afterEach(() => {
  delete process.env[SCOUT_ID_ENV];
});

const REPORT = "MISSING\n1. nothing\n\nDECISIONS\n- none\n\nKEY FACTS\n- a.ts:1 holds a\n\nMEMORY\n- map/a";

function view(id: string, kind: "task" | "session", state: ScoutView["state"]): ScoutView {
  const done = state === "done";
  return {
    id,
    caller: { kind, id: kind === "session" ? "supervisor-session" : "task-1" },
    repo: "/repo",
    concern: "how a works",
    questions: [],
    store: "app/plan",
    commit: "abc",
    model: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    state,
    error: null,
    running: !done,
    interrupted: false,
    usage: null,
    report: done ? REPORT : null,
    reportPath: done ? `/scouts/${id}/report.md` : null,
    written: [],
  };
}

/** A core whose scout `id` ends `done` after `getsUntilDone` reads; `started` holds every start's params. */
function fakeCore(kind: "task" | "session", getsUntilDone = 2) {
  const reads = new Map<string, number>();
  const started: Record<string, unknown>[] = [];
  const core: ScoutCore = {
    start: async (params) => {
      started.push(params);
      const id = `${String(counter).padStart(8, "0")}-scout-${started.length}`;
      reads.set(id, 0);
      return view(id, kind, "queued");
    },
    get: async (id) => {
      const n = (reads.get(id) ?? 0) + 1;
      reads.set(id, n);
      return view(id, kind, n >= getsUntilDone ? "done" : "running");
    },
  };
  return { core, started };
}

const ctx = { cwd: "/repo", sessionManager: { getSessionId: () => "supervisor-session" } } as unknown as ExtensionContext;

describe("a coder's scouts", () => {
  test("wait: false answers the id at once; the held turn end waits for the report and gives it once", async () => {
    const { core } = fakeCore("task", 3);
    const tracker = createScoutTracker({ isCoder: () => true, core, pollMs: 5 });
    const { text, result } = await tracker.call({ concern: "how a works" }, undefined, ctx);
    expect(result.scout.state).toBe("queued");
    expect(text).toContain("arrives as a message before your turn ends");
    const reports = await tracker.held(() => false);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ type: "custom_message", customType: "factory-scout", display: true, details: { scout: result.scout.id } });
    expect(reports[0].content).toContain("reported");
    expect(reports[0].content).toContain("KEY FACTS");
    expect(await tracker.held(() => false)).toEqual([]);
  });

  test("a coder whose task is not running is told to read the report with scouts.get", async () => {
    const { core } = fakeCore("task", 3);
    const tracker = createScoutTracker({ isCoder: () => true, holds: () => false, core, pollMs: 5 });
    const { text } = await tracker.call({ concern: "how a works" }, undefined, ctx);
    expect(text).toContain("scouts.get");
    expect(text).not.toContain("before your turn ends");
    expect(await tracker.held(() => false)).toEqual([]);
  });

  test("wait: true answers the report, which the turn end then does not repeat", async () => {
    const { core, started } = fakeCore("task");
    const tracker = createScoutTracker({ isCoder: () => true, core, pollMs: 5 });
    const { text, result } = await tracker.call({ concern: "how a works", wait: true }, undefined, ctx);
    expect(started[0].wait).toBe(true);
    expect(result).toMatchObject({ timedOut: false, scout: { state: "done" } });
    expect(text).toContain(REPORT);
    expect(await tracker.held(() => false)).toEqual([]);
  });

  test("a wait that ends first leaves the report to the turn end", async () => {
    const { core } = fakeCore("task", 1_000_000);
    const tracker = createScoutTracker({ isCoder: () => true, core, pollMs: 5, waitMs: 20 });
    const { text, result } = await tracker.call({ concern: "how a works", wait: true }, undefined, ctx);
    expect(result.timedOut).toBe(true);
    expect(text).toContain("the wait ended before the report");
    let stop = false;
    setTimeout(() => (stop = true), 30);
    expect(await tracker.held(() => stop)).toEqual([]);
  });

  test("the held turn end gives each of several scouts' reports once, when all ended", async () => {
    const { core } = fakeCore("task", 2);
    const tracker = createScoutTracker({ isCoder: () => true, core, pollMs: 5 });
    await tracker.call({ concern: "a" }, undefined, ctx);
    await tracker.call({ concern: "b" }, undefined, ctx);
    const reports = await tracker.held(() => false);
    expect(new Set(reports.map((report) => report.details.scout)).size).toBe(2);
    expect(await tracker.held(() => false)).toEqual([]);
  });
});

describe("a supervisor's scouts", () => {
  test("wait: false answers at once and owes the coder path nothing: the factory report delivers it", async () => {
    const { core } = fakeCore("session");
    const tracker = createScoutTracker({ isCoder: () => false, core, pollMs: 5 });
    const { text, result } = await tracker.call({ concern: "how a works" }, undefined, ctx);
    expect(text).toContain("arrives as a factory report");
    expect(await tracker.held(() => false)).toEqual([]);
    const notices = pendingNotices([], [], await readDelivered(), [view(result.scout.id, "session", "done")]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ key: scoutNoticeKey(result.scout.id), origin: "supervisor-session" });
    expect(notices[0].text).toContain(REPORT);
    expect(notices[0].text).toContain(`report: /scouts/${result.scout.id}/report.md`);
  });

  test("wait: true answers the report and claims its notice, so no factory report repeats it", async () => {
    const { core } = fakeCore("session");
    const tracker = createScoutTracker({ isCoder: () => false, core, pollMs: 5 });
    let waited: string[] = [];
    const call = tracker.call({ concern: "how a works", wait: true }, undefined, ctx);
    await Bun.sleep(1);
    waited = [...tracker.waiting];
    const { text, result } = await call;
    expect(waited).toEqual([result.scout.id]);
    expect(tracker.waiting.size).toBe(0);
    expect(text).toContain(REPORT);
    const delivered = await readDelivered();
    expect(delivered.has(scoutNoticeKey(result.scout.id))).toBe(true);
    expect(pendingNotices([], [], delivered, [view(result.scout.id, "session", "done")])).toEqual([]);
  });

  test("wait: true whose report a factory report delivered first does not give it again", async () => {
    const { core } = fakeCore("session", 3);
    const tracker = createScoutTracker({ isCoder: () => false, core, pollMs: 5 });
    const call = tracker.call({ concern: "how a works", wait: true }, undefined, ctx);
    await Bun.sleep(1);
    const [id] = [...tracker.waiting];
    await claimNotices([{ key: scoutNoticeKey(id), origin: "supervisor-session", text: "" }]);
    const { text } = await call;
    expect(text).toContain("its report arrived as a factory report");
    expect(text).not.toContain(REPORT);
  });
});

describe("registration", () => {
  const registered = () => {
    const tools: string[] = [];
    registerScoutTool({ registerTool: (tool: { name: string }) => tools.push(tool.name) } as unknown as ExtensionAPI, createScoutTracker({ isCoder: () => false }));
    return tools;
  };

  test("registers scout", () => {
    expect(registered()).toEqual([SCOUT_TOOL_NAME]);
  });

  test("a scout's own child gets no scout tool", () => {
    process.env[SCOUT_ID_ENV] = "some-scout";
    expect(registered()).toEqual([]);
  });
});
