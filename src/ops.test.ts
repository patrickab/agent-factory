/**
 * The task operations of `ops.ts` over a fake `OpsDeps`: each expected failure is `{ ok: false }`, each operation has
 * one success. Commands that need git run real git in throwaway repos in a temp dir.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTaskFiles } from "./config.ts";
import {
  applyReviewed,
  approveTask,
  askSupervisor,
  cancelTask,
  CODER_REQUEST_LINE,
  coderRequest,
  initConfig,
  openRun,
  newTaskSession,
  pipelineSteps,
  record,
  resumeAnswered,
  resumeTask,
  retryTask,
  startTask,
  type CoderMessage,
  type OpsDeps,
} from "./ops.ts";
import { CommandRunner } from "./run.ts";
import { RETRY_PROMPT, roundsUsed, type Settings, type State, type Task } from "./state.ts";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "factory-ops-test-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function gitIn(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const settings: Settings = { branch: "main", merge: "auto", maxRounds: 3, review: false, models: {} };
const payload = (overrides: Partial<Settings> = {}) => JSON.stringify({ request: "Add task.txt", title: "Add task file", settings: { ...settings, ...overrides } });

let counter = 0;
let dir: string;
let repo: string;

/** `dir`: a plain directory. `repo`: a fresh repo on `main` with a `factory.yaml`. */
beforeEach(() => {
  counter += 1;
  dir = join(scratch, `dir-${counter}`);
  mkdirSync(dir);
  repo = join(scratch, `repo-${counter}`);
  mkdirSync(repo);
  gitIn(repo, "init", "--quiet", "--initial-branch", "main");
  gitIn(repo, "config", "user.name", "Factory Test");
  gitIn(repo, "config", "user.email", "factory@test.invalid");
  writeFileSync(join(repo, "factory.yaml"), "gates: []\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "--quiet", "-m", "base");
});

function addTaskWorktree(): string {
  const worktree = join(scratch, `wt-${counter}`);
  gitIn(repo, "worktree", "add", "--quiet", "-b", "task", worktree, "main");
  return worktree;
}

/** An `OpsDeps` in `cwd` that records what Pi would get. */
function fake(cwd: string) {
  const entries: { customType: string; data: any }[] = [];
  const userMessages: string[] = [];
  const coderMessages: { message: CoderMessage; triggerTurn: boolean }[] = [];
  const flags = { idle: true, aborts: 0, modelAvailable: true };
  const deps: OpsDeps = {
    session: newTaskSession(),
    cwd,
    appendEntry: (customType, data) => entries.push({ customType, data }),
    sendUserMessage: (text) => userMessages.push(text),
    sendMessage: (message, { triggerTurn }) => coderMessages.push({ message, triggerTurn }),
    setStatus: () => undefined,
    isIdle: () => flags.idle,
    abort: () => {
      flags.aborts += 1;
    },
    setModel: async () => flags.modelAvailable,
    hasPendingMessages: () => false,
    followUps: () => [],
    sessionModel: () => null,
    sessionId: () => "ops-test",
  };
  const states = () => entries.filter((entry) => entry.customType === "factory-state").map((entry) => `${entry.data.state}/${entry.data.reason}`);
  /** Puts a task in `state` into the session, as its entries would. */
  const holdTask = (state: State) => {
    const task: Task = { title: "t", request: "r", settings, branch: "task", mainBranch: "main", baseSha: "0".repeat(40), protocol: 2 };
    record(deps, "factory-task", task);
    record(deps, "factory-state", { state, round: 1, reason: "test" });
  };
  return { deps, entries, userMessages, coderMessages, flags, states, holdTask };
}

describe("pipelineSteps.askCommitMessage", () => {
  test("a conventional task title is the message, until the task merged: a follow-up asks for its own; the merge clears the last one", async () => {
    const pi = fake(dir);
    pi.holdTask("running");
    const task = { ...pi.deps.session.snapshot!.task, title: "feat: add t" };
    const files = { config: {}, prompts: {} } as never;
    expect(pipelineSteps(pi.deps, task, files, false).askCommitMessage!()).toBe(false);
    record(pi.deps, "factory-commit-message", { title: "feat: t", body: "- t" });
    record(pi.deps, "factory-merge", { ok: true, commit: "a".repeat(40), error: null, depsSynced: false });
    expect(pi.deps.session.snapshot!.commitMessage).toBeNull();
    expect(pipelineSteps(pi.deps, task, files, false).askCommitMessage!()).toBe(true);
  });
});

describe("startTask", () => {
  test("expected failures are results and write nothing", async () => {
    const held = fake(dir);
    held.holdTask("running");
    expect(await startTask(held.deps, payload())).toEqual({ ok: false, error: "this session already holds a task" });
    const busy = fake(dir);
    busy.flags.idle = false;
    expect(await startTask(busy.deps, payload())).toEqual({ ok: false, error: "the session is busy" });
    const invalid = fake(dir);
    expect(await startTask(invalid.deps, "{not json")).toEqual({ ok: false, error: "payload is not JSON" });
    const outside = await startTask(fake(dir).deps, payload());
    expect(outside.ok).toBe(false);
    const primary = await startTask(fake(repo).deps, payload());
    expect(primary).toMatchObject({ ok: false, error: expect.stringContaining("is the repository's main checkout") });
    const noModel = fake(addTaskWorktree());
    noModel.flags.modelAvailable = false;
    expect(await startTask(noModel.deps, payload({ models: { coder: "nobody/nothing" } }))).toEqual({ ok: false, error: "model nobody/nothing is not available" });
    expect([...busy.entries, ...invalid.entries, ...noModel.entries, ...noModel.userMessages]).toEqual([]);
    expect(noModel.deps.session.starting).toBe(false);
  });

  test("records the task and prompts the coder", async () => {
    const pi = fake(addTaskWorktree());
    expect(await startTask(pi.deps, payload())).toEqual({ ok: true });
    expect(pi.entries.map((entry) => entry.customType)).toEqual(["factory-task", "factory-round", "factory-state"]);
    expect(pi.userMessages).toEqual([coderRequest("Add task.txt")]);
    expect(pi.userMessages[0]!.startsWith("Add task.txt\n")).toBe(true);
    expect(pi.userMessages[0]!.split(CODER_REQUEST_LINE).length - 1).toBe(1);
    // The task records the request as the supervisor wrote it: the reviewer reads it without the line.
    expect(pi.deps.session.snapshot?.task.request).toBe("Add task.txt");
    expect(pi.deps.session.snapshot?.state).toBe("running");
  });

  test("a wave task's contracts go before the request in the first message, the task records the request without them", async () => {
    const pi = fake(addTaskWorktree());
    const start = JSON.stringify({ ...JSON.parse(payload()), prefix: "Your contracts: core" });
    expect(await startTask(pi.deps, start)).toEqual({ ok: true });
    expect(pi.userMessages).toEqual([coderRequest("Your contracts: core\n\nAdd task.txt")]);
    expect(pi.deps.session.snapshot?.task.request).toBe("Add task.txt");
    expect(JSON.stringify(pi.entries)).not.toContain("Your contracts");
  });
});

describe("approveTask", () => {
  test("expected failures", async () => {
    expect(await approveTask(fake(dir).deps)).toEqual({ ok: false, error: "this session holds no task" });
    const running = fake(dir);
    running.holdTask("running");
    expect(await approveTask(running.deps)).toEqual({ ok: false, error: "the task is not waiting for approve" });
    const busy = fake(dir);
    busy.holdTask("waiting_approve");
    busy.flags.idle = false;
    expect(await approveTask(busy.deps)).toEqual({ ok: false, error: "the session is busy" });
    expect(busy.states()).toEqual(["waiting_approve/test"]);
  });

  test("answers at once with merging, the merge then ends the task", async () => {
    const pi = fake(dir);
    pi.holdTask("waiting_approve");
    expect(await approveTask(pi.deps)).toEqual({ ok: true });
    expect(pi.states()).toEqual(["waiting_approve/test", "merging/approved"]);
    // Not a repo: the merge cannot read its rules and ends blocked.
    while (pi.states().length < 3) await Bun.sleep(10);
    expect(pi.states()[2]).toStartWith("blocked/pipeline_error: ");
  });
});

describe("approveTask before any await", () => {
  test("merging is recorded before the call returns: a runner can never see the task still waiting once Pi answers", async () => {
    const pi = fake(dir);
    pi.holdTask("waiting_approve");
    const answer = approveTask(pi.deps);
    expect(pi.states()).toEqual(["waiting_approve/test", "merging/approved"]);
    expect(pi.deps.session.snapshot?.state).toBe("merging");
    expect(await answer).toEqual({ ok: true });
    while (pi.states().length < 3) await Bun.sleep(10);
  });
});

describe("factory.yaml lockfiles", () => {
  /** A task worktree whose repo's factory.yaml names `Cargo.lock` as its only lockfile. */
  function cargoTask() {
    writeFileSync(join(repo, "factory.yaml"), 'lockfiles: ["Cargo.lock"]\n');
    gitIn(repo, "commit", "--quiet", "-am", "cargo lockfile");
    const worktree = addTaskWorktree();
    const pi = fake(worktree);
    pi.holdTask("running");
    return { worktree, pi };
  }

  test("the review's patch puts the configured lockfiles last", async () => {
    const { worktree, pi } = cargoTask();
    writeFileSync(join(worktree, "Cargo.lock"), "lock\n");
    writeFileSync(join(worktree, "a.txt"), "source\n");
    const files = await loadTaskFiles(new CommandRunner().run, worktree, gitIn(worktree, "rev-parse", "HEAD"));
    const { patch } = await pipelineSteps(pi.deps, pi.deps.session.snapshot!.task, files, false).diff();
    expect(patch.indexOf("b/a.txt")).toBeGreaterThan(-1);
    expect(patch.indexOf("b/Cargo.lock")).toBeGreaterThan(patch.indexOf("b/a.txt"));
  });

  test("a merge that landed while the session was down: a changed configured lockfile means after_merge did not run", async () => {
    const { worktree, pi } = cargoTask();
    writeFileSync(join(worktree, "Cargo.lock"), "lock\n");
    gitIn(worktree, "add", "-A");
    gitIn(worktree, "commit", "--quiet", "-m", "lock");
    const before = gitIn(repo, "rev-parse", "main");
    const commit = gitIn(worktree, "rev-parse", "HEAD");
    gitIn(repo, "update-ref", "refs/heads/main", commit, before);
    record(pi.deps, "factory-state", { state: "merging", round: 1, reason: "passed" });
    record(pi.deps, "factory-merge-intent", { commit, before });
    await resumeTask(pi.deps, pi.deps.session.snapshot!);
    expect(pi.entries.find((entry) => entry.customType === "factory-merge")?.data.error).toBe("after_merge did not run: the session ended during the merge");
    expect(pi.states().at(-1)).toBe("done/merged, after_merge failed");
  });
});

describe("an invalid factory.yaml", () => {
  test("a run does not open on defaults: the task blocks as infra, naming the file and the error", async () => {
    writeFileSync(join(repo, "factory.yaml"), "task_gate: []\n");
    gitIn(repo, "commit", "--quiet", "-am", "typo");
    const worktree = addTaskWorktree();
    const pi = fake(worktree);
    pi.holdTask("blocked");
    const opening = await openRun(pi.deps, pi.deps.session.snapshot!);
    expect(opening.failed).toStartWith("infra: factory.yaml: unknown key task_gate");
  });
});

describe("the merge step", () => {
  test("a merge refusal (the task's wave is under review) fails the merge before anything: no commit, the target unmoved", async () => {
    const worktree = addTaskWorktree();
    const pi = fake(worktree);
    pi.holdTask("merging");
    writeFileSync(join(worktree, "task.txt"), "work\n");
    let asked = 0;
    pi.deps.mergeRefusal = async () => {
      asked += 1;
      return "its wave is reviewing";
    };
    const main = gitIn(repo, "rev-parse", "main");
    const files = await loadTaskFiles(new CommandRunner().run, worktree, main);
    const outcome = await pipelineSteps(pi.deps, pi.deps.session.snapshot!.task, files, false).merge(files.config);
    expect([asked, outcome]).toEqual([1, { gates: [], result: { kind: "failed", merge: { ok: false, commit: null, error: "its wave is reviewing", depsSynced: false } } }]);
    expect([gitIn(repo, "rev-parse", "main"), gitIn(worktree, "rev-parse", "HEAD"), gitIn(worktree, "status", "--porcelain")]).toEqual([main, main, "?? task.txt"]);
  });

  /**
   * A repo whose gates log their list (and `FACTORY_BASE`) to a file outside it, a task with work, and `main` moved on
   * after the task branched. Returns what the merge ran, `main` before the merge and the merge's outcome.
   */
  async function gatedMerge(wave: string | null) {
    const log = join(scratch, `gates-${counter}.log`);
    const line = (name: string) => `  - [sh, -c, 'echo "${name} \${FACTORY_BASE:-unset}" >> ${log}']\n`;
    writeFileSync(join(repo, "factory.yaml"), `gates:\n${line("gates")}task_gates:\n${line("task_gates")}merge_gates:\n${line("merge_gates")}`);
    gitIn(repo, "commit", "--quiet", "-am", "logging gates");
    const worktree = addTaskWorktree();
    writeFileSync(join(repo, "other.txt"), "other\n");
    gitIn(repo, "add", "-A");
    gitIn(repo, "commit", "--quiet", "-m", "main moved");
    const main = gitIn(repo, "rev-parse", "main");
    const pi = fake(worktree);
    pi.holdTask("merging");
    pi.deps.wave = async () => wave;
    writeFileSync(join(worktree, "task.txt"), "work\n");
    const files = await loadTaskFiles(new CommandRunner().run, worktree, main);
    const outcome = await pipelineSteps(pi.deps, pi.deps.session.snapshot!.task, files, false).merge(files.config);
    return { ran: readFileSync(log, "utf8").trim().split("\n"), main, outcome };
  }

  test("a wave's task runs gates and task_gates with FACTORY_BASE (the commit its rebased change sits on), not merge_gates", async () => {
    const { ran, main, outcome } = await gatedMerge("30000000-0000-4000-8000-000000000001");
    expect(outcome.result.kind).toBe("merged");
    expect(ran).toEqual([`gates ${main}`, `task_gates ${main}`]);
    expect(outcome.gates.map((gate) => gate.phase)).toEqual(["merge_gates", "merge_gates"]);
  });

  test("a task outside a wave still runs merge_gates at its merge, without FACTORY_BASE", async () => {
    const { ran, outcome } = await gatedMerge(null);
    expect(outcome.result.kind).toBe("merged");
    expect(ran).toEqual(["merge_gates unset"]);
  });
});

describe("retryTask", () => {
  test("expected failures", async () => {
    expect(await retryTask(fake(dir).deps)).toEqual({ ok: false, error: "this session holds no task" });
    const done = fake(dir);
    done.holdTask("done");
    expect(await retryTask(done.deps)).toEqual({ ok: false, error: "retry needs a blocked or cancelled task" });
    const busy = fake(dir);
    busy.holdTask("blocked");
    busy.flags.idle = false;
    expect(await retryTask(busy.deps)).toEqual({ ok: false, error: "the session is busy" });
    const outside = fake(dir);
    outside.holdTask("blocked");
    expect((await retryTask(outside.deps)).ok).toBe(false);
    expect(outside.userMessages).toEqual([]);
  });

  test("opens a retry round and prompts the coder", async () => {
    const pi = fake(addTaskWorktree());
    await startTask(pi.deps, payload());
    record(pi.deps, "factory-state", { state: "blocked", round: 1, reason: "agent_error" });
    expect(await retryTask(pi.deps)).toEqual({ ok: true });
    expect(pi.entries.at(-2)).toEqual({ customType: "factory-round", data: { round: 2, trigger: "retry" } });
    expect(pi.states().at(-1)).toBe("running/retry");
    expect(pi.userMessages.at(-1)).toBe(RETRY_PROMPT);
  });

  test("a task interrupted mid-round, then retried: a fresh run with the full maxRounds", async () => {
    const pi = fake(addTaskWorktree());
    await startTask(pi.deps, payload());
    // Round 2 of 3 is running when the runner is killed; the next session start sets it right.
    record(pi.deps, "factory-round", { round: 2, trigger: "gates" });
    record(pi.deps, "factory-state", { state: "running", round: 2, reason: "gates" });
    await resumeTask(pi.deps, pi.deps.session.snapshot!);
    expect(pi.states().at(-1)).toBe("blocked/interrupted");
    expect(await retryTask(pi.deps)).toEqual({ ok: true });
    const snapshot = pi.deps.session.snapshot!;
    expect(snapshot).toMatchObject({ state: "running", round: 3, runFirstRound: 3 });
    expect([roundsUsed(snapshot), snapshot.task.settings.maxRounds]).toEqual([1, 3]);
  });
});

describe("askSupervisor and resumeAnswered", () => {
  test("a question rests the task in waiting_answer; the answer runs the same round without a round entry", () => {
    const pi = fake(dir);
    pi.holdTask("running");
    record(pi.deps, "factory-round", { round: 1, trigger: "start" });
    askSupervisor(pi.deps, pi.deps.session.snapshot!, "Which table?");
    expect(pi.entries.slice(3)).toEqual([
      { customType: "factory-question", data: { text: "Which table?" } },
      { customType: "factory-state", data: { state: "waiting_answer", round: 1, reason: "question" } },
    ]);
    expect(pi.deps.session.snapshot).toMatchObject({ state: "waiting_answer", question: "Which table?" });
    resumeAnswered(pi.deps, pi.deps.session.snapshot!);
    expect(pi.entries.slice(5)).toEqual([{ customType: "factory-state", data: { state: "running", round: 1, reason: "answer" } }]);
    expect(pi.deps.session.snapshot).toMatchObject({ state: "running", round: 1, runFirstRound: 1 });
  });
});

describe("cancelTask", () => {
  test("expected failures", async () => {
    expect(await cancelTask(fake(dir).deps)).toEqual({ ok: false, error: "this session holds no task" });
    for (const state of ["done", "cancelled"] as const) {
      const pi = fake(dir);
      pi.holdTask(state);
      expect(await cancelTask(pi.deps)).toEqual({ ok: false, error: "the task is not active" });
    }
  });

  test("an idle task ends cancelled, a busy one is aborted", async () => {
    const idle = fake(dir);
    idle.holdTask("blocked");
    expect(await cancelTask(idle.deps)).toEqual({ ok: true });
    expect(idle.states().at(-1)).toBe("cancelled/cancelled");
    expect(idle.deps.session.runner.cancelled).toBe(false);
    const busy = fake(dir);
    busy.holdTask("running");
    busy.flags.idle = false;
    expect(await cancelTask(busy.deps)).toEqual({ ok: true });
    expect(busy.flags.aborts).toBe(1);
    expect(busy.states()).toEqual(["running/test"]);
  });
});

describe("initConfig", () => {
  test("expected failures: not a repo, factory.yaml exists already", async () => {
    expect((await initConfig(fake(dir).deps)).ok).toBe(false);
    expect(await initConfig(fake(repo).deps)).toEqual({ ok: false, error: `${join(repo, "factory.yaml")} exists already, init does not overwrite it` });
  });

  test("writes the draft and says where", async () => {
    rmSync(join(repo, "factory.yaml"));
    expect(await initConfig(fake(repo).deps)).toEqual({ ok: true, message: `wrote ${join(repo, "factory.yaml")} (nothing detected, fill the gates in). Review it, then commit it.` });
    expect(readFileSync(join(repo, "factory.yaml"), "utf8")).toContain("gates");
  });
});

describe("an old merge request in its own session (invariant 7)", () => {
  test("approve and retry are refused: nothing is recorded, nothing reaches the coder", async () => {
    const pi = fake(addTaskWorktree());
    const task: Task = { title: "t", request: "r", settings, branch: "task", mainBranch: "main", baseSha: "0".repeat(40), kind: "merge_request" };
    record(pi.deps, "factory-task", task);
    record(pi.deps, "factory-state", { state: "waiting_approve", round: 1, reason: "test" });
    expect(await approveTask(pi.deps)).toEqual({ ok: false, error: "this task is an old merge request: approve is refused, it can only be removed" });
    record(pi.deps, "factory-state", { state: "blocked", round: 1, reason: "test" });
    expect(await retryTask(pi.deps)).toEqual({ ok: false, error: "this task is an old merge request: retry is refused, it can only be removed" });
    expect(pi.states()).toEqual(["waiting_approve/test", "blocked/test"]);
    expect([pi.userMessages, pi.coderMessages]).toEqual([[], []]);
  });
});

describe("applyReviewed", () => {
  const review = (severities: ("blocker" | "major" | "minor")[]) => {
    const findings = severities.map((severity) => ({ file: "task.txt", line: 1, severity, text: `${severity} problem` }));
    return { round: 1, status: "ok", approved: severities.every((severity) => severity === "minor"), findings, model: null, sessionFile: null, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.1 }, wallMs: 1 };
  };
  const command = (severities: ("blocker" | "major" | "minor")[], round = 1) => JSON.stringify({ round, review: review(severities) });

  test("approved: the review is recorded and the task merges into its target", async () => {
    const worktree = addTaskWorktree();
    writeFileSync(join(worktree, "task.txt"), "t\n");
    const pi = fake(worktree);
    pi.holdTask("reviewing");
    record(pi.deps, "factory-round", { round: 1, trigger: "start" });
    expect(await applyReviewed(pi.deps, command(["minor"]))).toEqual({ ok: true });
    expect(pi.entries.map((entry) => entry.customType)).toContain("factory-review");
    while (pi.states().length < 3) await Bun.sleep(10);
    expect(pi.states()).toEqual(["reviewing/test", "merging/approved", "done/merged"]);
    expect(gitIn(repo, "show", "main:task.txt")).toBe("t");
  });

  test("a major finding: the next round starts the coder with it", async () => {
    const pi = fake(dir);
    pi.holdTask("reviewing");
    record(pi.deps, "factory-round", { round: 1, trigger: "start" });
    expect(await applyReviewed(pi.deps, command(["major"]))).toEqual({ ok: true });
    expect(pi.states()).toEqual(["reviewing/test", "running/review"]);
    expect(pi.coderMessages).toHaveLength(1);
    expect(pi.coderMessages[0]!.triggerTurn).toBe(true);
    expect(String(pi.coderMessages[0]!.message.content)).toContain("[major] task.txt:1: major problem");
  });

  test("a verdict for another round, or a task not reviewing, changes nothing: delivered twice is applied once", async () => {
    const pi = fake(dir);
    pi.holdTask("reviewing");
    record(pi.deps, "factory-round", { round: 1, trigger: "start" });
    expect(await applyReviewed(pi.deps, command(["major"], 2))).toEqual({ ok: false, error: "the task is not reviewing round 2" });
    expect(await applyReviewed(pi.deps, command(["major"]))).toEqual({ ok: true });
    expect(await applyReviewed(pi.deps, command(["major"]))).toEqual({ ok: false, error: "the task is not reviewing round 1" });
    expect(pi.states()).toEqual(["reviewing/test", "running/review"]);
    expect(await applyReviewed(pi.deps, "{bad")).toMatchObject({ ok: false });
  });
});
