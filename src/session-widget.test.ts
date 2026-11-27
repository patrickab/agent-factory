import { describe, expect, test } from "bun:test";
import { sessionWidget } from "./session-widget.ts";
import type { WaveView } from "./waves.ts";

let n = 0;
function wave(over: Partial<WaveView> = {}): WaveView {
  n += 1;
  return {
    id: `wave-${n}`,
    repo: "/home/me/git/app",
    tag: `t/w${n}`,
    plan: null,
    title: `wave ${n}`,
    request: "the request",
    branch: `master-t-w${n}`,
    after: [],
    target: "master",
    origin: "origin",
    createdAt: `2025-01-02T10:00:0${n % 10}.000Z`,
    stage: "building",
    reason: null,
    detail: null,
    running: true,
    interrupted: false,
    tasks: [],
    counts: { total: 3, done: 2 },
    reviews: [],
    gates: [],
    merge: null,
    usage: null,
    actions: [],
    ...over,
  };
}

const usage = (cost: number) => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost });
const tagsOf = (lines: string[]) => lines.map((line) => line.trim().split(/\s+/)[1]);

describe("sessionWidget", () => {
  test("no waves: no lines", () => {
    expect(sessionWidget([], { showFinished: false, width: 80 })).toEqual([]);
    expect(sessionWidget([], { showFinished: true, width: 80 })).toEqual([]);
  });

  test("the example: needs-you first, header with cost, finished closed", () => {
    const docs = wave({ tag: "docs/w1", title: "the docs cut down to what matters", stage: "rejected", running: false, counts: { total: 5, done: 5 }, usage: usage(5.8), createdAt: "2025-01-01T00:00:00.000Z" });
    const ui = wave({ tag: "ui/w1", title: "tool rows worth looking at", usage: usage(1.2), createdAt: "2025-01-03T00:00:00.000Z" });
    const done = Array.from({ length: 6 }, () => wave({ stage: "merged", running: false, usage: usage(1) }));
    const lines = sessionWidget([ui, ...done, docs], { showFinished: false, width: 64 });
    expect(lines[0]).toBe("Factory · 2 active · 1 needs you                           $7.00");
    expect(tagsOf(lines.slice(1, 3))).toEqual(["docs/w1", "ui/w1"]);
    expect(lines[1]!.startsWith(" ! docs/w1  ")).toBe(true);
    expect(lines[2]!.startsWith(" ◐ ui/w1    ")).toBe(true);
    expect(lines[1]!.endsWith("5/5 rejected  $5.80")).toBe(true);
    expect(lines[2]!.endsWith("2/3 building  $1.20")).toBe(true);
    expect(lines[3]).toBe(" 6 finished");
    for (const line of lines) expect(Array.from(line).length).toBeLessThanOrEqual(64);
  });

  test("order: every kind of needing the supervisor first, then newest first", () => {
    const at = (s: number) => `2025-01-02T10:00:${String(s).padStart(2, "0")}.000Z`;
    const waves = [
      wave({ tag: "old", createdAt: at(1) }),
      wave({ tag: "new", createdAt: at(9) }),
      wave({ tag: "rejected", stage: "rejected", running: false, createdAt: at(2) }),
      wave({ tag: "blocked", stage: "blocked", reason: "gates", running: false, createdAt: at(3) }),
      wave({ tag: "approve", stage: "waiting_approve", running: false, createdAt: at(4) }),
      wave({ tag: "interrupted", stage: "reviewing", running: false, interrupted: true, createdAt: at(5) }),
      wave({
        tag: "stuck",
        running: false,
        createdAt: at(6),
        tasks: [
          { key: "a", title: "a", after: [], taskId: "x", sessionId: null, state: "cancelled", usage: null, model: "big" },
          { key: "b", title: "b", after: ["a"], taskId: null, sessionId: null, state: "pending", usage: null, model: "big" },
        ] as WaveView["tasks"],
      }),
    ];
    const lines = sessionWidget(waves, { showFinished: false, width: 100 });
    expect(lines[0]).toStartWith("Factory · 7 active · 5 needs you");
    expect(tagsOf(lines.slice(1))).toEqual(["stuck", "interrupted", "approve", "blocked", "rejected", "new", "old"]);
    expect(lines.slice(1, 6).every((line) => line.startsWith(" ! "))).toBe(true);
    expect(lines.slice(6).every((line) => line.startsWith(" ◐ "))).toBe(true);
    expect(lines[1]).toContain(" stuck");
    expect(lines[2]).toContain(" interrupted");
  });

  test("header: no 'needs you' when none does, no cost without usage", () => {
    expect(sessionWidget([wave(), wave()], { showFinished: false, width: 80 })[0]).toBe("Factory · 2 active");
  });

  test("header with no active wave: the finished count, rows only when open", () => {
    const waves = [
      wave({ tag: "factory/w2", title: "agent view, notifications", stage: "cancelled", running: false, counts: { total: 12, done: 12 }, usage: usage(41.38), createdAt: "2025-01-01T00:00:00.000Z" }),
      wave({ tag: "factory/w4", title: "a merged wave names what", stage: "merged", running: false, counts: { total: 2, done: 2 }, usage: usage(0.51), createdAt: "2025-01-05T00:00:00.000Z" }),
    ];
    expect(sessionWidget(waves, { showFinished: false, width: 70 })).toEqual(["Factory · 2 finished"]);
    const open = sessionWidget(waves, { showFinished: true, width: 70 });
    expect(open[0]).toBe(`Factory · 2 finished${" ".repeat(70 - 20 - 6)}$41.89`);
    expect(tagsOf(open.slice(1))).toEqual(["factory/w4", "factory/w2"]);
    expect(open[1]).toStartWith(" ✓ factory/w4  a merged wave names what");
    expect(open[1]).toEndWith("2/2   merged      $0.51");
    expect(open[2]).toStartWith(" ✗ factory/w2  agent view, notifications");
    expect(open[2]).toEndWith("12/12 cancelled  $41.38");
  });

  test("finished open below the active ones: their count line carries their cost", () => {
    const waves = [wave({ tag: "a" }), wave({ tag: "m", stage: "merged", running: false, usage: usage(2) }), wave({ tag: "c", stage: "cancelled", running: false, usage: usage(1.5) })];
    const closed = sessionWidget(waves, { showFinished: false, width: 50 });
    expect(closed).toHaveLength(3);
    expect(closed[2]).toBe(" 2 finished");
    const open = sessionWidget(waves, { showFinished: true, width: 50 });
    expect(open).toHaveLength(5);
    expect(open[2]).toBe(` 2 finished${" ".repeat(50 - 11 - 5)}$3.50`);
    expect(tagsOf(open.slice(3))).toEqual(["c", "m"]);
  });

  test("truncation: the title gives way, no line exceeds the width", () => {
    const long = wave({ tag: "ui/w1", title: "a very long title that cannot fit into the narrow widget at all", usage: usage(1.2) });
    const lines = sessionWidget([long], { showFinished: false, width: 40 });
    expect(lines[1]).toBe(" ◐ ui/w1  a very l…  2/3 building  $1.20");
    for (const width of [10, 20, 30, 40, 80]) {
      for (const line of sessionWidget([long, wave({ stage: "merged", running: false })], { showFinished: true, width })) {
        expect(Array.from(line).length).toBeLessThanOrEqual(width);
      }
    }
  });

  test("unreachable tasks with a live runner: the wave needs the supervisor", () => {
    const tasks = [
      { key: "a", title: "a", after: [], taskId: "x", sessionId: null, state: "cancelled", usage: null, model: "big" },
      { key: "b", title: "b", after: ["a"], taskId: null, sessionId: null, state: "pending", usage: null, model: "big" },
    ] as WaveView["tasks"];
    const lines = sessionWidget([wave({ tag: "stuck", running: true, tasks })], { showFinished: false, width: 80 });
    expect(lines[0]).toBe("Factory · 1 active · 1 needs you");
    expect(lines[1]).toStartWith(" ! stuck");
    expect(lines[1]).toContain(" stuck");
  });

  test("queued: its stage while it can start, stuck and needing the supervisor once it never can", () => {
    const waiting = wave({ tag: "next", stage: "queued", after: ["wave-0"], running: false });
    const never = wave({ tag: "never", stage: "queued", after: ["wave-0"], running: false, detail: "it waits for wave t/w0 (wave-0), which was cancelled: it can never start" });
    const lines = sessionWidget([waiting, never], { showFinished: false, width: 80 });
    expect(lines[0]).toBe("Factory · 2 active · 1 needs you");
    expect(lines[1]).toStartWith(" ! never");
    expect(lines[1]).toContain(" stuck");
    expect(lines[2]).toStartWith(" ◐ next");
    expect(lines[2]).toContain(" queued");
  });

  test("tag and title scrubbed as in the agent view", () => {
    const lines = sessionWidget([wave({ tag: "t/w1", title: "fix /home/me/git/app/src/x.ts for 3f2a91c0-1111-4222-8333-444455556666" })], { showFinished: false, width: 120 });
    expect(lines[1]).not.toContain("/home/me");
    expect(lines[1]).not.toContain("1111-4222");
    expect(lines[1]).toContain("3f2a91c0");
  });
});
