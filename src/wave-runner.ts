/**
 * The detached process that drives one wave to rest: `bun wave-runner.ts <wave id>`. No Pi session: the pure steps
 * (`git.ts`, `rebaseWorktree`, `mergeTask`, `review-each.ts`, the merge queue) with the runner's own `Exec`.
 * - Holds the wave's lock for its life (one runner per wave) and loops: clear the poke marker, read the log, act on the
 *   stage (`step`: `build`, `review`, `merge`)
 * - A stage change is a compare-and-append on the stage it left: a `waves.add` that came first wins
 * - Resumable from the log: a stopping runner records no stage change, the next one runs that step again from its start
 */
import { existsSync, realpathSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { withoutPaths } from "./agent-view.ts";
import { loadTaskFiles, type FactoryConfig } from "./config.ts";
import { oneLine } from "./core-shared.ts";
import { abortLeftoverRebase, git, removeUntracked, taskBase, treeDiff, worktreeChanges } from "./git.ts";
import { runGateStep } from "./flaky-rerun.ts";
import { runAfterCreate } from "./launch.ts";
import { mergeTask, rebaseWorktree, type SquashLanding } from "./merge.ts";
import { CONFLICT_TASKS, conflictTask, pokeQueuedAfter, REVIEWER_FIX_CAP, reviewerFixEvents, startQueuedWave, startWaveTasks, undoConflictBranch, waveReviewWorktree, waveTaskViews } from "./core-waves.ts";
import { fitFix, reviewFit, reviewNext, type ReviewEachDeps } from "./review-each.ts";
import { CommandRunner, type CommandResult } from "./run.ts";
import { INFRA_EXIT, passed, type GateData, type Task } from "./state.ts";
import { errorText, FactoryError, isBusy, outputTail } from "./util.ts";
import { clearPoke, lockWave, waveLockPath, wavePokePath } from "./wave-poke.ts";
import { unlockFile } from "./lock.ts";
import {
  allCancelled,
  appendWaveEvents,
  readWave,
  readyForReview,
  waveRests,
  stuckKeys,
  type NewWaveEvent,
  type WaveDeclaration,
  type WaveFold,
  type WaveMerge,
  type WaveReason,
  type WaveStage,
} from "./waves.ts";

/**
 * How long a building wave waits for a poke before it looks at its tasks again. `FACTORY_WAVE_POLL_MS` (tests only)
 * sets it: a test proves a poke wakes the runner, not this poll.
 */
const POLL_MS = Number(process.env.FACTORY_WAVE_POLL_MS) || 10_000;
/** How often the wait looks for the poke marker. */
const MARKER_POLL_MS = 200;
/** How long a runner waits for the lock: a poke that started it hands it over right after the spawn. */
const HAND_WAIT_MS = 10_000;

/** What one look at the wave asks for next: another look now, a wait for a poke, or the end (the wave rests). */
type Next = "again" | "wait" | "rest";

const runner = new CommandRunner();
let stopping = false;
/** Aborted when the runner stops: the launch of a task in progress is undone, no further one starts. */
const stopped = new AbortController();

function log(id: string, text: string): void {
  console.error(`${new Date().toISOString()} wave ${id.slice(0, 8)}: ${text}`);
}

/** The wave as a `Task` for the pure steps: its branch merges into its target, its request is the reviewer's. */
function waveTask(declaration: WaveFold): Task {
  return {
    title: declaration.title,
    request: declaration.request,
    settings: { branch: declaration.target, merge: declaration.overrides.merge ?? "auto", maxRounds: 1, review: true, models: {} },
    branch: declaration.branch,
    mainBranch: declaration.target,
    baseSha: declaration.base,
  };
}

/** A stage change: where to, why, and the events that go before its `stage` event. */
type StageChoice = { to: WaveStage; reason: WaveReason | null; detail: string | null; events: NewWaveEvent[] };
/** Chooses a stage change from the wave's fold read under its log lock. */
type Chooser = (now: WaveFold) => StageChoice;

function choice(to: WaveStage, reason: WaveReason | null, detail: string | null = null, events: NewWaveEvent[] = []): Chooser {
  return () => ({ to, reason, detail, events });
}

/** Whether `choose` lands the merge of the step at `fold`; `merge`'s choosers do not look at the fold they get. */
const landed = (fold: WaveFold, choose: Chooser | null) => fold.stage === "merging" && choose?.(fold).to === "merged";

/**
 * The one stage change of the runner: a compare-and-append on `from` (`appendWaveEvents`), the change chosen under the
 * log lock so nothing appended meanwhile makes it stale. Resolves with the recorded choice, null when none (no
 * chooser, the wave left `from`, the runner stops). Its two rules:
 * - a stopping runner records nothing but a landed merge: a step the stop cut short (a killed gate, an aborted
 *   reviewer or launch) says nothing about the wave
 * - the detail is stored without paths (`pathFree`, invariant 10)
 */
async function moveStage(fold: WaveFold, from: WaveStage, choose: Chooser | null): Promise<StageChoice | null> {
  if (choose === null) return null;
  const { id } = fold;
  if (stopping && !landed(fold, choose)) {
    log(id, `stopping: leaving ${from} is not recorded, the wave stays ${from}`);
    return null;
  }
  let chosen: StageChoice | null = null;
  const written = await appendWaveEvents(id, (now) => {
    if (now.stage !== from) return null;
    const made = choose(now);
    chosen = { ...made, detail: made.detail === null ? null : pathFree(fold, made.detail) };
    const { to, reason, detail, events } = chosen;
    return [...events, { kind: "stage", stage: to, reason, ...(detail === null ? {} : { detail }) }];
  });
  const recorded = written === null ? null : (chosen as StageChoice | null);
  if (recorded === null) log(id, `left ${from} meanwhile: the stage change is not recorded`);
  else log(id, `${from} -> ${recorded.to}${recorded.reason ? ` (${recorded.reason})` : ""}${recorded.detail === null ? "" : `: ${recorded.detail}`}`);
  return recorded;
}

/** How many paths a `dirty` detail names. */
const DIRTY_PATHS_SHOWN = 20;

/**
 * `detail` as the stage event stores it: no path (invariant 10). The review worktree is named by its wave, a path in
 * the repository is made relative, any other absolute path is `<path>`; the text with its paths goes to the log.
 */
function pathFree(declaration: WaveDeclaration, detail: string): string {
  const relative = detail
    .split(waveReviewWorktree(declaration))
    .join(`the review worktree of wave ${declaration.id.slice(0, 8)}`)
    .split(`${declaration.repo}/`)
    .join("")
    .split(declaration.repo)
    .join("the repository");
  // The wave log has no slash commands: a single-segment path (`/workspace`) goes too.
  const named = withoutPaths(relative).replace(/(^|[\s'"`(=])\/[^\s'"`),;/]+(?=$|[\s'"`),;])/g, "$1<path>");
  if (named !== detail) log(declaration.id, `with its paths: ${detail}`);
  return named;
}

/** Why the worktree at `root` is dirty: what it holds besides its commit (`git status` paths); `pathFree` names it. */
async function dirtyDetail(root: string): Promise<string> {
  const status = await runner.cleanup(["git", "status", "--porcelain", "--untracked-files=normal"], { cwd: root, maxStdoutChars: 100_000 });
  const paths = status.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.slice(3));
  const shown = paths.slice(0, DIRTY_PATHS_SHOWN).join(", ") + (paths.length > DIRTY_PATHS_SHOWN ? ` and ${paths.length - DIRTY_PATHS_SHOWN} more` : "");
  return `${root} holds what its commit does not (${shown || "unknown paths"}): commit or remove it there, then waves.retry`;
}

/** Why a gate run failed, for the stage's detail (its output tail is in the `gate` event). */
function gateDetail(argv: string[], result: Pick<CommandResult, "exitCode" | "killed" | "timedOut">): string {
  const how = result.timedOut ? "timed out" : result.killed ? "was killed" : `exited ${result.exitCode}`;
  return `the gate ${argv.join(" ")} ${how}`;
}

/** How often a running review looks at the log for a stage change. */
const STAGE_POLL_MS = 250;

/**
 * Runs `act` while watching the wave's log: once the wave left `stage` (a `waves.add` moved it back to `building`,
 * the wave was removed) the running commands are killed, so the step ends at once; its stage change then loses its
 * compare-and-append. The commands run again afterwards unless the runner stops.
 */
async function whileAt<T>(id: string, stage: WaveStage, act: () => Promise<T>): Promise<T> {
  let done = false;
  const watch = (async () => {
    while (!done) {
      await Bun.sleep(STAGE_POLL_MS);
      if (done) return;
      const now = await readWave(id).then(
        (file) => file.fold.stage,
        (error: unknown) => (error instanceof FactoryError && error.code === "not_found" ? "removed" : stage),
      );
      if (now !== stage) {
        log(id, `the wave left ${stage} (${now}): stopping the running step`);
        runner.cancel();
        return;
      }
    }
  })();
  try {
    return await act();
  } finally {
    done = true;
    await watch;
    if (!stopping) runner.reset();
  }
}

/** The rules of the target's tip. */
async function targetConfig(declaration: WaveDeclaration, root: string) {
  const tip = await git(runner.cleanup, root, ["rev-parse", `refs/heads/${declaration.target}`]);
  return loadTaskFiles(runner.cleanup, root, tip);
}

/**
 * The review worktree on the wave's branch: the existing one (a run before this one left it), else a new one with the
 * `after_create` hooks of the target's tip. A new one whose hooks fail is removed again (as `launchTask` does for a
 * task): a later run prepares a fresh one rather than reuse one the hooks never finished. A rebase a dead run left in
 * progress is aborted. A directory at its path that is no valid worktree of the repository (a runner killed while git
 * added or removed it left it without a usable `.git`) is removed first and the worktree list pruned.
 */
async function ensureWorktree(declaration: WaveFold): Promise<string> {
  const path = waveReviewWorktree(declaration);
  if (existsSync(path) && !(await validWorktree(declaration.repo, path))) {
    log(declaration.id, `the review worktree ${path} is no valid worktree of the repository: removed`);
    await rm(path, { recursive: true, force: true });
    await git(runner.cleanup, declaration.repo, ["worktree", "prune"]);
  }
  if (!existsSync(path)) {
    await git(runner.cleanup, declaration.repo, ["worktree", "prune"]);
    await git(runner.cleanup, declaration.repo, ["worktree", "add", "--quiet", path, declaration.branch]);
    try {
      const { config } = await targetConfig(declaration, path);
      await runAfterCreate(runner.run, path, config.hooks.after_create);
    } catch (error) {
      await runner.cleanup(["git", "worktree", "remove", "--force", path], { cwd: declaration.repo });
      await runner.cleanup(["git", "worktree", "prune"], { cwd: declaration.repo });
      throw error;
    }
  }
  await abortLeftoverRebase(runner.cleanup, path);
  return path;
}

/** Whether `path` is a worktree git lists for `repo` (not prunable) and whose top level git resolves to `path`. */
async function validWorktree(repo: string, path: string): Promise<boolean> {
  const real = realpathSync(path);
  const list = await git(runner.cleanup, repo, ["worktree", "list", "--porcelain"]);
  const entry = list.split("\n\n").find((block) => {
    const listed = block.split("\n")[0].replace(/^worktree /, "");
    return existsSync(listed) && realpathSync(listed) === real;
  });
  if (entry === undefined || entry.split("\n").some((line) => line.startsWith("prunable"))) return false;
  const top = await git(runner.cleanup, path, ["rev-parse", "--show-toplevel"]).catch(() => null);
  return top !== null && top !== "" && existsSync(top) && realpathSync(top) === real;
}

/**
 * Removes the review worktree unless it holds anything uncommitted: then it stays, nothing is deleted. (A stopping
 * runner's steps leave it to the resume.)
 */
async function removeWorktree(declaration: WaveDeclaration): Promise<void> {
  const path = waveReviewWorktree(declaration);
  if (!existsSync(path)) return;
  const result = await runner.cleanup(["git", "worktree", "remove", path], { cwd: declaration.repo });
  if (result.exitCode !== 0) log(declaration.id, `the review worktree ${path} stays: ${outputTail(result.output)}`);
}

/** One `gate` event of a run of commands: passed when every one passed, the output tail of the last one run. */
function gateEvent(
  phase: "review" | "merge",
  results: { result: Pick<CommandResult, "output" | "durationMs">; passed: boolean; flaky?: string[] | null }[],
  commit: string | null = null,
): NewWaveEvent {
  const last = results.at(-1);
  const flaky = results.flatMap((run) => run.flaky ?? []);
  return {
    kind: "gate",
    phase,
    passed: results.every((run) => run.passed),
    wallMs: results.reduce((sum, run) => sum + run.result.durationMs, 0),
    log: last === undefined ? null : outputTail(last.result.output),
    ...(commit === null ? {} : { commit }),
    ...(flaky.length === 0 ? {} : { flaky }),
  };
}

/** Why a failed gate blocks: `infra` when it exited `INFRA_EXIT`, else `gates`. */
function gateReason(result: Pick<CommandResult, "exitCode" | "killed">): WaveReason {
  return result.exitCode === INFRA_EXIT && !result.killed ? "infra" : "gates";
}

/**
 * `reviewing`: rebase, `merge_gates` (the full suite, once per wave: its tasks ran only what they reach; a failure
 * blocks, `gates`, before any reviewer starts), reviewer, then the stage the verdict asks for. The gate event names
 * the commit they passed on: the merge runs them again only on another one.
 */
async function review(fold: WaveFold): Promise<Chooser | null> {
  const { id } = fold;
  const task = waveTask(fold);
  let root: string;
  try {
    root = await ensureWorktree(fold);
  } catch (error) {
    return choice("blocked", "infra", `the review worktree: ${oneLine(errorText(error))}`);
  }
  try {
    const { config } = await targetConfig(fold, root);
    // The gates and the reviewer see the committed tree only: anything else in the worktree is somebody's work.
    if (await worktreeChanges(runner.run, root, true)) return choice("blocked", "dirty", await dirtyDetail(root));
    const conflicts = await rebaseWorktree(runner.run, runner.cleanup, root, task.mainBranch);
    if (conflicts) return conflicted(fold, "review", conflicts);
    // The rebase brings the target's .gitignore: a file it stopped ignoring is no gate output.
    if (await worktreeChanges(runner.run, root, true)) return choice("blocked", "dirty", await dirtyDetail(root));
    const gated = await git(runner.run, root, ["rev-parse", "HEAD"]);
    const gates: { argv: string[]; result: CommandResult; passed: boolean; flaky: string[] | null }[] = [];
    try {
      for (const argv of config.merge_gates) {
        log(id, `gate ${argv.join(" ")}`);
        const { result, flaky } = await runGateStep(argv, (env) => runner.run(argv, { cwd: root, env }), () => stopping);
        gates.push({ argv, result, passed: passed(result), flaky });
        if (!passed(result)) break;
      }
    } finally {
      // The worktree was clean before the gates: what lies untracked now is their output.
      await removeUntracked(runner.cleanup, root);
    }
    const gate = gates.length === 0 ? [] : [gateEvent("review", gates, gated)];
    const failed = gates.find((run) => !run.passed);
    if (failed) return choice("blocked", gateReason(failed.result), gateDetail(failed.argv, failed.result), gate);
    // A gate that rewrote a tracked file passed on a tree the target would never get.
    if (await worktreeChanges(runner.run, root, false)) return choice("blocked", "dirty", await dirtyDetail(root), gate);
    if (gate.length > 0 && (await appendWaveEvents(id, (now) => (now.stage === "reviewing" ? gate : null))) === null) return null;

    const base = await taskBase(runner.run, root, task);
    const diff = await treeDiff(runner.run, root, base, await git(runner.run, root, ["rev-parse", "HEAD^{tree}"]));
    // Nothing differs from the target: nothing to review or merge. Unless a conflict moved the branch onto the target
    // and done tasks' change is no longer on it: that is no merge.
    if (diff.paths.length === 0) {
      const { states } = await waveTaskViews(fold);
      const done = fold.tasks.filter((spec) => states.get(spec.key) === "done").map((spec) => spec.key);
      if (done.length > 0 && fold.conflicts.length > 0) {
        return choice("blocked", "conflict", `nothing differs from ${fold.target} though ${done.length === 1 ? "task" : "tasks"} ${done.join(", ")} ${done.length === 1 ? "is" : "are"} done and a conflict moved the branch: the wave's change is lost, not merged; waves.cancel, or put ${fold.branch} back by hand and waves.retry`);
      }
      return choice("merged", null);
    }
    const round = fold.reviews.length + 1;
    log(id, `review round ${round}`);
    // The wave's reviewer session, which judged each task, passes once on how they fit together.
    const fit = await reviewFit(fold, { root, round, diff }, { ...reviewEachDeps, log: (text) => log(id, text) });
    // Cut short: the step runs again (or the stage moved on, or the runner stops).
    if (fit === null) return null;
    const { sessionId, model, verdict, status, findings, usage, wallMs } = fit;
    const event: Extract<NewWaveEvent, { kind: "review" }> = { kind: "review", round, sessionId, model, verdict, status, findings, usage, wallMs };
    if (verdict === "failed") {
      const why = fit.edited.length > 0 ? `the reviewer changed its worktree (${fit.edited.join(", ")}), its verdict is void` : `the reviewer gave no verdict (${status})`;
      return choice("blocked", "review_failed", why, [event]);
    }
    return (now) => afterFit(fold, now, round, event);
  } catch (error) {
    return choice("blocked", "infra", `review: ${oneLine(errorText(error))}`);
  }
}

/** The count of `findings` that reject, as text: `1 major`, `2 blocker and 1 major`. */
function rejecting(findings: readonly { severity: string }[]): string {
  const count = (severity: string) => findings.filter((finding) => finding.severity === severity).length;
  return [
    [count("blocker"), "blocker"],
    [count("major"), "major"],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, severity]) => `${n} ${severity}`)
    .join(" and ");
}

/**
 * The stage after a wave's fit pass, chosen from `now`, the wave's fold under its log lock: approved goes on
 * to merge; its blocker and major findings become one `fix:` task (`reviewerFixEvents`, counted against
 * `REVIEWER_FIX_CAP`) and the wave builds again; with the cap used up the wave is `rejected` to the supervisor. A task
 * added since `fold` (the reviewer's `start_fix` during the pass, a supervisor's `waves.add`) builds too.
 */
function afterFit(fold: WaveFold, now: WaveFold, round: number, event: Extract<NewWaveEvent, { kind: "review" }>): StageChoice {
  const added = now.tasks.filter((spec) => !fold.tasks.some((before) => before.key === spec.key)).map((spec) => spec.key);
  if (added.length > 0) return { to: "building", reason: null, detail: `the reviewer added ${added.join(", ")} in its pass on how the tasks fit together`, events: [event] };
  if (event.verdict === "approved") return { to: fold.overrides.merge === "review" ? "waiting_approve" : "merging", reason: null, detail: null, events: [event] };
  const found = `the pass on how the tasks fit together found ${rejecting(event.findings)}`;
  const fix = reviewerFixEvents(now, fitFix(round, event.findings));
  if (fix === null) return { to: "rejected", reason: null, detail: `${found}; the wave's ${REVIEWER_FIX_CAP} fix tasks are used up`, events: [event] };
  return { to: "building", reason: null, detail: `${found}: task ${fix.key} fixes it`, events: [event, ...fix.events] };
}

/**
 * A conflict: the wave builds again with a conflict task, or (after `CONFLICT_TASKS`) blocks, `conflict`. `events` go
 * before the step's own.
 */
function conflicted(fold: WaveFold, phase: "review" | "merge", files: readonly string[], events: NewWaveEvent[] = []): Promise<Chooser> {
  const detail = `the rebase onto ${fold.target} conflicts on ${files.join(", ")}`;
  return conflictTask(fold, phase, files).then(
    (task) => (task === null ? choice("blocked", "conflict", `${detail}; its ${CONFLICT_TASKS} conflict tasks are used up`, events) : choice("building", null, `${detail}: task ${task.key} resolves it`, [...events, ...task.events])),
    (error: unknown) => choice("blocked", "infra", `${detail}; adding its conflict task failed: ${oneLine(errorText(error))}`, events),
  );
}

/** `refs/factory/waves/<tag with "/" as "-">-<first 8 of the id>`: where a `squash` wave keeps its task commits. */
export function waveCommitsRef(declaration: Pick<WaveDeclaration, "id" | "tag">): string {
  return `refs/factory/waves/${declaration.tag.replaceAll("/", "-")}-${declaration.id.slice(0, 8)}`;
}

/** A `squash` wave's commit message: its title, one `- <subject>` per commit, its tag and the ref of its commits. */
export function squashMessage(declaration: Pick<WaveDeclaration, "id" | "tag" | "title">, subjects: readonly string[]): string {
  return `${declaration.title}\n\n${subjects.map((subject) => `- ${subject}`).join("\n")}\n\nWave: ${declaration.tag}\nCommits: ${waveCommitsRef(declaration)}`;
}

/** What a landed `squash` wave's `merge` event says: the target's range and the ref of its commits. */
type SquashLanded = { from: string; to: string; ref: string; commits: number };

/**
 * Whether the target's tip is this `squash` wave's landing, from git alone: its ref exists and the tip is the ref's
 * commit (a wave of one commit) or has the ref's tree and the wave's message. Null when not (or no ref).
 */
async function landedSquash(fold: WaveFold): Promise<SquashLanded | null> {
  const ref = waveCommitsRef(fold);
  const exec = runner.cleanup;
  const verify = (name: string) => git(exec, fold.repo, ["rev-parse", "--verify", "--quiet", `${name}^{commit}`]).catch(() => null);
  const head = await verify(ref);
  if (head === null) return null;
  const to = await git(exec, fold.repo, ["rev-parse", `refs/heads/${fold.target}^{commit}`]);
  const from = await verify(`${to}^`);
  if (from === null) return null;
  const log = await git(exec, fold.repo, ["log", "--reverse", "--format=%s", `${from}..${head}`]);
  const subjects = log === "" ? [] : log.split("\n");
  if (to !== head) {
    const [tip, kept] = await Promise.all([git(exec, fold.repo, ["rev-parse", `${to}^{tree}`]), git(exec, fold.repo, ["rev-parse", `${head}^{tree}`])]);
    // A wave of one commit lands as that commit.
    if (tip !== kept || subjects.length < 2) return null;
    if ((await git(exec, fold.repo, ["show", "-s", "--format=%B", to])) !== squashMessage(fold, subjects)) return null;
  }
  return { from, to, ref, commits: subjects.length };
}

/** Deletes a landed `squash` wave's branch, its review worktree first (git refuses a branch checked out). Logs a failure. */
async function dropBranch(fold: WaveFold): Promise<void> {
  await removeWorktree(fold);
  if ((await runner.cleanup(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${fold.branch}`], { cwd: fold.repo })).exitCode !== 0) return;
  const deleted = await runner.cleanup(["git", "branch", "-D", fold.branch], { cwd: fold.repo });
  if (deleted.exitCode !== 0) log(fold.id, `the branch ${fold.branch} stays: ${outputTail(deleted.output)}`);
}

/**
 * `merging`: the merge queue, merge gates and the fast-forward of the target. The merge gates are skipped on the
 * commit they passed on before the review (`gatedCommit`): they run again only when the target moved since.
 */
async function merge(fold: WaveFold): Promise<Chooser> {
  const { id } = fold;
  const task = waveTask(fold);
  const squash = fold.overrides.squash === true;
  /** The end of a landing: the branch gone (`squash`), the `merge` event. */
  const landed = async (merge: Omit<WaveMerge, "at">, gate: NewWaveEvent[]) => {
    if (squash) await dropBranch(fold);
    // The target moved: that is recorded even when the runner stops, the merge is not run twice.
    return choice("merged", null, null, [...gate, { kind: "merge", ...merge }]);
  };
  // A runner that died after the target moved: the landing is finished, never made twice.
  if (squash) {
    const done = await landedSquash(fold).catch((error: unknown) => {
      log(id, `looking for a landing failed: ${errorText(error)}`);
      return null;
    });
    if (done !== null) return landed(done, []);
  }
  const landing: SquashLanding | undefined = squash ? { ref: waveCommitsRef(fold), message: (subjects) => squashMessage(fold, subjects) } : undefined;
  let root: string;
  let config: FactoryConfig;
  try {
    root = await ensureWorktree(fold);
    config = (await targetConfig(fold, root)).config;
  } catch (error) {
    return choice("blocked", "infra", `the merge worktree: ${oneLine(errorText(error))}`);
  }
  let before: string | null = null;
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
    status: (text) => log(id, `merge: ${text}`),
    asIs: true,
    gated: fold.gatedCommit,
    stop: () => stopping,
    ...(landing === undefined ? {} : { squash: landing }),
  });
  const gates = outcome.gates.filter((gate: GateData) => gate.phase === "merge_gates");
  const gate = gates.length === 0 ? [] : [gateEvent("merge", gates.map((data) => ({ result: { output: data.outputTail, durationMs: data.durationMs }, passed: data.exitCode === 0 && !data.killed, flaky: data.flaky })))];
  const { result } = outcome;
  switch (result.kind) {
    case "merged": {
      const range = { from: before ?? result.merge.commit ?? "", to: result.merge.commit ?? "" };
      // The ref and the count from git: the commits the target's new tip stands for.
      const squashed = squash ? await landedSquash(fold).catch(() => null) : null;
      const { stashConflicts } = result.merge;
      return landed({ ...(squashed ?? range), ...(stashConflicts ? { stashConflicts } : {}) }, gate);
    }
    case "conflict":
      return conflicted(fold, "merge", result.files, gate);
    case "gate_failed":
      return choice("blocked", gateReason(result.gate.result), gateDetail(result.gate.argv, result.gate.result), gate);
    case "dirty":
      return choice("blocked", "dirty", await dirtyDetail(root), gate);
    case "failed":
      return choice("blocked", "infra", `the merge failed: ${oneLine(result.merge.error ?? "unknown")}`, gate);
  }
}

/**
 * One look at the wave and the step its stage asks for. `queued`: starts when every wave it waits for is merged
 * (`startQueuedWave`), else rests until one of them pokes it. `merged`: pokes the queued waves that wait for it.
 */
async function step(id: string): Promise<Next> {
  const { fold } = await readWave(id);
  if (fold.stage === "queued") return (await startQueuedWave(id)) ? "again" : "rest";
  if (fold.stage === "merged") {
    for (const failure of await pokeQueuedAfter(id, process.env)) log(id, `poking a queued wave failed: ${failure}`);
  }
  if (waveRests(fold.stage)) return "rest";
  if (fold.stage === "building") return build(fold);
  const choose = fold.stage === "reviewing" ? await whileAt(id, "reviewing", () => review(fold)) : await merge(fold);
  const chosen = await moveStage(fold, fold.stage, choose);
  // The review worktree goes unless the wave goes on to merge; a stopping runner leaves it to the resume.
  if ((!stopping || landed(fold, choose)) && chosen?.to !== "merging") await removeWorktree(fold);
  return "again";
}

/**
 * `building`: the next stage once every task finished, else start what can start. A launch that fails blocks the
 * wave; tasks that can never start while nothing else runs make the runner rest (the stage's detail names them, once).
 */
async function build(fold: WaveFold): Promise<Next> {
  const { id } = fold;
  const { states } = await waveTaskViews(fold);
  // A cancelled or removed conflict task left the branch on the target's tip: back to its own, and blocked.
  const undone = await undoConflictBranch(fold, states);
  const move = async (to: WaveStage, reason: WaveReason | null, detail: string | null = null) => ((await moveStage(fold, "building", choice(to, reason, detail))) === null ? "again" : "rest");
  if (undone !== null) return move("blocked", "conflict", undone);
  if (allCancelled(fold, states)) return move("cancelled", null);
  if (readyForReview(fold, states)) {
    await move("reviewing", null);
    return "again";
  }
  const env = process.env;
  try {
    const started = await startWaveTasks(id, env, stopped.signal);
    if (started.length > 0) {
      log(id, `started ${started.join(", ")}`);
      return "again";
    }
  } catch (error) {
    // A launch that failed: as `tasks.start` would tell its caller, the wave tells the supervisor.
    if (!(error instanceof FactoryError) || (error.code !== "refused" && error.code !== "failed")) throw error;
    return move("blocked", "infra", `${error.message}; waves.retry starts it again`);
  }
  // A stopping runner started what it could not stop; it judges nothing more.
  if (stopping) return "wait";
  // The tasks resting `reviewing`, one review after another.
  const next = await reviewNext(fold, states, { ...reviewEachDeps, env, log: (text) => log(id, text) });
  if (typeof next === "string") return move("blocked", "infra", next);
  if (next) return "again";
  const stuck = stuckKeys(fold, states);
  if (stuck.length === 0) return "wait";
  const detail = `${stuck.length === 1 ? "task" : "tasks"} ${stuck.join(", ")} can never start (a task waited for was cancelled or removed) and no task runs: waves.add (which drops them) or waves.cancel`;
  const written = await appendWaveEvents(id, (now) => (now.stage === "building" && now.detail !== detail ? [{ kind: "stage", stage: "building", reason: null, detail }] : null));
  log(id, `${detail}${written === null ? "" : " (recorded)"}; resting`);
  return "rest";
}

/** The review queue's process-wide part (`review-each.ts`). */
export const reviewEachDeps: Omit<ReviewEachDeps, "log" | "env"> = {
  exec: (argv, options) => runner.run(argv, options),
  cancelled: () => stopping || runner.cancelled,
  delivered: new Map(),
};

/** Waits until a poke marker appears, `POLL_MS` passes or the runner stops. */
async function waitForPoke(id: string): Promise<void> {
  const deadline = Date.now() + POLL_MS;
  while (!stopping && Date.now() < deadline && !existsSync(wavePokePath(id))) await Bun.sleep(MARKER_POLL_MS);
}

/** Whether this process holds the wave's lock now: taken, or handed by the poke that started it (waited for). */
async function takeLock(id: string): Promise<boolean> {
  const deadline = Date.now() + HAND_WAIT_MS;
  for (;;) {
    if ((await readFile(waveLockPath(id), "utf8").catch(() => "")).split(" ")[0] === String(process.pid)) return true;
    try {
      await lockWave(id);
      return true;
    } catch (error) {
      if (!isBusy(error)) throw error;
    }
    if (Date.now() >= deadline) return false;
    await Bun.sleep(20);
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
    stopped.abort();
    runner.cancel();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    for (;;) {
      await drive(id);
      await unlockFile(waveLockPath(id));
      // A poke that found the lock still taken left its marker for this runner: look again if nobody else took over.
      if (stopping || !existsSync(wavePokePath(id))) return 0;
      try {
        await lockWave(id);
      } catch (error) {
        if (isBusy(error)) return 0;
        throw error;
      }
    }
  } finally {
    await unlockFile(waveLockPath(id)).catch(() => undefined);
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
