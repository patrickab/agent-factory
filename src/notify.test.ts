import { describe, expect, test } from "bun:test";
import type { TaskView } from "./core.ts";
import { pendingNotices, type NoticeWave } from "./notify.ts";
import type { WaveView } from "./waves.ts";

const TASK_ID = "4ae7325b-1111-4222-8333-944445555666";
const WAVE_ID = "3f2a91c0-aaaa-4bbb-8ccc-dddddddddddd";
const ORIGIN = "0197c0de-5555-7666-8777-888899990000";

function task(over: Partial<TaskView> = {}): TaskView {
  return {
    id: TASK_ID,
    repo: "/home/me/git/app",
    worktree: "/home/me/git/worktrees/app/feat-x",
    branch: "feat-x",
    title: "feat: x",
    createdAt: "2025-01-02T10:07:16.000Z",
    tag: "factory/w1",
    plan: null,
    wave: null,
    origin: ORIGIN,
    sessionId: "s",
    sessionPath: null,
    state: "running",
    round: 1,
    reason: "start",
    at: "2025-01-02T10:09:00.000Z",
    question: null,
    running: false,
    interrupted: false,
    settings: null,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 2.1 },
    lastMessage: null,
    failure: null,
    review: null,
    merged: null,
    flaky: [],
    actions: ["tasks.cancel"],
    ...over,
  };
}

function wave(over: Partial<WaveView> = {}, stuck = false, events: { kind: string }[] = [{ kind: "tasks" }, { kind: "stage" }]): NoticeWave {
  const view: WaveView = {
    id: WAVE_ID,
    repo: "/home/me/git/app",
    tag: "factory/w1",
    plan: null,
    title: "the wave",
    request: "SECRET-REQUEST",
    branch: "master-factory-w1",
    after: [],
    target: "master",
    base: "0ab12cd",
    origin: ORIGIN,
    createdAt: "2025-01-02T10:00:00.000Z",
    stage: "building",
    reason: null,
    detail: null,
    running: false,
    interrupted: false,
    tasks: [],
    counts: { total: 0, done: 0 },
    reviews: [],
    gates: [],
    merge: null,
    remote: null,
    usage: null,
    actions: ["waves.add", "waves.cancel"],
    ...over,
  };
  return { view, stuck, events };
}

const none = new Set<string>();

describe("pendingNotices: tasks", () => {
  test("each attention state yields one notice with the origin, the what and the task's block", () => {
    const cases: [Partial<TaskView>, string, string][] = [
      [{ state: "waiting_answer", question: "Which branch?", actions: ["tasks.message"] }, "waiting_answer", "factory: a coder asks"],
      [{ state: "blocked", reason: "gates_failed" }, "blocked", "factory: task 4ae7325b is blocked"],
      [{ state: "waiting_approve" }, "waiting_approve", "factory: task 4ae7325b waits for tasks.approve"],
      [{ state: "running", interrupted: true }, "interrupted", "factory: task 4ae7325b was interrupted"],
    ];
    for (const [over, event, first] of cases) {
      const notices = pendingNotices([task(over)], [], none);
      expect(notices).toHaveLength(1);
      expect(notices[0].key).toBe(`task:${TASK_ID}:${event}:1@2025-01-02T10:09:00.000Z`);
      expect(notices[0].origin).toBe(ORIGIN);
      const [line1, line2] = notices[0].text.split("\n");
      expect(line1).toBe(first);
      expect(line2).toStartWith("task 4ae7325b");
    }
    expect(pendingNotices([task({ state: "waiting_answer", question: "Which branch?" })], [], none)[0].text).toContain("question: Which branch?");
  });

  test("no notice for a running, done or cancelled task, nor one without origin", () => {
    for (const over of [{ state: "running" as const }, { state: "blocked" as const, running: true }, { state: "done" as const }, { state: "cancelled" as const }, { state: null }, { state: "blocked" as const, origin: null }]) {
      expect(pendingNotices([task(over)], [], none)).toEqual([]);
    }
  });

  test("a delivered key is not delivered again; a new round is a new event", () => {
    const [notice] = pendingNotices([task({ state: "blocked" })], [], none);
    expect(pendingNotices([task({ state: "blocked" })], [], new Set([notice.key]))).toEqual([]);
    expect(pendingNotices([task({ state: "blocked", round: 2, at: "2025-01-02T11:00:00.000Z" })], [], new Set([notice.key]))).toHaveLength(1);
  });

  test("a wave's task speaks only while its wave builds", () => {
    const own = task({ state: "waiting_answer", wave: WAVE_ID });
    expect(pendingNotices([own], [wave()], none).map((notice) => notice.key)).toEqual([`task:${TASK_ID}:waiting_answer:1@2025-01-02T10:09:00.000Z`]);
    expect(pendingNotices([task({ state: "blocked", wave: WAVE_ID })], [wave({ stage: "reviewing", running: true })], none)).toEqual([]);
    const rejected = pendingNotices([task({ state: "blocked", wave: WAVE_ID })], [wave({ stage: "rejected" })], none);
    expect(rejected.map((notice) => notice.key)).toEqual([`wave:${WAVE_ID}:rejected:1`]);
    expect(pendingNotices([own], [], none)).toEqual([]);
  });
});

const stuckTasks: WaveView["tasks"] = [
  { key: "a", title: "a", after: [], model: "big", taskId: null, sessionId: null, state: "cancelled", usage: null },
  { key: "b", title: "b", after: ["a"], model: "big", taskId: null, sessionId: null, state: "pending", usage: null },
  { key: "c", title: "c", after: ["b"], model: "big", taskId: null, sessionId: null, state: "pending", usage: null },
];

describe("pendingNotices: waves", () => {
  const finding = { severity: "major" as const, file: "src/a.ts", line: 12, text: "the lock leaks" };
  const rejectedReview = { round: 2, at: "x", sessionId: null, model: null, verdict: "rejected" as const, status: "ok", findings: [finding], usage: null, wallMs: 1 };

  test("each event yields one notice with the origin and the wave's block", () => {
    const cases: [NoticeWave, string, string][] = [
      [wave({ stage: "rejected", reviews: [rejectedReview], actions: ["waves.add", "waves.cancel"] }), "rejected:1", "factory: wave factory/w1 was rejected"],
      [wave({ stage: "blocked", reason: "gates" }), "blocked:1", "factory: wave factory/w1 is blocked"],
      [wave({ stage: "waiting_approve" }), "waiting_approve:1", "factory: wave factory/w1 waits for waves.approve"],
      [wave({ stage: "merged" }), "merged:1", "factory: wave factory/w1 was merged"],
      [wave({ stage: "reviewing", interrupted: true }), "interrupted:2", "factory: wave factory/w1 was interrupted"],
      [wave({ stage: "building", tasks: stuckTasks }, true), "unreachable:b,c", "factory: wave factory/w1 has tasks that can never start"],
    ];
    for (const [input, key, first] of cases) {
      const notices = pendingNotices([], [input], none);
      expect(notices).toHaveLength(1);
      expect(notices[0].key).toBe(`wave:${WAVE_ID}:${key}`);
      expect(notices[0].origin).toBe(ORIGIN);
      expect(notices[0].text.split("\n")[0]).toBe(first);
      expect(notices[0].text.split("\n")[1]).toStartWith("wave 3f2a91c0");
      expect(notices[0].text).not.toContain("SECRET-REQUEST");
    }
  });

  test("a merged wave carries the minors of its last review, with the same key", () => {
    const minors = [
      { severity: "minor" as const, file: "src/a.ts", line: 3, text: "rename x" },
      { severity: "minor" as const, file: "src/b.ts", line: null, text: "doc it" },
    ];
    const approved = { ...rejectedReview, verdict: "approved" as const, findings: minors };
    const [plain] = pendingNotices([], [wave({ stage: "merged" })], none);
    const [notice] = pendingNotices([], [wave({ stage: "merged", reviews: [approved] })], none);
    expect(notice.key).toBe(plain.key);
    expect(notice.text).toContain("minor  src/a.ts:3  rename x");
    expect(notice.text).toContain("minor  src/b.ts  doc it");
    expect(plain.text).not.toContain("minor");
  });

  test("a rejection carries its findings", () => {
    const [notice] = pendingNotices([], [wave({ stage: "rejected", reviews: [rejectedReview] })], none);
    expect(notice.text).toContain("major  src/a.ts:12  the lock leaks");
    expect(notice.text).toContain("next: waves.add, waves.cancel");
  });

  test("no notice while it builds, reviews, merges or after a cancel, nor without origin", () => {
    for (const input of [wave(), wave({ stage: "reviewing", running: true }), wave({ stage: "merging", running: true }), wave({ stage: "cancelled" }), wave({ stage: "merged", origin: null })]) {
      expect(pendingNotices([], [input], none)).toEqual([]);
    }
  });

  test("tasks that can never start are one event, also once the runner's stage event naming them lands", () => {
    const before = wave({ stage: "building", tasks: stuckTasks }, true);
    const after = wave({ stage: "building", tasks: stuckTasks }, true, [{ kind: "tasks" }, { kind: "stage" }, { kind: "stage" }]);
    const delivered = new Set(pendingNotices([], [before], none).map((notice) => notice.key));
    expect(delivered.size).toBe(1);
    expect(pendingNotices([], [after], delivered)).toEqual([]);
  });

  test("a queued wave says nothing; one that can never start is one event, before and after its stage event lands", () => {
    const named = "77b0c2e1-0000-4000-8000-000000000000";
    const queued = { stage: "queued" as const, after: [named], running: false, tasks: [] };
    expect(pendingNotices([], [wave(queued)], none)).toEqual([]);
    const why = "it waits for wave factory/w0 (77b0c2e1), which was cancelled: it can never start; waves.cancel or waves.remove it";
    const judged = wave(queued, true);
    const recorded = wave({ ...queued, detail: why }, true, [{ kind: "tasks" }, { kind: "stage" }]);
    const notices = pendingNotices([], [judged], none);
    expect(notices.map((notice) => notice.key)).toEqual([`wave:${WAVE_ID}:never:${named}`]);
    expect(notices[0].text.split("\n")[0]).toBe("factory: wave factory/w1 can never start");
    expect(notices[0].text.split("\n")[1]).toStartWith("wave 3f2a91c0  queued");
    expect(pendingNotices([], [recorded], new Set(notices.map((notice) => notice.key)))).toEqual([]);
    expect(pendingNotices([], [recorded], none).map((notice) => notice.key)).toEqual([`wave:${WAVE_ID}:never:${named}`]);
  });

  test("a second rejection after a new stage event is a new event", () => {
    const first = pendingNotices([], [wave({ stage: "rejected" })], none);
    const later = wave({ stage: "rejected" }, false, [{ kind: "tasks" }, { kind: "stage" }, { kind: "tasks" }, { kind: "stage" }, { kind: "review" }, { kind: "stage" }]);
    expect(pendingNotices([], [wave({ stage: "rejected" })], new Set(first.map((notice) => notice.key)))).toEqual([]);
    expect(pendingNotices([], [later], new Set(first.map((notice) => notice.key))).map((notice) => notice.key)).toEqual([`wave:${WAVE_ID}:rejected:5`]);
  });

  test("an interrupted wave stays one event while the supervisor updates it or a contract changes; a runner's event after it is a new one", () => {
    const interrupted = (events: ({ kind: string } & Record<string, unknown>)[]) => wave({ stage: "building", interrupted: true }, false, events);
    const first = pendingNotices([], [interrupted([{ kind: "tasks" }, { kind: "stage" }])], none);
    const delivered = new Set(first.map((notice) => notice.key));
    expect([...delivered]).toEqual([`wave:${WAVE_ID}:interrupted:2`]);
    const told = interrupted([{ kind: "tasks" }, { kind: "stage" }, { kind: "update" }, { kind: "contract", name: "api", paths: ["run/contract/api/a"], done: [] }, { kind: "update" }]);
    expect(pendingNotices([], [told], delivered).filter((notice) => notice.key.includes(":interrupted:"))).toEqual([]);
    const resumed = interrupted([{ kind: "tasks" }, { kind: "stage" }, { kind: "update" }, { kind: "task" }]);
    expect(pendingNotices([], [resumed], delivered).map((notice) => notice.key)).toEqual([`wave:${WAVE_ID}:interrupted:4`]);
  });
});

describe("pendingNotices: order", () => {
  test("waves, tasks, then the features' in the features' order: gate proofs before scouts (since the feature registry)", () => {
    const proof = { id: "9c1d0000-0000-4000-8000-000000000000", origin: ORIGIN, state: "passed", interrupted: false, branch: "main", commit: "0ab12cd", failing: null, steps: [], flaky: [] };
    const scout = { id: "5c0a0000-0000-4000-8000-000000000000", caller: { kind: "session", id: ORIGIN }, state: "done", interrupted: false, reportPath: null, usage: null, error: null, concern: "c", report: "r", written: [] };
    const notices = pendingNotices([task({ state: "blocked", reason: "gates_failed" })], [wave({ stage: "merged" })], none, { scouts: [scout], gates: [proof] });
    expect(notices.map((notice) => notice.key.split(":")[0])).toEqual(["wave", "task", "proof", "scout"]);
  });
});
