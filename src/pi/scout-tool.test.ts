/**
 * The `scout` tool against a fake core (no scout child runs): a report reaches a coder or a supervisor exactly once.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readDelivered } from "../notified.ts";
import { pendingNotices, scoutNoticeKey } from "../notify.ts";
import type { ScoutView } from "../scouts.ts";
import { createScoutTracker, type ScoutCore } from "./scout-tool.ts";

let counter = 0;
beforeEach(() => {
  counter += 1;
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "factory-scout-tool-test-"));
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
  test("a report arrives once: held until the turn end, or answered by a wait and not repeated", async () => {
    const { core } = fakeCore("task", 3);
    const tracker = createScoutTracker({ isCoder: () => true, core, pollMs: 5 });
    const { result } = await tracker.call({ concern: "how a works" }, undefined, ctx);
    const reports = await tracker.held(() => false);
    expect(reports.map((report) => report.details.scout)).toEqual([result.scout.id]);
    expect(reports[0].content).toContain("KEY FACTS");
    expect(await tracker.held(() => false)).toEqual([]);
    const waited = await tracker.call({ concern: "how a works", wait: true }, undefined, ctx);
    expect(waited.text).toContain(REPORT);
    expect(await tracker.held(() => false)).toEqual([]);
  });
});

describe("a supervisor's scouts", () => {
  test("wait: false answers at once and owes the coder path nothing: the factory report delivers it", async () => {
    const { core } = fakeCore("session");
    const tracker = createScoutTracker({ isCoder: () => false, core, pollMs: 5 });
    const { result } = await tracker.call({ concern: "how a works" }, undefined, ctx);
    expect(await tracker.held(() => false)).toEqual([]);
    const notices = pendingNotices([], [], await readDelivered(), { scouts: [view(result.scout.id, "session", "done")] });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ key: scoutNoticeKey(result.scout.id), origin: "supervisor-session" });
    expect(notices[0].text).toContain(REPORT);
  });

  test("wait: true answers the report and claims its notice, so no factory report repeats it", async () => {
    const { core } = fakeCore("session");
    const tracker = createScoutTracker({ isCoder: () => false, core, pollMs: 5 });
    const { text, result } = await tracker.call({ concern: "how a works", wait: true }, undefined, ctx);
    expect(text).toContain(REPORT);
    const delivered = await readDelivered();
    expect(delivered.has(scoutNoticeKey(result.scout.id))).toBe(true);
    expect(pendingNotices([], [], delivered, { scouts: [view(result.scout.id, "session", "done")] })).toEqual([]);
  });
});
