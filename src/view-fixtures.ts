/** Fixture views for the tests of the agent view and the cards: one full view per action, as `callAction` answers it. */
import type { TaskView } from "./core.ts";
import type { WaveView } from "./waves.ts";
import type { ProofView } from "./gates-prove.ts";

export const TASK_ID = "4ae7325b-1111-4222-8333-944445555666";
export const WAVE_ID = "3f2a91c0-aaaa-4bbb-8ccc-dddddddddddd";
export const OTHER_WAVE = "77b0c2e1-0000-4000-8000-000000000000";
export const SESSION = "0197c0de-5555-7666-8777-888899990000";

export function task(over: Partial<TaskView> = {}): TaskView {
  return {
    id: TASK_ID,
    repo: "/home/me/git/app",
    worktree: "/home/me/git/worktrees/app/feat-x",
    branch: "feat-x",
    title: "feat(waves): declare a wave",
    createdAt: "2025-01-02T10:07:16.000Z",
    tag: "factory/w1",
    plan: "agent-factory/waves run/plan.md",
    wave: null,
    origin: null,
    sessionId: SESSION,
    sessionPath: `/home/me/.pi/agent/sessions/${SESSION}.jsonl`,
    state: "running",
    round: 1,
    reason: "start",
    at: "2025-01-02T10:09:00.000Z",
    question: null,
    running: true,
    interrupted: false,
    settings: { branch: "master", merge: "auto", maxRounds: 3, review: true, models: { coder: "anthropic/opus", reviewer: "openai/gpt" } },
    usage: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, cost: 2.1 },
    lastMessage: null,
    failure: null,
    review: null,
    merged: null,
    minors: [],
    flaky: [],
    actions: ["tasks.cancel", "tasks.message"],
    ...over,
  };
}

export type WaveTask = WaveView["tasks"][number];
export const waveTask = (key: string, state: string, after: string[] = [], taskId: string | null = `${key.padEnd(8, "0").slice(0, 8)}-1111-4222-8333-944445555666`): WaveTask => ({
  key,
  title: `the ${key}`,
  after,
  model: "big",
  taskId: state === "pending" ? null : taskId,
  sessionId: state === "pending" ? null : SESSION,
  state,
  usage: state === "pending" ? null : { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 1 },
  id: taskId ?? `${key.padEnd(8, "0").slice(0, 8)}-1111-4222-8333-944445555666`,
});

export function wave(over: Partial<WaveView> = {}): WaveView {
  return {
    id: WAVE_ID,
    repo: "/home/me/git/app",
    tag: "factory/w1",
    plan: null,
    title: "the wave mechanism",
    request: "Review the wave mechanism as a whole: SECRET-REQUEST",
    branch: "master-factory-w1",
    after: [],
    target: "master",
    origin: SESSION,
    createdAt: "2025-01-02T10:00:00.000Z",
    stage: "building",
    reason: null,
    detail: null,
    running: true,
    interrupted: false,
    stuck: false,
    attention: false,
    tasks: [waveTask("record", "done"), waveTask("actions", "running", ["record"]), waveTask("docs", "pending", ["actions"])],
    counts: { total: 3, done: 1 },
    reviews: [],
    gates: [],
    merge: null,
    minors: [],
    updates: [],
    usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, cost: 18.4 },
    actions: ["waves.add", "waves.cancel"],
    ...over,
  };
}

export const review = (verdict: "approved" | "rejected" | "failed", findings: WaveView["reviews"][number]["findings"] = []): WaveView["reviews"][number] => ({
  round: 2,
  at: "2025-01-02T11:00:00.000Z",
  sessionId: SESSION,
  model: "openai/gpt",
  verdict,
  status: verdict === "failed" ? "malformed" : "ok",
  findings,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.9 },
  wallMs: 360_000,
});

export const FINDINGS: WaveView["reviews"][number]["findings"] = [
  { severity: "major", file: "src/wave-runner.ts", line: 309, text: "A wave whose tasks can never start\nstays building forever." },
  { severity: "minor", file: "src/tasks.ts", line: null, text: "tasks.start can put a task onto a wave's branch." },
];

export const PROOF_ID = "9c1d2e3f-aaaa-4bbb-8ccc-dddddddddddd";

export function proof(over: Partial<ProofView> = {}): ProofView {
  return {
    id: PROOF_ID,
    repo: "/home/me/git/app",
    branch: "master",
    commit: "0ab12cd0ab12cd0ab12cd0ab12cd0ab12cd0ab12",
    origin: SESSION,
    createdAt: "2025-01-02T10:00:00.000Z",
    state: "failing",
    steps: [
      { command: "bun run types", passed: true, wallMs: 4000, flaky: [] },
      { command: "bun test", passed: false, wallMs: 60_000, flaky: [] },
    ],
    flaky: [],
    failing: { step: "bun test", tail: "(fail) the wave merges\n1 fail", log: "/home/me/.pi/agent/factory/proofs/x.failing.log" },
    endedAt: "2025-01-02T10:01:00.000Z",
    running: false,
    interrupted: false,
    ...over,
  };
}

export const SCOUT = {
  id: "5c0a1234-0000-4000-8000-000000000001",
  caller: { kind: "task", id: TASK_ID },
  repo: "/home/u/repo",
  concern: "how a.txt is made",
  questions: [],
  store: "team/plan",
  commit: "abc123",
  model: "a/b",
  createdAt: "2026-01-01T00:00:00.000Z",
  state: "done",
  error: null,
  running: false,
  interrupted: false,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.25 },
  report: "MISSING\n1. nothing\n\nDECISIONS\n- none\n\nKEY FACTS\n- a.txt:1 holds a\n\nMEMORY\n- map/a",
  reportPath: "/home/u/.pi/agent/factory/scouts/x/report.md",
  written: ["map/a"],
};

export const FIXTURES: Record<string, { params: unknown; result: unknown }> = {
  "models.get": { params: {}, result: { models: ["anthropic/opus", "openai/gpt"] } },
  "models.set": { params: { models: ["anthropic/opus"] }, result: { models: ["anthropic/opus"] } },
  "repos.list": { params: {}, result: { repos: ["/home/me/git/app", "/home/me/git/bot"] } },
  "repos.add": { params: { repo: "/home/me/git/app" }, result: { repo: "/home/me/git/app", repos: ["/home/me/git/app"] } },
  "branches.list": { params: { repo: "." }, result: { branches: [{ name: "master" }, { name: "waves" }] } },
  "settings.get": {
    params: { repo: "." },
    result: {
      stored: { merge: "review", models: { big: "anthropic/opus" } },
      resolved: {
        branch: "master",
        merge: "review",
        maxRounds: 3,
        review: true,
        models: { small: "anthropic/sonnet", big: "anthropic/opus", reviewer: "openai/gpt" },
        preview: false,
      },
      defaults: {
        branch: "master",
        merge: "auto",
        maxRounds: 3,
        review: true,
        models: { small: "anthropic/sonnet", big: "openai/gpt", reviewer: "openai/gpt" },
        preview: false,
      },
    },
  },
  "settings.set": {
    params: { repo: ".", settings: { merge: "review" } },
    result: { stored: { merge: "review" }, resolved: { branch: "master", merge: "review", maxRounds: 3 }, defaults: {} },
  },
  "config.get": { params: { repo: "." }, result: { exists: true, text: "gates:\n  - [bun, run, types]\n", draft: null, source: [] } },
  "config.write": { params: { repo: ".", text: "gates: []" }, result: { path: "/home/me/git/app/factory.yaml" } },
  "tasks.list": { params: {}, result: { tasks: [task(), task({ id: "7cf4e91e-0000-4000-8000-000000000000", state: "done", reason: "merged" })] } },
  "tasks.get": { params: { id: "4ae7" }, result: task() },
  "tasks.diff": {
    params: { id: "4ae7" },
    result: { base: "0ab12cd", diff: "diff --git a/src/x.ts b/src/x.ts\n+secret patch", files: [{ path: "src/x.ts", added: 10, removed: 2 }, { path: "src/x.test.ts", added: 30, removed: 0 }] },
  },
  "tasks.start": { params: { repo: ".", title: "t", request: "SECRET-REQUEST" }, result: task({ round: 0 }) },
  "tasks.wait": { params: { tag: "factory" }, result: { tasks: [task({ state: "done", reason: "merged", running: false })], waves: [wave({ stage: "merged", running: false })], attention: [], timedOut: false } },
  "tasks.approve": { params: { id: "4ae7" }, result: task({ state: "merging" }) },
  "tasks.retry": { params: { id: "4ae7" }, result: task({ round: 3 }) },
  "tasks.cancel": { params: { id: "4ae7" }, result: task({ state: "cancelled", running: false, reason: "cancelled" }) },
  "tasks.remove": { params: { id: "4ae7" }, result: { removed: TASK_ID, dropped: "1 unmerged commit" } },
  "tasks.message": { params: { id: "4ae7", text: "SECRET-REQUEST" }, result: task() },
  "waves.start": { params: { repo: ".", tag: "factory/w1", title: "t", request: "SECRET-REQUEST", tasks: [] }, result: { wave: wave() } },
  "waves.add": { params: { id: "3f2a", tasks: [{ key: "fix", title: "fix", request: "SECRET-REQUEST" }] }, result: { wave: wave({ tasks: [...wave().tasks, waveTask("fix", "running")] }) } },
  "waves.get": { params: { id: "3f2a" }, result: { wave: wave() } },
  "waves.list": { params: {}, result: { waves: [wave(), wave({ id: "77b0c2e1-0000-4000-8000-000000000000", stage: "merged" })] } },
  "waves.retry": { params: { id: "3f2a" }, result: { wave: wave({ stage: "reviewing" }) } },
  "waves.approve": { params: { id: "3f2a" }, result: { wave: wave({ stage: "merging" }) } },
  "waves.cancel": { params: { id: "3f2a" }, result: { wave: wave({ stage: "cancelled", running: false }) } },
  "waves.remove": { params: { id: "3f2a" }, result: { removed: WAVE_ID } },
  "scouts.start": { params: { concern: "how a.txt is made", wait: true }, result: { scout: SCOUT, timedOut: false } },
  "scouts.get": { params: { id: "5c0a" }, result: { scout: { ...SCOUT, state: "running", report: null, reportPath: null, written: ["map/a"] } } },
  "gates.prove": { params: { repo: "." }, result: { proof: proof({ state: "running", running: true, failing: null, steps: [], flaky: [], endedAt: null }) } },
  "contracts.apply": {
    params: { store: "team/plan", name: "api", op: { op: "update", path: "answer", text: "t" } },
    result: {
      store: "team/plan",
      name: "api",
      changed: ["run/contract/api/answer"],
      notified: [{ wave: WAVE_ID, tag: "factory/w1", key: "record", task: "4ae7325b-1111-4000-8000-000000000000" }],
      kept: [],
      done: [{ wave: WAVE_ID, tag: "factory/w1", key: "docs", task: "4ae7325b-2222-4000-8000-000000000000" }],
    },
  },
  "tasks.update": { params: { id: "4ae7325b", request: "SECRET-REQUEST" }, result: { wave: wave(), key: "docs", changed: true, delivery: "pending" } },
  "waves.update": { params: { id: WAVE_ID, request: "SECRET-REQUEST" }, result: { wave: wave(), changed: true } },
  "decisions.list": {
    params: {},
    result: {
      decisions: [
        { at: "2025-01-02T10:10:00.000Z", key: "call-1", answers: `task:${TASK_ID}:waiting_answer:1@2025-01-02T10:09:00.000Z`, card: { v: 1, kind: "decision", tone: "quiet", title: "sent to task 4ae7325b" } },
        { at: "2025-01-02T10:11:00.000Z", card: { v: 1, kind: "decision", tone: "quiet", title: "updated wave factory/w1" } },
      ],
    },
  },
};
