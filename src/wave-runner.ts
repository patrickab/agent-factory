/**
 * The detached process that drives one wave to rest: `bun wave-runner.ts <wave id>`. No Pi session, no `OpsDeps`: the
 * pure steps (`git.ts`, `rebaseWorktree`, `mergeTask`, `runReview`, the merge queue) with the runner's own `Exec`.
 *
 * - Holds the wave's lock (`waveLockPath`) for its life: one runner per wave. A poke (`pokeWave`) hands it the lock
 *   (`WAVE_LOCK_ENV`); started by hand it takes the lock itself, and ends at once when a live runner holds it
 * - Loop: clear the poke marker, read the log, act on the stage, again. `building`: start the tasks whose predecessors
 *   are done (`startWaveTasks`), then `reviewing` once every task is done or cancelled (`cancelled` when all are);
 *   else wait for a poke or `POLL_MS`. A launch that fails blocks the wave (`infra`, the error as the stage's detail);
 *   tasks that can never start while nothing else runs (`stuckKeys`) make the runner rest, the wave `building` with a
 *   `stage` event naming them (once): invariant 8, the wave never waits silently. `reviewing`: the review worktree on
 *   the wave's branch (`after_create` hooks of the target's tip run when it is made), the rebase onto the target
 *   unsquashed, the merge gates (the full suite, once per wave), the reviewer on the whole diff since the target; then `merging` (`waiting_approve` with the wave's `merge: review`), `rejected` or `blocked`.
 *   `merging`: the merge queue, merge gates (only when the target moved since the review's run) and the fast-forward
 *   (`mergeTask` `asIs`), then `merged` or `blocked`
 * - With the wave's `remote` on (`remote.ts`, every step a `remote` event, a failure never blocks): after the rebase
 *   the wave's branch is pushed and the request opened (once), each recorded verdict is commented, and after the
 *   fast-forward the branch and the target are pushed. Off: no call
 * - Every step appends its event (`gate`, `review`, `merge`, `stage`). A stage change is a compare-and-append on the
 *   stage it left: a `waves.add` that moved the wave back to `building` meanwhile wins, and the loop goes on from there.
 *   While it reviews, the runner watches the log: once the stage left `reviewing` it kills the gates and the reviewer
 * - A block's `stage` event says why in `detail` (the conflicting paths, the error, the dirty worktree and its paths)
 * - Resumable from the log: a runner started on a wave in `reviewing` or `merging` runs that step again from its start
 * - Invariant 2: the review worktree must hold nothing but HEAD's tree before the rebase, after it, and after the gates
 *   (their untracked output is removed); else `blocked`, `dirty`. Rules, gates and the reviewer prompt are read from
 *   the target's tip
 * - The review worktree is removed (`git worktree remove`, never forced: a dirty one stays, nothing is deleted) when the
 *   wave leaves `reviewing`/`merging` for anything but `merging`
 * - Ends when the wave rests: lets the lock go, then looks for a poke marker once more and runs on when there is one
 *   and it gets the lock back. SIGTERM/SIGINT (`stopping`): cancels the running commands and any launch of a task
 *   (`startWaveTasks` gets the abort signal: no further task starts, the one launching is undone), records no stage
 *   change (a step its stop cut short says nothing about the wave: it stays where it was, `interrupted`, and a
 *   resume runs that step again) and leaves the review worktree for that resume
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { withoutPaths } from "./agent-view.ts";
import { loadTaskFiles, type FactoryConfig } from "./config.ts";
import { FactoryError, oneLine, pokeQueuedAfter, startQueuedWave, startWaveTasks, waveReviewWorktree, waveTaskViews } from "./core.ts";
import { abortLeftoverRebase, git, removeUntracked, taskBase, trackedChanges, treeDiff, uncommittedFiles } from "./git.ts";
import { runAfterCreate } from "./launch.ts";
import { mergeTask, rebaseWorktree } from "./merge.ts";
import { INFRA_EXIT } from "./pipeline.ts";
import { commentReview, mergePending, publishMerge, publishWave } from "./remote.ts";
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
  gatedCommit,
  readWave,
  readyForReview,
  RESTING_WAVE_STAGES,
  stuckKeys,
  unlockWave,
  waveStarted,
  type NewWaveEvent,
  type StartedWaveFold,
  type WaveDeclaration,
  type WaveFold,
  type WaveReason,
  type WaveStage,
} from "./waves.ts";
import { resolveModels } from "./settings.ts";
import { waveLanded } from "./sync.ts";

/**
 * How long a building wave waits for a poke before it looks at its tasks again. `FACTORY_WAVE_POLL_MS` (tests only)
 * sets it: a test proves a poke wakes the runner, not this poll.
 */
const POLL_MS = Number(process.env.FACTORY_WAVE_POLL_MS) || 10_000;
/** How often the wait looks for the poke marker. */
const MARKER_POLL_MS = 200;
/** How long a runner a poke started waits for the lock to be handed to it. */
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
function waveTask(declaration: StartedWaveFold): Task {
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
  return waveReviewWorktree(declaration);
}

/**
 * Appends `events` and the new stage, with `detail` (why, invariant 8) when given, if the wave is still at `from`.
 * False when it moved on meanwhile. A stopping runner records nothing (`done` for a step that ended all the same:
 * a merge that landed).
 */
async function moveStage(id: string, from: WaveStage, to: WaveStage, reason: WaveReason | null, detail: string | null = null, events: NewWaveEvent[] = [], done = false): Promise<boolean> {
  // A step the stop cut short (a killed gate, an aborted reviewer or launch) says nothing about the wave.
  if (stopping && !done) {
    log(id, `stopping: ${from} -> ${to} is not recorded, the wave stays ${from}`);
    return false;
  }
  const stage: NewWaveEvent = { kind: "stage", stage: to, reason, ...(detail === null ? {} : { detail }) };
  const written = await appendWaveEvents(id, (fold) => (fold.stage === from ? [...events, stage] : null));
  if (written === null) log(id, `left ${from} meanwhile: ${to} is not recorded`);
  else log(id, `${from} -> ${to}${reason ? ` (${reason})` : ""}${detail === null ? "" : `: ${detail}`}`);
  return written !== null;
}

/** How many paths a `dirty` detail names. */
const DIRTY_PATHS_SHOWN = 20;

/**
 * `detail` as the stage event stores it: no path (invariant 10). The review worktree is named by its wave, a path in
 * the repository is made relative, any other absolute path is `<path>`; the text with its paths goes to the log.
 */
export function pathFree(declaration: WaveDeclaration, detail: string): string {
  const relative = detail
    .split(reviewWorktree(declaration))
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
        (file) => foldWave(file.declaration, file.events).stage,
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
 * progress is aborted.
 */
async function ensureWorktree(declaration: StartedWaveFold): Promise<string> {
  const path = reviewWorktree(declaration);
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

/**
 * Removes the review worktree unless it holds anything uncommitted: then it stays, nothing is deleted. (A stopping
 * runner's steps leave it to the resume.)
 */
async function removeWorktree(declaration: WaveDeclaration): Promise<void> {
  const path = reviewWorktree(declaration);
  if (!existsSync(path)) return;
  const result = await runner.cleanup(["git", "worktree", "remove", path], { cwd: declaration.repo });
  if (result.exitCode !== 0) log(declaration.id, `the review worktree ${path} stays: ${outputTail(result.output)}`);
}

/** One `gate` event of a run of commands: passed when every one passed, the output tail of the last one run. */
function gateEvent(phase: "review" | "merge", results: { result: Pick<CommandResult, "output" | "durationMs">; passed: boolean }[], commit: string | null = null): NewWaveEvent {
  const last = results.at(-1);
  return {
    kind: "gate",
    phase,
    passed: results.every((run) => run.passed),
    wallMs: results.reduce((sum, run) => sum + run.result.durationMs, 0),
    log: last === undefined ? null : outputTail(last.result.output),
    ...(commit === null ? {} : { commit }),
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

/**
 * `reviewing`: rebase, `merge_gates` (the full suite, once per wave: its tasks ran only what they reach; a failure
 * blocks, `gates`, before any reviewer starts), reviewer, then the stage the verdict asks for. The gate event names
 * the commit they passed on: the merge runs them again only on another one.
 */
/** Resolves when the step ended (with whether its last stage change was recorded, where it says). */
async function review(fold: StartedWaveFold): Promise<boolean | void> {
  const { id } = fold;
  const task = waveTask(fold);
  const leave = async (to: WaveStage, reason: WaveReason | null, detail: string | null = null, events: NewWaveEvent[] = []): Promise<boolean> => {
    const moved = await moveStage(id, "reviewing", to, reason, detail === null ? null : pathFree(fold, detail), events);
    if (!stopping && (!moved || to !== "merging")) await removeWorktree(fold);
    return moved;
  };
  let remote = fold.remote;
  let root: string;
  try {
    root = await ensureWorktree(fold);
  } catch (error) {
    return void (await moveStage(id, "reviewing", "blocked", "infra", pathFree(fold, `the review worktree: ${oneLine(errorText(error))}`)));
  }
  try {
    const { config, prompts } = await targetConfig(fold, root);
    // The gates and the reviewer see the committed tree only: anything else in the worktree is somebody's work.
    if (await uncommittedFiles(runner.run, root)) return leave("blocked", "dirty", await dirtyDetail(root));
    const conflicts = await rebaseWorktree(runner.run, runner.cleanup, root, task, config.protected, task.title, true);
    if (conflicts) return leave("blocked", "conflict", `the rebase onto ${fold.target} conflicts on ${conflicts.join(", ")}`);
    // The rebase brings the target's .gitignore: a file it stopped ignoring is no gate output.
    if (await uncommittedFiles(runner.run, root)) return leave("blocked", "dirty", await dirtyDetail(root));
    // The rebased branch on the forge, its request opened (once): recorded, never blocking.
    if (!stopping) remote = await publishWave(fold);
    const gated = await git(runner.run, root, ["rev-parse", "HEAD"]);
    const gates: { argv: string[]; result: CommandResult; passed: boolean }[] = [];
    try {
      for (const argv of config.merge_gates) {
        log(id, `gate ${argv.join(" ")}`);
        const result = await runner.run(argv, { cwd: root });
        gates.push({ argv, result, passed: passed(result) });
        if (!passed(result)) break;
      }
    } finally {
      // The worktree was clean before the gates: what lies untracked now is their output.
      await removeUntracked(runner.cleanup, root);
    }
    const gate = gates.length === 0 ? [] : [gateEvent("review", gates, gated)];
    const failed = gates.find((run) => !run.passed);
    if (failed) return leave("blocked", gateReason(failed.result), gateDetail(failed.argv, failed.result), gate);
    // A gate that rewrote a tracked file passed on a tree the target would never get.
    if (await trackedChanges(runner.run, root)) return leave("blocked", "dirty", await dirtyDetail(root), gate);
    if (gate.length > 0 && (await appendWaveEvents(id, (now) => (now.stage === "reviewing" ? gate : null))) === null) return removeWorktree(fold);

    const base = await taskBase(runner.run, root, task);
    const diff = await treeDiff(runner.run, root, base, await git(runner.run, root, ["rev-parse", "HEAD^{tree}"]), config.lockfiles);
    // Nothing differs from the target: nothing to review or merge.
    if (diff.paths.length === 0) return leave("merged", null);
    const round = fold.reviews.length + 1;
    log(id, `review round ${round}`);
    // What each done task was asked and its coder's last message (the risks it named): the reviewer may have no shell.
    const { states, views } = await waveTaskViews(fold);
    const waveTasks = fold.tasks
      .filter((spec) => states.get(spec.key) === "done")
      .map((spec) => ({ title: spec.title, request: spec.request, lastMessage: views.get(spec.key)?.lastMessage ?? null }));
    const data = await runReview({
      exec: runner.run,
      root,
      round,
      task,
      followUps: [],
      diff,
      // The wave's reviewer model: its own when it names one, else Pi's session model.
      model: resolveModels([fold.overrides.models]).reviewer ?? null,
      rolePrompt: prompts.reviewer,
      reviewsDir: waveReviewsDir(id),
      cancelled: () => runner.cancelled,
      wave: true,
      waveTasks,
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
      usage: { input: data.usage.input, output: data.usage.output, cacheRead: data.usage.cacheRead, cacheWrite: data.usage.cacheWrite, cost: data.usage.cost },
      wallMs: data.wallMs,
    };
    let moved: boolean;
    if (verdict === "failed") moved = await leave("blocked", "review_failed", `the reviewer gave no verdict (${data.status})`, [event]);
    else if (verdict === "rejected") moved = await leave("rejected", null, null, [event]);
    else moved = await leave(fold.overrides.merge === "review" ? "waiting_approve" : "merging", null, null, [event]);
    // Only a recorded verdict reaches the forge.
    if (moved) await commentReview({ ...fold, remote }, { round, verdict, status: data.status, findings: event.findings });
  } catch (error) {
    return leave("blocked", "infra", `review: ${oneLine(errorText(error))}`);
  }
}

/**
 * `merging`: the merge queue, merge gates and the fast-forward of the target. The merge gates are skipped on the
 * commit they passed on before the review (`gated`): they run again only when the target moved since.
 */
async function merge(fold: StartedWaveFold, gated: string | null): Promise<void> {
  const { id } = fold;
  const task = waveTask(fold);
  const leave = async (to: WaveStage, reason: WaveReason | null, detail: string | null = null, events: NewWaveEvent[] = []) => {
    // The target moved: that is recorded even when the runner stops, the merge is not run twice.
    const landed = to === "merged";
    await moveStage(id, "merging", to, reason, detail === null ? null : pathFree(fold, detail), events, landed);
    if (!stopping || landed) await removeWorktree(fold);
  };
  let root: string;
  let config: FactoryConfig;
  try {
    root = await ensureWorktree(fold);
    config = (await targetConfig(fold, root)).config;
  } catch (error) {
    return leave("blocked", "infra", `the merge worktree: ${oneLine(errorText(error))}`);
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
    gated,
  });
  const gates = outcome.gates.filter((gate: GateData) => gate.phase === "merge_gates");
  const gate = gates.length === 0 ? [] : [gateEvent("merge", gates.map((data) => ({ result: { output: data.outputTail, durationMs: data.durationMs }, passed: data.exitCode === 0 && !data.killed })))];
  const { result } = outcome;
  switch (result.kind) {
    case "merged":
      // The push still to come is in the log before the resting stage: a runner that dies in between leaves it said.
      await leave("merged", null, null, [...gate, { kind: "merge", from: before ?? result.merge.commit ?? "", to: result.merge.commit ?? "", queueMs }, ...mergePending(fold)]);
      // Files in step (`sync.ts`): the other building waves on the target are rebased onto it, their running tasks marked.
      {
        const from = before as string | null;
        const to = result.merge.commit;
        if (from !== null && to !== null) {
          const synced = await waveLanded(runner.cleanup, fold.repo, id, fold.target, from, to).catch((error: unknown) => [`files in step: ${errorText(error)}`]);
          for (const line of synced) log(id, line);
        }
      }
      // The target moved: the forge gets it, the request shows merged (recorded, never blocking).
      return void (await publishMerge(fold));
    case "conflict":
      return leave("blocked", "conflict", `the rebase onto ${fold.target} conflicts on ${result.files.join(", ")}`, gate);
    case "gate_failed":
      return leave("blocked", gateReason(result.gate.result), gateDetail(result.gate.argv, result.gate.result), gate);
    case "dirty":
      return leave("blocked", "dirty", await dirtyDetail(root), gate);
    case "failed":
      return leave("blocked", "infra", `the merge failed: ${oneLine(result.merge.error ?? "unknown")}`, gate);
  }
}

/** The environment of what the runner starts: without the lock a poke handed to it. */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[WAVE_LOCK_ENV];
  return env;
}

/**
 * One look at the wave and the step its stage asks for. `queued`: starts when every wave it waits for is merged
 * (`startQueuedWave`), else rests until one of them pokes it. `merged`: pokes the queued waves that wait for it.
 */
async function step(id: string): Promise<Next> {
  const { declaration, events } = await readWave(id);
  const fold = foldWave(declaration, events);
  if (fold.stage === "queued") return (await startQueuedWave(id)) ? "again" : "rest";
  if (fold.stage === "merged") {
    for (const failure of await pokeQueuedAfter(id, childEnv())) log(id, `poking a queued wave failed: ${failure}`);
  }
  if (RESTING_WAVE_STAGES.includes(fold.stage)) return "rest";
  if (!waveStarted(fold)) throw new Error(`the wave is ${fold.stage} but has no branch (no start event)`);
  if (fold.stage === "reviewing") {
    await whileAt(id, "reviewing", () => review(fold));
    return "again";
  }
  if (fold.stage === "merging") {
    await merge(fold, gatedCommit(events));
    return "again";
  }
  return build(fold);
}

/**
 * `building`: the next stage once every task finished, else start what can start. A launch that fails blocks the
 * wave; tasks that can never start while nothing else runs make the runner rest (the stage's detail names them, once).
 */
async function build(fold: WaveFold): Promise<Next> {
  const { id } = fold;
  const { states } = await waveTaskViews(fold);
  if (allCancelled(fold, states)) return (await moveStage(id, "building", "cancelled", null)) ? "rest" : "again";
  if (readyForReview(fold, states)) {
    await moveStage(id, "building", "reviewing", null);
    return "again";
  }
  const env = childEnv();
  try {
    const started = await startWaveTasks(id, env, stopped.signal);
    if (started.length > 0) {
      log(id, `started ${started.join(", ")}`);
      return "again";
    }
  } catch (error) {
    // A launch that failed: as `tasks.start` would tell its caller, the wave tells the supervisor.
    if (!(error instanceof FactoryError) || (error.code !== "refused" && error.code !== "failed")) throw error;
    return (await moveStage(id, "building", "blocked", "infra", `${error.message}; waves.retry starts it again`)) ? "rest" : "again";
  }
  // A stopping runner started what it could not stop; it judges nothing more.
  if (stopping) return "wait";
  const stuck = stuckKeys(fold, states);
  if (stuck.length === 0) return "wait";
  const detail = `${stuck.length === 1 ? "task" : "tasks"} ${stuck.join(", ")} can never start (a task waited for was cancelled or removed) and no task runs: waves.add (which drops them) or waves.cancel`;
  const written = await appendWaveEvents(id, (now) => (now.stage === "building" && now.detail !== detail ? [{ kind: "stage", stage: "building", reason: null, detail }] : null));
  log(id, `${detail}${written === null ? "" : " (recorded)"}; resting`);
  return "rest";
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
    stopped.abort();
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
