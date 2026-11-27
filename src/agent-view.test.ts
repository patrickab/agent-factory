import { describe, expect, test } from "bun:test";
import { agentActions, agentError, agentView, hasAgentView, taskBlock, unreachableTasks, waveBlock, withoutPaths } from "./agent-view.ts";
import { ACTIONS, type TaskView } from "./core.ts";
import type { WaveView } from "./waves.ts";
import { FINDINGS, FIXTURES, OTHER_WAVE, PROOF_ID, proof, review, SESSION, task, TASK_ID, wave, WAVE_ID, waveTask } from "./view-fixtures.ts";


const FORBIDDEN = [/\/home/, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, new RegExp(SESSION.slice(0, 13)), /SECRET-REQUEST/, /secret patch/];

function clean(text: string): void {
  for (const pattern of FORBIDDEN) expect(text).not.toMatch(pattern);
}

describe("agentView", () => {
  test("every action but tasks.timeline has a rendering", () => {
    expect(Object.keys(ACTIONS).filter((name) => !hasAgentView(name))).toEqual(["tasks.timeline"]);
    for (const name of Object.keys(ACTIONS).filter(hasAgentView)) {
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
    for (const name of Object.keys(ACTIONS).filter((action) => ACTIONS[action as keyof typeof ACTIONS].mutates && !["settings.set", "scouts.start"].includes(action))) {
      const fixture = FIXTURES[name];
      expect(agentView(name, fixture.params, fixture.result).split("\n").length, name).toBe(1);
    }
    expect(agentView("tasks.start", {}, task({ round: 0 }))).toBe("started task 4ae7325b  running  factory/w1");
    expect(agentView("tasks.retry", {}, task({ round: 3 }))).toBe("task 4ae7325b  running  round 3  factory/w1  $2.10");
    expect(agentView("tasks.remove", {}, FIXTURES["tasks.remove"].result)).toBe("removed task 4ae7325b · dropped: 1 unmerged commit");
    expect(agentView("waves.start", {}, { wave: wave() })).toBe(
      "started wave 3f2a91c0  building  1/3 done  factory/w1 · started: record, actions · waits: docs (actions)",
    );
    expect(agentView("waves.start", {}, { wave: wave({ stage: "queued", after: [OTHER_WAVE, WAVE_ID], running: false, tasks: [waveTask("record", "pending")], counts: { total: 1, done: 0 } }) })).toBe(
      "declared wave 3f2a91c0  queued  0/1 done  factory/w1 · waits for: 77b0c2e1, 3f2a91c0",
    );
    expect(agentView("waves.add", FIXTURES["waves.add"].params, FIXTURES["waves.add"].result)).toBe("wave 3f2a91c0  building  1/3 done  factory/w1 · added: fix running");
    expect(agentView("waves.remove", {}, { removed: WAVE_ID })).toBe("removed wave 3f2a91c0");
    expect(agentView("waves.retry", {}, { wave: wave(), retried: [TASK_ID], refused: [{ id: OTHER_WAVE, why: "its runner did not start" }] })).toBe(
      "wave 3f2a91c0  building  1/3 done  factory/w1 · retried tasks: 4ae7325b · refused task 77b0c2e1: its runner did not start",
    );
    expect(agentView("contracts.apply", {}, FIXTURES["contracts.apply"].result)).toBe(
      "contract api: 1 fact changed · told: factory/w1:record · done, may need a follow-up task: factory/w1:docs",
    );
  });

  test("tasks.diff: the file list with counts, never the patch", () => {
    expect(agentView("tasks.diff", {}, FIXTURES["tasks.diff"].result)).toBe("2 files  +40 -2\n  +10 -2  src/x.ts\n  +30 -0  src/x.test.ts");
    expect(agentView("tasks.diff", {}, { diff: "", files: [] })).toBe("no changes");
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

  test("waves.list: a queued wave names the waves it waits for, by tag when listed", () => {
    const first = wave({ id: OTHER_WAVE, tag: "factory/w0", stage: "blocked", reason: "gates", running: false, usage: null });
    const queued = wave({ stage: "queued", after: [OTHER_WAVE, "9c4d1e2f-0000-4000-8000-000000000000"], running: false, usage: null });
    expect(agentView("waves.list", {}, { waves: [first, queued] })).toBe(
      [
        "wave 77b0c2e1  blocked: gates  1/3 done  factory/w0  the wave mechanism",
        "wave 3f2a91c0  queued  1/3 done  factory/w1  after factory/w0, 9c4d1e2f  the wave mechanism",
      ].join("\n"),
    );
  });

  test("tasks.wait: a queued wave still works", () => {
    const queued = wave({ stage: "queued", after: [OTHER_WAVE], running: false, counts: { total: 3, done: 0 } });
    expect(agentView("tasks.wait", { wave: "3f2a" }, { tasks: [], waves: [queued], attention: [], timedOut: true })).toBe(
      "timed out after 10 min\nstill working: wave 3f2a91c0 queued 0/3",
    );
  });

  test("repositories, branches, settings, config", () => {
    expect(agentView("repos.list", {}, FIXTURES["repos.list"].result)).toBe("~/git/app\n~/git/bot");
    expect(agentView("branches.list", {}, FIXTURES["branches.list"].result)).toBe("master · waves");
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
    expect(agentView("config.get", {}, FIXTURES["config.get"].result)).toBe("factory.yaml (working copy)\ngates:\n  - [bun, run, types]");
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
      "done with a flaky gate: its names",
      { state: "done", reason: "merged", running: false, merged: "40ca0ce1234", flaky: ["a > b", "make check"], actions: ["tasks.remove"] },
      [
        "task 4ae7325b  done  round 1  factory/w1  $2.10",
        "  feat(waves): declare a wave",
        "  done: merged · merged 40ca0ce1",
        "  flaky: a > b, make check",
        "  next: tasks.remove",
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
      ["wave 3f2a91c0  building  1/3 done  factory/w1  $18.40", head, "  tasks: record done · actions running · docs pending (docs0000)", "  next: waves.add, waves.cancel"],
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
        "  tasks: record cancelled · actions pending (actions0) · docs pending (docs0000) · free blocked (free0000)",
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
        "  minor findings: 1",
        "    minor  src/tasks.ts  tasks.import can put a task into a wave.  (review 2)",
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
      "merged with a flaky gate: its names",
      {
        stage: "merged",
        running: false,
        merge: { at: "2025-01-02T11:10:00.000Z", from: "aaaaaaa1", to: "bbbbbbb2" },
        gates: [{ at: "2025-01-02T11:00:00.000Z", phase: "review", passed: true, wallMs: 1, log: "ok", flaky: ["a > b"] }],
        actions: [],
      },
      ["wave 3f2a91c0  merged  1/3 done  factory/w1  $18.40", head, "  merged aaaaaaa1..bbbbbbb2 into master", "  flaky: a > b", "  next: none, it runs"],
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
        merge: { at: "2025-01-02T12:00:00.000Z", from: "0ab12cd0ab12cd", to: "40ca0ce40ca0ce" },
        actions: ["waves.remove"],
      },
      [
        "wave 3f2a91c0  merged  3/3 done  factory/w1  $18.40",
        head,
        "  merged 0ab12cd0..40ca0ce4 into master",
        "  next: waves.remove",
      ],
    ],
    [
      "merged with two minors",
      {
        stage: "merged",
        running: false,
        counts: { total: 3, done: 3 },
        reviews: [
          review("approved", [
            { severity: "minor", file: "src/a.ts", line: 3, text: "rename x" },
            { severity: "minor", file: "src/b.ts", line: null, text: "doc it" },
          ]),
        ],
        actions: ["waves.remove"],
      },
      [
        "wave 3f2a91c0  merged  3/3 done  factory/w1  $18.40",
        head,
        "  review 2: approved · 2 minor",
        "  minor findings: 2",
        "    minor  src/a.ts:3  rename x  (review 2)",
        "    minor  src/b.ts  doc it  (review 2)",
        "  next: waves.remove",
      ],
    ],
    [
      "merged with the minors of a task's review",
      {
        stage: "merged",
        running: false,
        counts: { total: 3, done: 3 },
        reviews: [review("approved")],
        minors: [{ round: 1, task: "docs", file: "README.md", line: 4, text: "terse" }],
        actions: ["waves.remove"],
      },
      [
        "wave 3f2a91c0  merged  3/3 done  factory/w1  $18.40",
        head,
        "  minor findings: 1",
        "    minor  README.md:4  terse  (task docs, review 1)",
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
      "queued",
      { stage: "queued", after: [OTHER_WAVE], running: false, tasks: [waveTask("record", "pending")], counts: { total: 1, done: 0 }, usage: null },
      ["wave 3f2a91c0  queued  0/1 done  factory/w1", head, "  waits for: 77b0c2e1", "  tasks: record pending (record00)", "  next: waves.add, waves.cancel"],
    ],
    [
      "queued after a cancelled wave",
      {
        stage: "queued",
        after: [OTHER_WAVE],
        detail: "it waits for wave factory/w0 (77b0c2e1), which was cancelled: it can never start; waves.cancel or waves.remove it",
        running: false,
        tasks: [waveTask("record", "pending")],
        counts: { total: 1, done: 0 },
        usage: null,
      },
      [
        "wave 3f2a91c0  queued: can never start  0/1 done  factory/w1",
        head,
        "  waits for: 77b0c2e1",
        "  tasks: record pending (record00)",
        "  why: it waits for wave factory/w0 (77b0c2e1), which was cancelled: it can never start; waves.cancel or waves.remove it",
        "  next: waves.add, waves.cancel",
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

  test("a failing proof needs attention with its last lines, a running one still works, a flaky one at rest names its tests", () => {
    expect(agentView("tasks.wait", { ids: ["9c1d"] }, { tasks: [], waves: [], proofs: [proof()], attention: [PROOF_ID], timedOut: false })).toBe(
      [
        "attention:",
        "  proof 9c1d2e3f  failing  master 0ab12cd",
        "    failing: bun test, last lines:",
        "      (fail) the wave merges",
        "      1 fail",
        "    next: fix the branch, then gates.prove again",
      ].join("\n"),
    );
    const running = proof({ state: "running", running: true, failing: null, endedAt: null });
    expect(agentView("tasks.wait", { ids: ["9c1d"] }, { tasks: [], waves: [], proofs: [running], attention: [], timedOut: true })).toBe(
      "timed out after 10 min\nstill working: proof 9c1d2e3f running",
    );
    const flaky = proof({ state: "flaky", failing: null, flaky: ["the wave merges"] });
    expect(agentView("tasks.wait", { ids: ["9c1d"] }, { tasks: [], waves: [], proofs: [flaky], attention: [], timedOut: false })).toBe(
      "proof 9c1d2e3f  flaky  master 0ab12cd  flaky: the wave merges",
    );
  });
});

describe("agentError", () => {
  test("keeps slash commands", () => {
    expect(agentError({ code: "refused", message: "no models (set them with /factory models)" })).toContain("/factory models)");
  });

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

describe("withoutPaths", () => {
  test("any absolute path in free text is <path>, in a view and in an error; relative paths and urls stay", () => {
    expect(withoutPaths("ENOENT: open '/srv/app/x.ts' at /tmp/run-1/log (see src/a.ts, https://x.org/a)")).toBe(
      "ENOENT: open '<path>' at <path> (see src/a.ts, https://x.org/a)",
    );
    expect(agentError({ code: "infra", message: "spawn /usr/bin/bun failed" })).toStartWith("infra: spawn <path> failed");
    const blocked = agentView("tasks.get", {}, task({ state: "blocked", reason: "gates_failed", failure: "error: cannot open /var/tmp/out.txt" }));
    expect(blocked).toContain("failure: error: cannot open <path>");
  });

  test("the repos actions keep the repository paths an agent passes back", () => {
    expect(agentView("repos.list", {}, { repos: ["/srv/app"] })).toBe("/srv/app");
  });
});

describe("agentActions", () => {
  test("one line per action: name {params} - summary", () => {
    const lines = agentActions(ACTIONS).split("\n");
    expect(lines.length).toBe(Object.keys(ACTIONS).length);
    expect(lines).toContain("tasks.get {id} - One task");
    expect(lines.find((line) => line.startsWith("tasks.start "))).toStartWith("tasks.start {repo, title, request, overrides?, tag?} - Start a task");
  });

  test("one action's params in full", () => {
    const text = agentActions(ACTIONS, "tasks.wait");
    expect(text.split("\n")[0]).toStartWith("tasks.wait {ids?, tag?, wave?, timeoutMs?} - Wait until");
    expect(text).toContain("  timeoutMs?: integer (min 1000, max 3600000) - Default: 600000");
    expect(text).toContain("  ids?: string[] - Watch these tasks");
    expect(agentActions(ACTIONS, "waves.start")).toContain("    after?: string[]");
    expect(agentActions(ACTIONS, "nope")).toBe("not_found: no action nope · next: factory actions lists them");
  });
});
