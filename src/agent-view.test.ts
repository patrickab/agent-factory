import { describe, expect, test } from "bun:test";
import { agentActions, agentError, agentView, taskBlock, unreachableTasks, waveBlock } from "./agent-view.ts";
import { ACTIONS, type TaskView } from "./core.ts";
import type { WaveView } from "./waves.ts";

const TASK_ID = "4ae7325b-1111-4222-8333-944445555666";
const WAVE_ID = "3f2a91c0-aaaa-4bbb-8ccc-dddddddddddd";
const SESSION = "0197c0de-5555-7666-8777-888899990000";

function task(over: Partial<TaskView> = {}): TaskView {
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
    usage: { input: 1200, output: 300, cost: 2.1 },
    lastMessage: null,
    failure: null,
    review: null,
    merged: null,
    actions: ["tasks.cancel", "tasks.message"],
    ...over,
  };
}

type WaveTask = WaveView["tasks"][number];
const waveTask = (key: string, state: string, after: string[] = [], taskId: string | null = `${key.padEnd(8, "0").slice(0, 8)}-1111-4222-8333-944445555666`): WaveTask => ({
  key,
  title: `the ${key}`,
  after,
  model: "big",
  taskId: state === "pending" ? null : taskId,
  sessionId: state === "pending" ? null : SESSION,
  state,
  usage: state === "pending" ? null : { input: 1, output: 1, cost: 1 },
});

function wave(over: Partial<WaveView> = {}): WaveView {
  return {
    id: WAVE_ID,
    repo: "/home/me/git/app",
    tag: "factory/w1",
    plan: null,
    title: "the wave mechanism",
    request: "Review the wave mechanism as a whole: SECRET-REQUEST",
    branch: "master-factory-w1",
    target: "master",
    base: "0ab12cd0ab12cd0ab12cd0ab12cd0ab12cd0ab12",
    origin: SESSION,
    createdAt: "2025-01-02T10:00:00.000Z",
    stage: "building",
    reason: null,
    detail: null,
    running: true,
    interrupted: false,
    tasks: [waveTask("record", "done"), waveTask("actions", "running", ["record"]), waveTask("docs", "pending", ["actions"])],
    counts: { total: 3, done: 1 },
    reviews: [],
    gates: [],
    merge: null,
    remote: null,
    usage: { input: 10, output: 10, cost: 18.4 },
    actions: ["waves.add", "waves.cancel"],
    ...over,
  };
}

const review = (verdict: "approved" | "rejected" | "failed", findings: WaveView["reviews"][number]["findings"] = []): WaveView["reviews"][number] => ({
  round: 2,
  at: "2025-01-02T11:00:00.000Z",
  sessionId: SESSION,
  model: "openai/gpt",
  verdict,
  status: verdict === "failed" ? "malformed" : "ok",
  findings,
  usage: { input: 1, output: 1, cost: 0.9 },
  wallMs: 360_000,
});

const FINDINGS: WaveView["reviews"][number]["findings"] = [
  { severity: "major", file: "src/wave-runner.ts", line: 309, text: "A wave whose tasks can never start\nstays building forever." },
  { severity: "minor", file: "src/tasks.ts", line: null, text: "tasks.import can put a task into a wave." },
];

/** One full view per action, as `callAction` answers it. */
const FIXTURES: Record<string, { params: unknown; result: unknown }> = {
  "models.get": { params: {}, result: { models: ["anthropic/opus", "openai/gpt"] } },
  "models.set": { params: { models: ["anthropic/opus"] }, result: { models: ["anthropic/opus"] } },
  "repos.list": { params: {}, result: { repos: ["/home/me/git/app", "/home/me/git/bot"] } },
  "repos.add": { params: { repo: "/home/me/git/app" }, result: { repo: "/home/me/git/app", repos: ["/home/me/git/app"] } },
  "repos.remove": { params: { repo: "/home/me/git/app" }, result: { repos: [] } },
  "branches.list": {
    params: { repo: "." },
    result: {
      branches: [
        { name: "master", default: true, hasConfig: false },
        { name: "waves", default: false, hasConfig: true },
      ],
    },
  },
  "settings.get": {
    params: { repo: "." },
    result: {
      stored: { merge: "review", models: { coder: "anthropic/opus", big: "anthropic/opus" } },
      resolved: {
        branch: "master",
        merge: "review",
        maxRounds: 3,
        review: true,
        models: { small: "anthropic/sonnet", big: "anthropic/opus", coder: "anthropic/opus", reviewer: "openai/gpt" },
        preview: false,
      },
      defaults: {
        branch: "master",
        merge: "auto",
        maxRounds: 3,
        review: true,
        models: { small: "anthropic/sonnet", big: "openai/gpt", coder: "openai/gpt", reviewer: "openai/gpt" },
        preview: false,
      },
    },
  },
  "settings.set": {
    params: { repo: ".", settings: { merge: "review" } },
    result: { stored: { merge: "review" }, resolved: { branch: "master", merge: "review", maxRounds: 3 }, defaults: {} },
  },
  "config.get": { params: { repo: ".", branch: "waves" }, result: { exists: true, text: "gates:\n  - [bun, run, types]\n", draft: null, source: [] } },
  "config.write": { params: { repo: ".", text: "gates: []" }, result: { path: "/home/me/git/app/factory.yaml" } },
  "tasks.list": { params: {}, result: { tasks: [task(), task({ id: "7cf4e91e-0000-4000-8000-000000000000", state: "done", reason: "merged" })] } },
  "tasks.get": { params: { id: "4ae7" }, result: task() },
  "tasks.import": { params: { record: {} }, result: task() },
  "tasks.timeline": {
    params: { id: "4ae7" },
    result: {
      entries: [
        { at: "2025-01-02T10:07:16.000Z", kind: "gate", data: { name: "types", passed: true, sessionPath: "/home/me/x.jsonl", at: "2025-01-02T10:07:16.000Z" } },
        { at: "2025-01-02T10:08:00.000Z", kind: "coder", data: { text: `Done. Session ${SESSION} wrote /home/me/git/app/src/x.ts\nmore` } },
      ],
      next: 4096,
    },
  },
  "tasks.diff": {
    params: { id: "4ae7" },
    result: {
      base: "0ab12cd",
      diff: "diff --git a/src/x.ts b/src/x.ts\n+secret patch",
      files: [
        { path: "src/x.ts", added: 10, removed: 2 },
        { path: "src/x.test.ts", added: 30, removed: 0 },
      ],
    },
  },
  "tasks.start": { params: { repo: ".", title: "t", request: "SECRET-REQUEST" }, result: task({ round: 0 }) },
  "tasks.wait": { params: { tag: "factory" }, result: { tasks: [task({ state: "done", reason: "merged", running: false })], waves: [wave({ stage: "merged", running: false })], attention: [], timedOut: false } },
  "tasks.approve": { params: { id: "4ae7" }, result: task({ state: "merging" }) },
  "tasks.retry": { params: { id: "4ae7" }, result: task({ round: 3 }) },
  "tasks.cancel": { params: { id: "4ae7" }, result: task({ state: "cancelled", running: false, reason: "cancelled" }) },
  "tasks.remove": { params: { id: "4ae7" }, result: { removed: TASK_ID, dropped: "1 unmerged commit" } },
  "tasks.message": { params: { id: "4ae7", text: "go on" }, result: task() },
  "waves.start": { params: { repo: ".", tag: "factory/w1", title: "t", request: "SECRET-REQUEST", tasks: [] }, result: { wave: wave() } },
  "waves.add": { params: { id: "3f2a", tasks: [{ key: "fix", title: "fix", request: "SECRET-REQUEST" }] }, result: { wave: wave({ tasks: [...wave().tasks, waveTask("fix", "running")] }) } },
  "waves.get": { params: { id: "3f2a" }, result: { wave: wave() } },
  "waves.list": { params: {}, result: { waves: [wave(), wave({ id: "77b0c2e1-0000-4000-8000-000000000000", stage: "merged" })] } },
  "waves.timeline": {
    params: { id: "3f2a" },
    result: {
      events: [
        { at: "2025-01-02T10:00:00.000Z", kind: "task", key: "record", taskId: TASK_ID, sessionId: SESSION },
        { at: "2025-01-02T10:30:00.000Z", kind: "stage", stage: "reviewing", reason: null },
      ],
      next: 2,
    },
  },
  "waves.retry": { params: { id: "3f2a" }, result: { wave: wave({ stage: "reviewing" }) } },
  "waves.approve": { params: { id: "3f2a" }, result: { wave: wave({ stage: "merging" }) } },
  "waves.cancel": { params: { id: "3f2a" }, result: { wave: wave({ stage: "cancelled", running: false }) } },
  "waves.remove": { params: { id: "3f2a" }, result: { removed: WAVE_ID } },
};

const FORBIDDEN = [/\/home/, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, new RegExp(SESSION.slice(0, 13)), /SECRET-REQUEST/, /secret patch/];

function clean(text: string): void {
  for (const pattern of FORBIDDEN) expect(text).not.toMatch(pattern);
}

describe("agentView", () => {
  test("every action in ACTIONS has a rendering", () => {
    for (const name of Object.keys(ACTIONS)) {
      const fixture = FIXTURES[name];
      expect(fixture, `fixture for ${name}`).toBeDefined();
      const text = agentView(name, fixture.params, fixture.result);
      expect(text.length, name).toBeGreaterThan(0);
    }
  });

  test("no rendering of the fixtures holds a path, a timestamp, a session id, the request or the patch", () => {
    for (const [name, fixture] of Object.entries(FIXTURES)) clean(agentView(name, fixture.params, fixture.result));
  });

  test("a task's settings never show", () => {
    const text = agentView("tasks.get", {}, task());
    expect(text).not.toContain("anthropic/opus");
    expect(text).not.toContain("maxRounds");
  });

  test("an unknown action throws", () => {
    expect(() => agentView("tasks.nope", {}, {})).toThrow("no agent view for tasks.nope");
  });

  test("receipts of mutations are one line", () => {
    for (const name of Object.keys(ACTIONS).filter((action) => ACTIONS[action as keyof typeof ACTIONS].mutates && !["settings.set"].includes(action))) {
      const fixture = FIXTURES[name];
      expect(agentView(name, fixture.params, fixture.result).split("\n").length, name).toBe(1);
    }
    expect(agentView("tasks.start", {}, task({ round: 0 }))).toBe("started task 4ae7325b  running  factory/w1");
    expect(agentView("tasks.retry", {}, task({ round: 3 }))).toBe("task 4ae7325b  running  round 3  factory/w1  $2.10");
    expect(agentView("tasks.remove", {}, FIXTURES["tasks.remove"].result)).toBe("removed task 4ae7325b · dropped: 1 unmerged commit");
    expect(agentView("waves.start", {}, { wave: wave() })).toBe(
      "started wave 3f2a91c0  building  1/3 done  factory/w1 · started: record, actions · waits: docs (actions)",
    );
    expect(agentView("waves.add", FIXTURES["waves.add"].params, FIXTURES["waves.add"].result)).toBe("wave 3f2a91c0  building  1/3 done  factory/w1 · added: fix running");
    expect(agentView("waves.remove", {}, { removed: WAVE_ID })).toBe("removed wave 3f2a91c0");
  });

  test("tasks.diff: the file list with counts, never the patch", () => {
    expect(agentView("tasks.diff", {}, FIXTURES["tasks.diff"].result)).toBe("2 files  +40 -2\n  +10 -2  src/x.ts\n  +30 -0  src/x.test.ts");
    expect(agentView("tasks.diff", {}, { base: "x", diff: "", files: [] })).toBe("no changes");
  });

  test("lists show what is not finished and count the rest", () => {
    expect(agentView("tasks.list", {}, FIXTURES["tasks.list"].result)).toBe(
      "task 4ae7325b  running  round 1  factory/w1  $2.10  feat(waves): declare a wave\n1 finished, not shown",
    );
    expect(agentView("tasks.list", {}, { tasks: [task({ state: "done" })] })).toBe("no unfinished tasks, 1 finished");
    expect(agentView("tasks.list", {}, { tasks: [] })).toBe("no tasks");
    expect(agentView("waves.list", {}, FIXTURES["waves.list"].result)).toBe(
      "wave 3f2a91c0  building  1/3 done  factory/w1  $18.40  the wave mechanism\n1 merged or cancelled, not shown",
    );
  });

  test("repositories, branches, settings, config", () => {
    expect(agentView("repos.list", {}, FIXTURES["repos.list"].result)).toBe("~/git/app\n~/git/bot");
    expect(agentView("branches.list", {}, FIXTURES["branches.list"].result)).toBe("master (default) · waves (factory.yaml)");
    expect(agentView("settings.get", {}, FIXTURES["settings.get"].result)).toBe(
      [
        "branch: master (default)",
        "merge: review",
        "maxRounds: 3 (default)",
        "review: true (default)",
        "models.small: anthropic/sonnet (default)",
        "models.coder: anthropic/opus",
        "models.reviewer: openai/gpt (default)",
        "preview: false (default)",
      ].join("\n"),
    );
    // big only repeats coder (its alias): not shown; a reviewer equal to coder is its own setting and shown.
    const same = { stored: {}, resolved: { models: { small: "a/s", big: "a/b", coder: "a/b", reviewer: "a/b" } }, defaults: {} };
    expect(agentView("settings.get", {}, same)).toBe("models.small: a/s (default)\nmodels.coder: a/b (default)\nmodels.reviewer: a/b (default)");
    expect(agentView("settings.set", FIXTURES["settings.set"].params, FIXTURES["settings.set"].result)).toBe("settings set:\n  merge: review");
    expect(agentView("config.get", { branch: "waves" }, FIXTURES["config.get"].result)).toBe("factory.yaml (committed on waves)\ngates:\n  - [bun, run, types]");
    expect(agentView("config.get", {}, { exists: false, text: null, draft: "gates: []\n", source: ["package.json"] })).toBe("no factory.yaml, a draft from package.json:\ngates: []");
  });
});

describe("taskBlock per state", () => {
  const cases: [string, Partial<TaskView>, string[]][] = [
    ["running", {}, ["task 4ae7325b  running  round 1  factory/w1  $2.10", "  feat(waves): declare a wave", "  next: tasks.cancel, tasks.message"]],
    [
      "waiting_answer",
      { state: "waiting_answer", running: false, question: "Which field holds overrides?\nThe declaration has none.", actions: ["tasks.cancel", "tasks.message"] },
      [
        "task 4ae7325b  waiting_answer  round 1  factory/w1  $2.10",
        "  feat(waves): declare a wave",
        "  question: Which field holds overrides?",
        "    The declaration has none.",
        "  next: tasks.cancel, tasks.message (answers it)",
      ],
    ],
    [
      "blocked",
      { state: "blocked", reason: "gates", running: false, actions: ["tasks.retry", "tasks.cancel", "tasks.remove", "tasks.message"] },
      ["task 4ae7325b  blocked: gates  round 1  factory/w1  $2.10", "  feat(waves): declare a wave", "  next: tasks.retry, tasks.cancel, tasks.remove, tasks.message"],
    ],
    [
      "waiting_approve",
      { state: "waiting_approve", running: false, actions: ["tasks.approve", "tasks.cancel", "tasks.remove", "tasks.message"] },
      [
        "task 4ae7325b  waiting_approve  round 1  factory/w1  $2.10",
        "  feat(waves): declare a wave",
        "  waits for tasks.approve",
        "  next: tasks.approve, tasks.cancel, tasks.remove, tasks.message",
      ],
    ],
    [
      "done",
      { state: "done", reason: "merged", running: false, wave: WAVE_ID, actions: ["tasks.remove"] },
      ["task 4ae7325b  done  round 1  factory/w1  wave 3f2a91c0  $2.10", "  feat(waves): declare a wave", "  done: merged", "  next: tasks.remove"],
    ],
    [
      "done, with the merged commit and the coder's last message",
      { state: "done", reason: "merged", running: false, merged: "40ca0ce1234", lastMessage: "Added b.txt.\nTypes and tests pass.", actions: ["tasks.remove"] },
      [
        "task 4ae7325b  done  round 1  factory/w1  $2.10",
        "  feat(waves): declare a wave",
        "  done: merged · merged 40ca0ce1",
        "  last message: Added b.txt.",
        "    Types and tests pass.",
        "  next: tasks.remove",
      ],
    ],
    [
      "blocked by a gate: the gate and its output's last lines",
      {
        state: "blocked",
        reason: "max_rounds: gates",
        running: false,
        failure: `bun run types (exit 2)\n${Array.from({ length: 25 }, (_v, i) => `out ${i}`).join("\n")}`,
        actions: ["tasks.retry"],
      },
      [
        "task 4ae7325b  blocked: max_rounds: gates  round 1  factory/w1  $2.10",
        "  feat(waves): declare a wave",
        "  failure: bun run types (exit 2)",
        ...Array.from({ length: 20 }, (_v, i) => `    out ${i + 5}`),
        "  next: tasks.retry",
      ],
    ],
    [
      "blocked by its review: the findings",
      {
        state: "blocked",
        reason: "max_rounds: review_rejected",
        running: false,
        review: { round: 1, status: "ok", approved: false, findings: [{ severity: "major", file: "src/a.ts", line: 3, text: "a bug" }] },
        actions: ["tasks.retry"],
      },
      [
        "task 4ae7325b  blocked: max_rounds: review_rejected  round 1  factory/w1  $2.10",
        "  feat(waves): declare a wave",
        "  review 1: rejected · 1 major",
        "    major  src/a.ts:3  a bug",
        "  next: tasks.retry",
      ],
    ],
    [
      "interrupted",
      { state: "running", running: false, interrupted: true, actions: ["tasks.retry", "tasks.cancel", "tasks.remove", "tasks.message"] },
      [
        "task 4ae7325b  interrupted  round 1  factory/w1  $2.10",
        "  feat(waves): declare a wave",
        "  interrupted: running when its runner ended, no runner lives",
        "  next: tasks.retry, tasks.cancel, tasks.remove, tasks.message",
      ],
    ],
    [
      "starting",
      { state: null, round: null, reason: null, usage: null, actions: ["tasks.cancel"] },
      ["task 4ae7325b  starting  factory/w1", "  feat(waves): declare a wave", "  next: tasks.cancel"],
    ],
    [
      "cancelled",
      { state: "cancelled", reason: "cancelled", running: false, actions: ["tasks.retry", "tasks.remove"] },
      ["task 4ae7325b  cancelled  round 1  factory/w1  $2.10", "  feat(waves): declare a wave", "  next: tasks.retry, tasks.remove"],
    ],
  ];
  for (const [name, over, lines] of cases) {
    test(name, () => {
      const text = taskBlock(task(over));
      expect(text).toBe(lines.join("\n"));
      clean(text);
      expect(agentView("tasks.get", {}, task(over))).toBe(text);
    });
  }
});

describe("waveBlock per stage", () => {
  const head = "  the wave mechanism";
  const cases: [string, Partial<WaveView>, string[]][] = [
    [
      "building",
      {},
      ["wave 3f2a91c0  building  1/3 done  factory/w1  $18.40", head, "  tasks: record done · actions running · docs pending", "  next: waves.add, waves.cancel"],
    ],
    [
      "building with tasks that can never start",
      {
        running: false,
        tasks: [waveTask("record", "cancelled"), waveTask("actions", "pending", ["record"]), waveTask("docs", "pending", ["actions"]), waveTask("free", "blocked")],
        counts: { total: 3, done: 0 },
      },
      [
        "wave 3f2a91c0  building  0/3 done  factory/w1  $18.40",
        head,
        "  tasks: record cancelled · actions pending · docs pending · free blocked (free0000)",
        "  cannot start: actions, docs",
        "  next: waves.add, waves.cancel",
      ],
    ],
    [
      "reviewing",
      { stage: "reviewing", counts: { total: 3, done: 3 }, tasks: [waveTask("record", "done")], actions: ["waves.add", "waves.cancel"] },
      ["wave 3f2a91c0  reviewing  3/3 done  factory/w1  $18.40", head, "  tasks: record done", "  review 1 runs", "  next: waves.add, waves.cancel"],
    ],
    [
      "rejected",
      { stage: "rejected", running: false, tasks: [waveTask("record", "done")], reviews: [review("rejected", FINDINGS)] },
      [
        "wave 3f2a91c0  rejected  1/3 done  factory/w1  $18.40",
        head,
        "  tasks: record done",
        "  review 2: rejected · 1 major, 1 minor",
        "    major  src/wave-runner.ts:309  A wave whose tasks can never start stays building forever.",
        "    minor  src/tasks.ts  tasks.import can put a task into a wave.",
        "  next: waves.add, waves.cancel",
      ],
    ],
    [
      "merging",
      { stage: "merging", actions: ["waves.cancel"] },
      ["wave 3f2a91c0  merging  1/3 done  factory/w1  $18.40", head, "  merging into master", "  next: waves.cancel"],
    ],
    [
      "waiting_approve",
      { stage: "waiting_approve", running: false, reviews: [review("approved")], actions: ["waves.approve", "waves.add", "waves.cancel"] },
      ["wave 3f2a91c0  waiting_approve  1/3 done  factory/w1  $18.40", head, "  review 2: approved", "  waits for waves.approve", "  next: waves.approve, waves.add, waves.cancel"],
    ],
    [
      "blocked by the gates",
      {
        stage: "blocked",
        reason: "gates",
        running: false,
        tasks: [waveTask("record", "done")],
        gates: [
          { at: "2025-01-02T11:00:00.000Z", phase: "review", passed: true, wallMs: 1, log: "ok" },
          { at: "2025-01-02T11:05:00.000Z", phase: "merge", passed: false, wallMs: 1, log: `${Array.from({ length: 25 }, (_v, i) => `line ${i}`).join("\n")}\n` },
        ],
        actions: ["waves.retry", "waves.add", "waves.cancel"],
      },
      [
        "wave 3f2a91c0  blocked: gates  1/3 done  factory/w1  $18.40",
        head,
        "  tasks: record done",
        "  gates failed (merge), last lines:",
        ...Array.from({ length: 20 }, (_v, i) => `    line ${i + 5}`),
        "  next: waves.retry, waves.add, waves.cancel",
      ],
    ],
    [
      "blocked: review failed",
      { stage: "blocked", reason: "review_failed", running: false, tasks: [waveTask("record", "done")], reviews: [review("failed")], actions: ["waves.retry"] },
      ["wave 3f2a91c0  blocked: review_failed  1/3 done  factory/w1  $18.40", head, "  tasks: record done", "  review 2: failed (malformed)", "  next: waves.retry"],
    ],
    [
      "blocked: why, from the stage event's detail",
      { stage: "blocked", reason: "conflict", detail: "rebase onto master conflicts in src/a.ts", running: false, tasks: [waveTask("record", "done")], actions: ["waves.retry"] },
      ["wave 3f2a91c0  blocked: conflict  1/3 done  factory/w1  $18.40", head, "  tasks: record done", "  why: rebase onto master conflicts in src/a.ts", "  next: waves.retry"],
    ],
    [
      "merged",
      {
        stage: "merged",
        running: false,
        counts: { total: 3, done: 3 },
        merge: { at: "2025-01-02T12:00:00.000Z", from: "0ab12cd0ab12cd", to: "40ca0ce40ca0ce", queueMs: 5 },
        remote: { number: 7, url: "https://gitlab.example/app/-/merge_requests/7", pushed: "40ca0ce", error: null },
        actions: ["waves.remove"],
      },
      [
        "wave 3f2a91c0  merged  3/3 done  factory/w1  $18.40",
        head,
        "  merged 0ab12cd0..40ca0ce4 into master",
        "  remote: https://gitlab.example/app/-/merge_requests/7",
        "  next: waves.remove",
      ],
    ],
    [
      "interrupted",
      { stage: "reviewing", running: false, interrupted: true, tasks: [waveTask("record", "done")], actions: ["waves.retry", "waves.cancel"] },
      [
        "wave 3f2a91c0  interrupted  1/3 done  factory/w1  $18.40",
        head,
        "  interrupted: reviewing when its runner ended, no runner lives",
        "  tasks: record done",
        "  next: waves.retry, waves.cancel",
      ],
    ],
    [
      "cancelled",
      { stage: "cancelled", running: false, actions: ["waves.remove"] },
      ["wave 3f2a91c0  cancelled  1/3 done  factory/w1  $18.40", head, "  next: waves.remove"],
    ],
  ];
  for (const [name, over, lines] of cases) {
    test(name, () => {
      const text = waveBlock(wave(over));
      expect(text).toBe(lines.join("\n"));
      clean(text);
      expect(agentView("waves.get", {}, { wave: wave(over) })).toBe(text);
    });
  }

  test("unreachableTasks follows after transitively and ignores a cycle", () => {
    expect(unreachableTasks([waveTask("a", "cancelled"), waveTask("b", "pending", ["a"]), waveTask("c", "pending", ["b"]), waveTask("d", "pending", ["e"])])).toEqual([
      "b",
      "c",
      "d",
    ]);
    expect(unreachableTasks([waveTask("a", "pending", ["b"]), waveTask("b", "pending", ["a"])])).toEqual([]);
  });
});

describe("tasks.wait", () => {
  test("attention: the blocks of what needs it, and what still works", () => {
    const asking = task({ state: "waiting_answer", running: false, question: "Which field?", wave: WAVE_ID, actions: ["tasks.cancel", "tasks.message"] });
    const busy = task({ id: "a113f7bb-0000-4000-8000-000000000000", wave: WAVE_ID });
    const text = agentView("tasks.wait", { wave: "3f2a" }, { tasks: [asking, busy], waves: [wave()], attention: [TASK_ID], timedOut: false });
    expect(text).toBe(
      [
        "attention:",
        "  task 4ae7325b  waiting_answer  round 1  factory/w1  wave 3f2a91c0  $2.10",
        "    feat(waves): declare a wave",
        "    question: Which field?",
        "    next: tasks.cancel, tasks.message (answers it)",
        "still working: 1 task · wave 3f2a91c0 building 1/3",
      ].join("\n"),
    );
  });

  test("nothing wrong: one line per wave and per task outside it", () => {
    expect(agentView("tasks.wait", FIXTURES["tasks.wait"].params, FIXTURES["tasks.wait"].result)).toBe(
      "wave 3f2a91c0  merged  1/3 done  factory/w1  $18.40\ntask 4ae7325b  done  round 1  factory/w1  $2.10  feat(waves): declare a wave",
    );
  });

  test("timed out", () => {
    expect(agentView("tasks.wait", { ids: ["4ae7"], timeoutMs: 600_000 }, { tasks: [task(), task(), task()], waves: [], attention: [], timedOut: true })).toBe(
      "timed out after 10 min\nstill working: 3 tasks",
    );
  });
});

describe("agentError", () => {
  test("one line with the way out, no path and no full id", () => {
    expect(agentError({ code: "refused", message: "wave 3f2a91c0 is merged, nothing can be added" })).toBe(
      "refused: wave 3f2a91c0 is merged, nothing can be added · next: waves.get shows the actions valid now",
    );
    expect(agentError({ code: "invalid", message: `"4a" matches 2 tasks (${TASK_ID}, 4a01c9d2-0000-4000-8000-000000000000), give more of the id` })).toBe(
      'invalid: "4a" matches 2 tasks (4ae7325b, 4a01c9d2), give more of the id · next: fix the params (factory actions {name} lists them)',
    );
    expect(agentError({ code: "not_found", message: "/home/me/x is not inside a git repository" })).toBe("not_found: ~/x is not inside a git repository · next: repos.list");
    expect(agentError({ code: "refused", message: "task 4ae7325b has unmerged work", detail: { force: true } })).toContain("next: the same call with force: true drops it");
    expect(agentError({ code: "busy", message: "a\nb" }).split("\n").length).toBe(1);
  });
});

describe("agentActions", () => {
  test("one line per action: name {params} - summary", () => {
    const lines = agentActions(ACTIONS).split("\n");
    expect(lines.length).toBe(Object.keys(ACTIONS).length);
    expect(lines).toContain("tasks.get {id} - One task");
    expect(lines.find((line) => line.startsWith("tasks.start "))).toStartWith("tasks.start {repo, title, request, overrides?, tag?, plan?} - Start a task");
  });

  test("one action's params in full", () => {
    const text = agentActions(ACTIONS, "tasks.wait");
    expect(text.split("\n")[0]).toStartWith("tasks.wait {ids?, tag?, wave?, ignore?, timeoutMs?} - Wait until");
    expect(text).toContain("  timeoutMs?: integer (min 1000, max 3600000) - Default: 600000");
    expect(text).toContain("  ids?: string[] - Watch these tasks");
    expect(agentActions(ACTIONS, "waves.start")).toContain("    after?: string[]");
    expect(agentActions(ACTIONS, "nope")).toBe("not_found: no action nope · next: factory actions lists them");
  });
});
