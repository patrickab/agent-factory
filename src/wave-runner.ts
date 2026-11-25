/**
 * The detached process that drives one wave to rest: `bun wave-runner.ts <wave id>`. No Pi session, no `OpsDeps`: the
 * pure steps (`git.ts`, `rebaseWorktree`, `mergeTask`, `runReview`, the merge queue) with the runner's own `Exec`.
 *
 * - Holds the wave's lock (`waveLockPath`) for its life: one runner per wave. A poke (`pokeWave`) hands it the lock
 *   (`WAVE_LOCK_ENV`); started by hand it takes the lock itself, and ends at once when a live runner holds it
 * - Loop: clear the poke marker, read the log, act on the stage, again. `building`: start the tasks whose predecessors
 *   are done (`startWaveTasks`), then `reviewing` once every task is done or cancelled (`cancelled` when all are);
 *   else wait for a poke or `POLL_MS`. `reviewing`: the review worktree on the wave's branch (`after_create` hooks of
 *   the target's tip run when it is made), the rebase onto the target unsquashed, the gates, the reviewer on the whole
 *   diff since the target; then `merging` (`waiting_approve` with the wave's `merge: review`), `rejected` or `blocked`.
 *   `merging`: the merge queue, merge gates and the fast-forward (`mergeTask` `asIs`), then `merged` or `blocked`
 * - Every step appends its event (`gate`, `review`, `merge`, `stage`). A stage change is a compare-and-append on the
 *   stage it left: a `waves.add` that moved the wave back to `building` meanwhile wins, and the loop goes on from there
 * - Resumable from the log: a runner started on a wave in `reviewing` or `merging` runs that step again from its start
 * - Invariant 2: the review worktree must hold nothing but HEAD's tree before the rebase, after it, and after the gates
 *   (their untracked output is removed); else `blocked`, `dirty`. Rules, gates and the reviewer prompt are read from
 *   the target's tip
 * - The review worktree is removed (`git worktree remove`, never forced: a dirty one stays, nothing is deleted) when the
 *   wave leaves `reviewing`/`merging` for anything but `merging`
 * - Ends when the wave rests: lets the lock go, then looks for a poke marker once more and runs on when there is one
 *   and it gets the lock back. SIGTERM/SIGINT: cancels the running commands and ends
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { loadTaskFiles, type FactoryConfig } from "./config.ts";
import { FactoryError, startWaveTasks, waveTaskViews } from "./core.ts";
import { abortLeftoverRebase, git, removeUntracked, taskBase, trackedChanges, treeDiff, uncommittedFiles } from "./git.ts";
import { runAfterCreate, worktreePath } from "./launch.ts";
import { mergeTask, rebaseWorktree } from "./merge.ts";
import { INFRA_EXIT } from "./pipeline.ts";
import { runReview } from "./review.ts";
import { CommandRunner, type CommandResult } from "./run.ts";
import { passed, type GateData, type Task } from "./state.ts";
import { lockFile, TaskBusyError } from "./tasks.ts";
import { errorText, outputTail } from "./util.ts";
import { clearPoke, WAVE_LOCK_ENV, waveLockPath, wavePokePath, waveReviewsDir } from "./wave-poke.ts";
import {
  allCancelled,
  appendWaveEvents,
  foldWave,
  readWave,
  readyForReview,
  RESTING_WAVE_STAGES,
  unlockWave,
  type NewWaveEvent,
  type WaveDeclaration,
  type WaveFold,
  type WaveReason,
  type WaveStage,
} from "./waves.ts";

/** How long a building wave waits for a poke before it looks at its tasks again. */
const POLL_MS = 10_000;
/** How often the wait looks for the poke marker. */
const MARKER_POLL_MS = 200;
/** How long a runner a poke started waits for the lock to be handed to it. */
const HAND_WAIT_MS = 10_000;

/** What one look at the wave asks for next: another look now, a wait for a poke, or the end (the wave rests). */
type Next = "again" | "wait" | "rest";

const runner = new CommandRunner();
let stopping = false;

function log(id: string, text: string): void {
  console.error(`${new Date().toISOString()} wave ${id.slice(0, 8)}: ${text}`);
}

/** The wave as a `Task` for the pure steps: its branch merges into its target, its request is the reviewer's. */
function waveTask(declaration: WaveDeclaration): Task {
  return {
    title: declaration.title,
    request: declaration.request,
    settings: { branch: declaration.target, merge: declaration.overrides.merge ?? "auto", maxRounds: 1, review: true, models: declaration.overrides.models ?? {} },
    branch: declaration.branch,
    mainBranch: declaration.target,
    baseSha: declaration.base,
  };
}

/** The review worktree's path: one per wave, next to the tasks' worktrees. */
function reviewWorktree(declaration: WaveDeclaration): string {
  return worktreePath(declaration.repo, `wave-${declaration.id.slice(0, 8)}-review`);
}

/** Appends `events` and the new stage when the wave is still at `from`. False when it moved on meanwhile. */
async function moveStage(id: string, from: WaveStage, to: WaveStage, reason: WaveReason | null, events: NewWaveEvent[] = []): Promise<boolean> {
  const written = await appendWaveEvents(id, (fold) => (fold.stage === from ? [...events, { kind: "stage", stage: to, reason }] : null));
  if (written === null) log(id, `left ${from} meanwhile: ${to} is not recorded`);
  else log(id, `${from} -> ${to}${reason ? ` (${reason})` : ""}`);
  return written !== null;
}

/** The rules of the target's tip. */
async function targetConfig(declaration: WaveDeclaration, root: string) {
  const tip = await git(runner.cleanup, root, ["rev-parse", `refs/heads/${declaration.target}`]);
  return loadTaskFiles(runner.cleanup, root, tip);
}

/**
 * The review worktree on the wave's branch: the existing one (a run before this one left it), else a new one with the
 * `after_create` hooks of the target's tip. A rebase a dead run left in progress is aborted.
 */
async function ensureWorktree(declaration: WaveDeclaration): Promise<string> {
  const path = reviewWorktree(declaration);
  if (!existsSync(path)) {
    await git(runner.cleanup, declaration.repo, ["worktree", "prune"]);
    await git(runner.cleanup, declaration.repo, ["worktree", "add", "--quiet", path, declaration.branch]);
    const { config } = await targetConfig(declaration, path);
    await runAfterCreate(runner.run, path, config.hooks.after_create);
  }
  await abortLeftoverRebase(runner.cleanup, path);
  return path;
}

/** Removes the review worktree unless it holds anything uncommitted: then it stays, nothing is deleted. */
async function removeWorktree(declaration: WaveDeclaration): Promise<void> {
  const path = reviewWorktree(declaration);
  if (!existsSync(path)) return;
  const result = await runner.cleanup(["git", "worktree", "remove", path], { cwd: declaration.repo });
  if (result.exitCode !== 0) log(declaration.id, `the review worktree ${path} stays: ${outputTail(result.output)}`);
}

/** One `gate` event of a run of commands: passed when every one passed, the output tail of the last one run. */
function gateEvent(phase: "review" | "merge", results: { result: Pick<CommandResult, "output" | "durationMs">; passed: boolean }[]): NewWaveEvent {
  const last = results.at(-1);
  return {
    kind: "gate",
    phase,
    passed: results.every((run) => run.passed),
    wallMs: results.reduce((sum, run) => sum + run.result.durationMs, 0),
    log: last === undefined ? null : outputTail(last.result.output),
  };
}

/** Why a failed gate blocks: `infra` when it exited `INFRA_EXIT`, else `gates`. */
function gateReason(result: Pick<CommandResult, "exitCode" | "killed">): WaveReason {
  return result.exitCode === INFRA_EXIT && !result.killed ? "infra" : "gates";
}

/** The reviewer's session id, from the name of its session file (`<time>_<id>.jsonl`). */
function sessionIdOf(sessionFile: string | null): string | null {
  if (sessionFile === null) return null;
  const name = basename(sessionFile, ".jsonl");
  return name.slice(name.lastIndexOf("_") + 1) || null;
}

/** `reviewing`: rebase, gates, reviewer, then the stage the verdict asks for. */
async function review(fold: WaveFold): Promise<void> {
  const { id } = fold;
  const task = waveTask(fold);
  const leave = async (to: WaveStage, reason: WaveReason | null, events: NewWaveEvent[] = []) => {
    const moved = await moveStage(id, "reviewing", to, reason, events);
    if (!moved || to !== "merging") await removeWorktree(fold);
  };
  let root: string;
  try {
    root = await ensureWorktree(fold);
  } catch (error) {
    log(id, `the review worktree: ${errorText(error)}`);
    return void (await moveStage(id, "reviewing", "blocked", "infra"));
  }
  try {
    const { config, prompts } = await targetConfig(fold, root);
    // The gates and the reviewer see the committed tree only: anything else in the worktree is somebody's work.
    if (await uncommittedFiles(runner.run, root)) return leave("blocked", "dirty");
    const conflicts = await rebaseWorktree(runner.run, runner.cleanup, root, task, config.protected, task.title, true);
    if (conflicts) {
      log(id, `the rebase onto ${fold.target} conflicts on ${conflicts.join(", ")}`);
      return leave("blocked", "conflict");
    }
    // The rebase brings the target's .gitignore: a file it stopped ignoring is no gate output.
    if (await uncommittedFiles(runner.run, root)) return leave("blocked", "dirty");
    const gates: { result: CommandResult; passed: boolean }[] = [];
    try {
      for (const argv of config.gates) {
        log(id, `gate ${argv.join(" ")}`);
        const result = await runner.run(argv, { cwd: root });
        gates.push({ result, passed: passed(result) });
        if (!passed(result)) break;
      }
    } finally {
      // The worktree was clean before the gates: what lies untracked now is their output.
      await removeUntracked(runner.cleanup, root);
    }
    const gate = gates.length === 0 ? [] : [gateEvent("review", gates)];
    const failed = gates.find((run) => !run.passed);
    if (failed) return leave("blocked", gateReason(failed.result), gate);
    // A gate that rewrote a tracked file passed on a tree the target would never get.
    if (await trackedChanges(runner.run, root)) return leave("blocked", "dirty", gate);
    if (gate.length > 0 && (await appendWaveEvents(id, (now) => (now.stage === "reviewing" ? gate : null))) === null) return removeWorktree(fold);

    const base = await taskBase(runner.run, root, task);
    const diff = await treeDiff(runner.run, root, base, await git(runner.run, root, ["rev-parse", "HEAD^{tree}"]), config.lockfiles);
    // Nothing differs from the target: nothing to review or merge.
    if (diff.paths.length === 0) return leave("merged", null);
    const round = fold.reviews.length + 1;
    log(id, `review round ${round}`);
    const data = await runReview({
      exec: runner.run,
      root,
      round,
      task,
      followUps: [],
      diff,
      model: fold.overrides.models?.reviewer ?? null,
      rolePrompt: prompts.reviewer,
      reviewsDir: waveReviewsDir(id),
      cancelled: () => runner.cancelled,
      wave: true,
    });
    const verdict = data.status !== "ok" ? "failed" : data.approved ? "approved" : "rejected";
    const event: NewWaveEvent = {
      kind: "review",
      round,
      sessionId: sessionIdOf(data.sessionFile),
      model: data.model,
      verdict,
      status: data.status,
      findings: data.findings.map((finding) => ({ severity: finding.severity, file: finding.file, line: finding.line, text: finding.text })),
      usage: { input: data.usage.input, output: data.usage.output, cost: data.usage.cost },
      wallMs: data.wallMs,
    };
    if (verdict === "failed") return leave("blocked", "review_failed", [event]);
    if (verdict === "rejected") return leave("rejected", null, [event]);
    return leave(fold.overrides.merge === "review" ? "waiting_approve" : "merging", null, [event]);
  } catch (error) {
    log(id, `review: ${errorText(error)}`);
    return leave("blocked", "infra");
  }
}

/** `merging`: the merge queue, merge gates and the fast-forward of the target. */
async function merge(fold: WaveFold): Promise<void> {
  const { id } = fold;
  const task = waveTask(fold);
  const leave = async (to: WaveStage, reason: WaveReason | null, events: NewWaveEvent[] = []) => {
    await moveStage(id, "merging", to, reason, events);
    await removeWorktree(fold);
  };
  let root: string;
  let config: FactoryConfig;
  try {
    root = await ensureWorktree(fold);
    config = (await targetConfig(fold, root)).config;
  } catch (error) {
    log(id, `the merge worktree: ${errorText(error)}`);
    return leave("blocked", "infra");
  }
  const started = Date.now();
  let queueMs = 0;
  let queued = false;
  let before: string | null = null;
  const status = (text: string) => {
    log(id, `merge: ${text}`);
    if (text.startsWith("queued for merge")) queued = true;
    else if (queued) {
      queued = false;
      queueMs = Date.now() - started;
    }
  };
  const outcome = await mergeTask({
    exec: runner.run,
    cleanup: runner.cleanup,
    root,
    round: fold.reviews.length,
    task,
    config,
    intent: (data) => {
      before = data.before;
    },
    status,
    asIs: true,
  });
  const gates = outcome.gates.filter((gate: GateData) => gate.phase === "merge_gates");
  const gate = gates.length === 0 ? [] : [gateEvent("merge", gates.map((data) => ({ result: { output: data.outputTail, durationMs: data.durationMs }, passed: data.exitCode === 0 && !data.killed })))];
  const { result } = outcome;
  switch (result.kind) {
    case "merged":
      return leave("merged", null, [...gate, { kind: "merge", from: before ?? result.merge.commit ?? "", to: result.merge.commit ?? "", queueMs }]);
    case "conflict":
      log(id, `the rebase onto ${fold.target} conflicts on ${result.files.join(", ")}`);
      return leave("blocked", "conflict", gate);
    case "gate_failed":
      return leave("blocked", gateReason(result.gate.result), gate);
    case "dirty":
      return leave("blocked", "dirty", gate);
    case "failed":
      log(id, `merge failed: ${result.merge.error ?? "unknown"}`);
      return leave("blocked", "infra", gate);
  }
}

/** One look at the wave and the step its stage asks for. */
async function step(id: string): Promise<Next> {
  const { declaration, events } = await readWave(id);
  const fold = foldWave(declaration, events);
  if (RESTING_WAVE_STAGES.includes(fold.stage)) return "rest";
  if (fold.stage === "reviewing") {
    await review(fold);
    return "again";
  }
  if (fold.stage === "merging") {
    await merge(fold);
    return "again";
  }
  // building
  const { states } = await waveTaskViews(fold);
  if (allCancelled(fold, states)) return (await moveStage(id, "building", "cancelled", null)) ? "rest" : "again";
  if (readyForReview(fold, states)) {
    await moveStage(id, "building", "reviewing", null);
    return "again";
  }
  const env = { ...process.env };
  delete env[WAVE_LOCK_ENV];
  try {
    const started = await startWaveTasks(id, env);
    if (started.length > 0) log(id, `started ${started.join(", ")}`);
  } catch (error) {
    log(id, errorText(error));
  }
  return "wait";
}

/** Waits until a poke marker appears, `POLL_MS` passes or the runner stops. */
async function waitForPoke(id: string): Promise<void> {
  const deadline = Date.now() + POLL_MS;
  while (!stopping && Date.now() < deadline && !existsSync(wavePokePath(id))) await Bun.sleep(MARKER_POLL_MS);
}

/** Whether this process holds the wave's lock now: handed by a poke (waits for the hand), else taken. */
async function takeLock(id: string): Promise<boolean> {
  const own = async () => (await readFile(waveLockPath(id), "utf8").catch(() => "")).split(" ")[0] === String(process.pid);
  if (process.env[WAVE_LOCK_ENV]) {
    const deadline = Date.now() + HAND_WAIT_MS;
    while (Date.now() < deadline) {
      if (await own()) return true;
      await Bun.sleep(20);
    }
    return false;
  }
  try {
    await lockFile(waveLockPath(id), `wave ${id.slice(0, 8)} has a runner`);
    return true;
  } catch (error) {
    if (error instanceof TaskBusyError) return false;
    throw error;
  }
}

/** Runs the wave until it rests (or the runner stops); the caller holds the lock. */
async function drive(id: string): Promise<void> {
  while (!stopping) {
    await clearPoke(id);
    let next: Next;
    try {
      next = await step(id);
    } catch (error) {
      log(id, `step: ${errorText(error)}`);
      // A removed wave has nothing left to drive.
      if (error instanceof FactoryError && error.code === "not_found") return;
      next = "wait";
    }
    if (next === "rest") return;
    if (next === "wait") await waitForPoke(id);
  }
}

export async function runWave(id: string): Promise<number> {
  if (!(await takeLock(id))) {
    log(id, "another runner holds the wave");
    return 0;
  }
  const stop = (signal: NodeJS.Signals) => {
    log(id, `${signal}, stopping`);
    stopping = true;
    runner.cancel();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    for (;;) {
      await drive(id);
      await unlockWave(id);
      // A poke that found the lock still taken left its marker for this runner: look again if nobody else took over.
      if (stopping || !existsSync(wavePokePath(id))) return 0;
      try {
        await lockFile(waveLockPath(id), "");
      } catch (error) {
        if (error instanceof TaskBusyError) return 0;
        throw error;
      }
    }
  } finally {
    await unlockWave(id).catch(() => undefined);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}

if (import.meta.main) {
  const [id] = process.argv.slice(2);
  if (!id) {
    console.error("usage: bun wave-runner.ts <wave id>");
    process.exit(2);
  }
  runWave(id)
    .catch((error: unknown) => {
      log(id, errorText(error));
      return 1;
    })
    .then((code) => process.exit(code));
}
