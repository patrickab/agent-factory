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
import { applyReviewed, approveTask, askSupervisor, cancelTask, openRun, newTaskSession, pipelineSteps, record, resumeAnswered, startTask, type CoderMessage, type OpsDeps } from "./ops.ts";
import { CommandRunner } from "./run.ts";
import { until } from "./core-test-kit.ts";
import { type Settings, type State, type Task } from "./state.ts";
import { restoreEnv } from "./core-test-kit.ts";

const savedEnv = { ...process.env };
afterAll(() => restoreEnv(savedEnv));
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
    wave: async () => null,
  };
  const states = () => entries.filter((entry) => entry.customType === "factory-state").map((entry) => `${entry.data.state}/${entry.data.reason}`);
  /** Puts a task in `state` into the session, as its entries would. */
  const holdTask = (state: State) => {
    const task: Task = { title: "t", request: "r", settings, branch: "task", mainBranch: "main", baseSha: "0".repeat(40) };
    record(deps, "factory-task", task);
    record(deps, "factory-state", { state, round: 1, reason: "test" });
  };
  return { deps, entries, userMessages, coderMessages, flags, states, holdTask };
}

describe("startTask", () => {
  test("expected failures are results and write nothing", async () => {
    const held = fake(dir);
    held.holdTask("running");
    expect(await startTask(held.deps, payload())).toMatchObject({ ok: false });
    const busy = fake(dir);
    busy.flags.idle = false;
    expect(await startTask(busy.deps, payload())).toMatchObject({ ok: false });
    const invalid = fake(dir);
    expect(await startTask(invalid.deps, "{not json")).toMatchObject({ ok: false });
    expect(await startTask(fake(dir).deps, payload())).toMatchObject({ ok: false });
    expect(await startTask(fake(repo).deps, payload())).toMatchObject({ ok: false });
    const noModel = fake(addTaskWorktree());
    noModel.flags.modelAvailable = false;
    expect(await startTask(noModel.deps, payload({ models: { coder: "nobody/nothing" } }))).toMatchObject({ ok: false });
    expect([...busy.entries, ...invalid.entries, ...noModel.entries, ...noModel.userMessages]).toEqual([]);
    expect(noModel.deps.session.starting).toBe(false);
  });

});

describe("approveTask before any await", () => {
  test("merging is recorded before the call returns: a runner can never see the task still waiting once Pi answers", async () => {
    const pi = fake(dir);
    pi.holdTask("waiting_approve");
    const answer = approveTask(pi.deps, pi.deps.session.snapshot!);
    expect(pi.states()).toEqual(["waiting_approve/test", "merging/approved"]);
    expect(pi.deps.session.snapshot?.state).toBe("merging");
    expect(await answer).toEqual({ ok: true });
    await until(() => pi.states().length === 3);
  });
});

describe("an invalid factory.yaml", () => {
  test("a run does not open on defaults: the task blocks as infra", async () => {
    writeFileSync(join(repo, "factory.yaml"), "task_gate: []\n");
    gitIn(repo, "commit", "--quiet", "-am", "typo");
    const worktree = addTaskWorktree();
    const pi = fake(worktree);
    pi.holdTask("blocked");
    const opening = await openRun(pi.deps, pi.deps.session.snapshot!);
    expect(opening.failed).toStartWith("infra:");
  });
});

describe("the merge step", () => {
  test("a merge refusal (the task's wave is under review) fails the merge before anything: no commit, the target unmoved", async () => {
    const worktree = addTaskWorktree();
    const pi = fake(worktree);
    pi.holdTask("merging");
    writeFileSync(join(worktree, "task.txt"), "work\n");
    let asked = 0;
    pi.deps.wave = async () => {
      asked += 1;
      return { id: "w", mergeRefusal: "its wave is reviewing" };
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
    pi.deps.wave = async () => (wave === null ? null : { id: wave, mergeRefusal: null });
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
  test("an idle task ends cancelled, a busy one is aborted", async () => {
    const idle = fake(dir);
    idle.holdTask("blocked");
    expect(await cancelTask(idle.deps, idle.deps.session.snapshot!)).toEqual({ ok: true });
    expect(idle.states().at(-1)).toBe("cancelled/cancelled");
    expect(idle.deps.session.runner.cancelled).toBe(false);
    const busy = fake(dir);
    busy.holdTask("running");
    busy.flags.idle = false;
    expect(await cancelTask(busy.deps, busy.deps.session.snapshot!)).toEqual({ ok: true });
    expect(busy.flags.aborts).toBe(1);
    expect(busy.states()).toEqual(["running/test"]);
  });
});

describe("applyReviewed", () => {
  const review = (severities: ("blocker" | "major" | "minor")[]) => {
    const findings = severities.map((severity) => ({ file: "task.txt", line: 1, severity, text: `${severity} problem` }));
    return { round: 1, status: "ok", approved: severities.every((severity) => severity === "minor"), findings, model: null, sessionFile: null, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.1 }, wallMs: 1 };
  };
  const command = (severities: ("blocker" | "major" | "minor")[], round = 1) => JSON.stringify({ round, review: review(severities) });

  test("a verdict for another round, or a task not reviewing, changes nothing: delivered twice is applied once", async () => {
    const pi = fake(dir);
    pi.holdTask("reviewing");
    record(pi.deps, "factory-round", { round: 1, trigger: "start" });
    expect(await applyReviewed(pi.deps, pi.deps.session.snapshot!, command(["major"], 2))).toEqual({ ok: false, error: "the task is not reviewing round 2" });
    expect(await applyReviewed(pi.deps, pi.deps.session.snapshot!, command(["major"]))).toEqual({ ok: true });
    expect(await applyReviewed(pi.deps, pi.deps.session.snapshot!, command(["major"]))).toEqual({ ok: false, error: "the task is not reviewing round 1" });
    expect(pi.states()).toEqual(["reviewing/test", "running/review"]);
    expect(await applyReviewed(pi.deps, pi.deps.session.snapshot!, "{bad")).toMatchObject({ ok: false });
  });
});
