import { expect, test } from "bun:test";
import type { TaskView } from "./core.ts";
import { pendingNotices, type NoticeWave } from "./notify.ts";
import type { WaveView } from "./waves.ts";
import { SESSION, TASK_ID, WAVE_ID, task as fixtureTask, wave as fixtureWave, waveTask } from "./view-fixtures.ts";

const task = (over: Partial<TaskView> = {}) => fixtureTask({ origin: SESSION, running: false, ...over });
const wave = (over: Partial<WaveView> = {}, events: { kind: string }[] = [{ kind: "tasks" }, { kind: "stage" }]): NoticeWave => ({ view: fixtureWave({ running: false, ...over }), events });
const none = new Set<string>();
const keys = (notices: { key: string }[]) => notices.map((notice) => notice.key);

test("each attention state of a task or wave is one notice to its origin, the request stays out; resting or origin-less ones say nothing", () => {
  const tasks: Partial<TaskView>[] = [{ state: "waiting_answer", question: "Which branch?" }, { state: "blocked" }, { state: "waiting_approve" }, { state: "running", interrupted: true }];
  for (const over of tasks) {
    const notices = pendingNotices([task(over)], [], none);
    expect(notices.map((notice) => notice.origin)).toEqual([SESSION]);
  }
  const waves: NoticeWave[] = [
    wave({ stage: "rejected" }),
    wave({ stage: "blocked", reason: "gates" }),
    wave({ stage: "waiting_approve" }),
    wave({ stage: "merged" }),
    wave({ stage: "reviewing", interrupted: true }),
    wave({ stuck: true, tasks: [waveTask("a", "cancelled"), waveTask("b", "pending", ["a"])] }),
  ];
  for (const input of waves) {
    const notices = pendingNotices([], [input], none);
    expect(notices.map((notice) => notice.origin)).toEqual([SESSION]);
    expect(notices[0].text).not.toContain("SECRET-REQUEST");
  }
  const silent = [
    ...[{ state: "running" as const }, { state: "blocked" as const, running: true }, { state: "done" as const }, { state: "cancelled" as const }, { state: "blocked" as const, origin: null }].map((over) => pendingNotices([task(over)], [], none)),
    ...[wave(), wave({ stage: "reviewing", running: true }), wave({ stage: "cancelled" }), wave({ stage: "queued", tasks: [] }), wave({ stage: "merged", origin: null })].map((input) => pendingNotices([], [input], none)),
  ];
  expect(silent.flat()).toEqual([]);
});

test("a delivered key is never delivered again; a new round or a new rejection is a new event", () => {
  const [notice] = pendingNotices([task({ state: "blocked" })], [], none);
  expect(pendingNotices([task({ state: "blocked" })], [], new Set([notice.key]))).toEqual([]);
  expect(pendingNotices([task({ state: "blocked", round: 2, at: "2025-01-02T11:00:00.000Z" })], [], new Set([notice.key]))).toHaveLength(1);
  const first = new Set(keys(pendingNotices([], [wave({ stage: "rejected" })], none)));
  expect(pendingNotices([], [wave({ stage: "rejected" })], first)).toEqual([]);
  const later = wave({ stage: "rejected" }, [{ kind: "tasks" }, { kind: "stage" }, { kind: "review" }, { kind: "stage" }]);
  expect(pendingNotices([], [later], first)).toHaveLength(1);
});

test("a wave's task speaks only while its wave builds", () => {
  const own = task({ state: "waiting_answer", wave: WAVE_ID });
  expect(pendingNotices([own], [wave()], none)).toHaveLength(1);
  expect(pendingNotices([task({ state: "blocked", wave: WAVE_ID })], [wave({ stage: "reviewing", running: true })], none)).toEqual([]);
  expect(keys(pendingNotices([task({ state: "blocked", wave: WAVE_ID })], [wave({ stage: "rejected" })], none))).toEqual(keys(pendingNotices([], [wave({ stage: "rejected" })], none)));
});

test("an interrupted wave is one notice for it and its interrupted tasks, also after a supervisor's update; a runner's event after it is a new one", () => {
  const tasks = [waveTask("a", "running", [], TASK_ID)];
  const interrupted = (events: { kind: string }[]) => wave({ interrupted: true, tasks }, events);
  const first = pendingNotices([task({ wave: WAVE_ID, interrupted: true })], [interrupted([{ kind: "tasks" }, { kind: "stage" }])], none);
  expect(first).toHaveLength(1);
  const delivered = new Set(keys(first));
  expect(pendingNotices([], [interrupted([{ kind: "tasks" }, { kind: "stage" }, { kind: "update" }])], delivered)).toEqual([]);
  expect(pendingNotices([], [interrupted([{ kind: "tasks" }, { kind: "stage" }, { kind: "update" }, { kind: "task" }])], delivered)).toHaveLength(1);
});
