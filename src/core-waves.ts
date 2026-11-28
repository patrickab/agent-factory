/**
 * The core's wave actions (`waves.*`), the wave as clients see it, and what the wave's runner, the plugin and the
 * notifier ask of the core about waves.
 * - A stage change is a compare-and-append on the log (`waves.ts`), then a poke; `WaveView.actions` holds the same
 *   predicates
 * - `waves.start` declares a wave in full or not at all: a step that fails leaves no branch, no record, no task
 */
import { existsSync } from "node:fs";
import { realpath, rm } from "node:fs/promises";
import { waveContracts } from "./core-contracts.ts";
import { launchSpec } from "./core-plan.ts";
import { byId, nonEmpty, oneLine, primaryOf, tagParam, type Handler } from "./core-shared.ts";
import { defaultSmallModel, wantedModels } from "./core-settings.ts";
import { cancelTask, droppedWork, refusal, retryRestingTask, taskLook, taskView, withTaskLock, type TaskView } from "./core-tasks.ts";
import { git, mergeTrees, worktreeChanges } from "./git.ts";
import { deleteTask, launchTask, localBranchExists, type RunnerEnv, targetOf, worktreePath } from "./launch.ts";
import type { NoticeWave } from "./notify.ts";
import { runCommand } from "./run.ts";
import { requireModels } from "./models.ts";
import { checkSettings, loadSettings, registeredRepos, resolveSettings, type ModelSize, type StoredSettings } from "./settings.ts";
import { isFinal, minorFindings, type MinorFinding, type State } from "./state.ts";
import { listTasks, sessionTask, tagInGroup, tasksById, type TaskRecord } from "./tasks.ts";
import { addUsage, cents, errorText, FactoryError, isBusy, short, type Usage } from "./util.ts";
import {
  appendWaveEvent,
  appendWaveEvents,
  createWave,
  listWaves,
  readWave,
  removeWave,
  waveRests,
  waveAttention,
  waveFinal,
  waveClosed,
  startableKeys,
  stuckKeys,
  unreachableKeys,
  validateTaskSpecs,
  waveCounts,
  waveTaskState,
  type NewWaveEvent,
  type WaveEvent,
  type WaveConflict,
  type WaveDeclaration,
  type WaveFile,
  type TaskStates,
  type WaveFold,
  type WaveOverrides,
  type WaveStage,
  type WaveTaskEntry,
  type WaveView,
} from "./waves.ts";
import { liveWaveRunners, lockWave, pokeWave, stopWaveRunners, waveDir, waveLockPath } from "./wave-poke.ts";
import { lockHeld, unlockFile } from "./lock.ts";
import { cancelScouts, scoutUsage } from "./scouts.ts";
import { waveFeedback } from "./feedback.ts";
import { slotWaiting } from "./test-slots.ts";

export type WaveActionName = "waves.add" | "waves.retry" | "waves.approve" | "waves.cancel" | "waves.remove";

/** `waves.remove` removes a done task with its wave: it refuses only a running task or one waiting for its answer. */
function requireRemovable(view: TaskView): void {
  const refused = refusal(view, "tasks.remove", null);
  if (refused !== null) throw refused;
}

/** The wave branch of `tag` on `target`: `<target>-<tag with "/" as "-">`. */
export function waveBranchName(target: string, tag: string): string {
  return `${target}-${tag.replaceAll("/", "-")}`;
}

/** The wave's review worktree (`wave-runner.ts`): one per wave, next to the tasks' worktrees. */
export function waveReviewWorktree(declaration: Pick<WaveDeclaration, "id" | "repo">): string {
  return worktreePath(declaration.repo, `wave-${short(declaration.id)}-review`);
}

/** The wave of the task in the Pi session `sessionId`, null outside one. */
/**
 * The wave of the task in the Pi session `sessionId` (null: none) and why the task's merge must not land now
 * (`mergeRefusal`, null when it may; invariant 2): a task of a wave whose review began (`reviewBegan`) would bring commits onto the wave's branch that
 * its gates and reviewer never saw, or that are lost once it merged. The plugin asks right before a task merges, so
 * no path (an action, a `/factory` command typed into the session, a resume) gets past it. A task outside a wave
 * merges as before.
 */
export async function sessionWave(sessionId: string): Promise<{ id: string; mergeRefusal: string | null } | null> {
  const record = await sessionTask(sessionId);
  if (record === undefined || record.wave === null) return null;
  const id = record.wave;
  let file: WaveFile;
  try {
    file = await readWave(id);
  } catch (error) {
    if (error instanceof FactoryError && error.code === "not_found") return { id, mergeRefusal: `its wave ${short(id)} is removed: nothing more reaches its branch` };
    throw error;
  }
  const { stage, branch, reviewBegan } = file.fold;
  if (!reviewBegan) return { id, mergeRefusal: null };
  return { id, mergeRefusal: `its wave ${short(id)} is ${stage}, its review began: nothing more reaches its branch ${branch} (the reviewed tree is what merges); give the work to the wave with waves.add` };
}

/** The wave whose id is `id` or starts with it. */
export async function findWave(id: unknown): Promise<WaveFile> {
  return byId(await listWaves(), (wave) => wave.declaration.id, id, "wave");
}

/** Pokes the wave's runner (`wave-poke.ts`); a runner that cannot start is `failed`. */
async function pokeWaveRunner(id: string, env?: RunnerEnv): Promise<void> {
  try {
    await pokeWave(id, env);
  } catch (error) {
    throw new FactoryError("failed", `wave ${short(id)}: its runner did not start (${oneLine(errorText(error))}); a later poke tries again`);
  }
}

/**
 * The views of the wave's started tasks by key, and their unrounded usage. A started task whose record is gone
 * (removed) counts as `cancelled`: it never finishes.
 */
export async function waveTaskViews(
  fold: WaveFold,
  read: ListingReads = {},
): Promise<{ states: TaskStates; views: Map<string, TaskView>; usages: Map<string, Usage | null> }> {
  const records = read.records ?? await tasksById();
  const states = new Map<string, State | null>();
  const views = new Map<string, TaskView>();
  const usages = new Map<string, Usage | null>();
  await Promise.all(
    fold.tasks.map(async (task) => {
      if (task.taskId === null) return;
      const record = records.get(task.taskId);
      if (record === undefined) {
        states.set(task.key, "cancelled");
        return;
      }
      const { view, usage } = await taskLook(record, fold.stage);
      views.set(task.key, view);
      usages.set(task.key, usage);
      states.set(task.key, view.state);
    }),
  );
  return { states, views, usages };
}

/** What a listing reads once for all its waves: every task record by id. */
type ListingReads = { records?: ReadonlyMap<string, TaskRecord> };

/** A wave's view and the log it was folded from (a notice keys on it). */
export type WaveLook = { view: WaveView; events: WaveEvent[] };

/**
 * The waves among `files` that wait for the wave `id` and have not started (queued, or blocked at their start), not
 * cancelled ones: a merge pokes them, a cancel makes them never start, and the wave is not removed under them.
 */
function queuedAfter(id: string, files: readonly WaveFile[]): WaveFold[] {
  return files.map((file) => file.fold).filter((fold) => !fold.started && fold.stage !== "cancelled" && fold.after.includes(id));
}

/**
 * A queued wave that can start and that nothing starts: every wave it names is merged, and neither its runner nor one
 * of theirs lives (a merged wave's runner died before it poked). It counts as interrupted; `waves.retry` pokes it.
 */
async function queueStalled(fold: WaveFold, look: { waiting: string[]; never: string | null }, running: boolean): Promise<boolean> {
  if (fold.stage !== "queued" || running || look.never !== null || look.waiting.length > 0) return false;
  for (const id of fold.after) if ((await liveWaveRunners(id)).length > 0) return false;
  return true;
}

/**
 * What a queued wave waits for: the ids of the waves it names that are not `merged` yet (`waiting`), and why it can
 * never start when one of them was cancelled or removed (`never`, the text of its `stage` event), else null. `all`:
 * the waves read already (else each is read).
 */
async function queueLook(fold: WaveFold, all?: readonly WaveFile[]): Promise<{ waiting: string[]; never: string | null }> {
  const waiting: string[] = [];
  for (const id of fold.after) {
    const shown = short(id);
    let file = all?.find((candidate) => candidate.declaration.id === id);
    if (file === undefined) {
      try {
        file = await readWave(id);
      } catch (error) {
        if (error instanceof FactoryError && error.code === "not_found") return { waiting, never: `it waits for wave ${shown}, which was removed: it can never start; waves.cancel or waves.remove it` };
        throw error;
      }
    }
    const named = file.fold;
    if (named.stage === "cancelled") return { waiting, never: `it waits for wave ${named.tag} (${shown}), which was cancelled: it can never start; waves.cancel or waves.remove it` };
    if (named.stage !== "merged") waiting.push(id);
  }
  return { waiting, never: null };
}

/** Records why the queued wave can never start (one `stage` event, still `queued`, once). True when it never can. */
async function recordNeverStart(fold: WaveFold): Promise<boolean> {
  const { never } = await queueLook(fold);
  if (never === null) return false;
  await appendWaveEvents(fold.id, (now) => (now.stage === "queued" && now.detail !== never ? [{ kind: "stage", stage: "queued", reason: null, detail: never }] : null));
  return true;
}

/**
 * The wave's runner on a queued wave: when every wave it names is `merged` it starts (its branch moved to the target's
 * tip, then a `start` event with that tip as `base`), else it rests, recording why when it never can. Its branch
 * holding commits the target lacks, or the move failing: `blocked`. Resolves with whether the wave moved on (look again).
 */
export async function startQueuedWave(id: string): Promise<boolean> {
  const { fold } = await readWave(id);
  if (fold.stage !== "queued") return true;
  if (await recordNeverStart(fold)) return false;
  if ((await queueLook(fold)).waiting.length > 0) return false;
  const block = async (detail: string) =>
    (await appendWaveEvents(id, (now) => (now.stage === "queued" ? [{ kind: "stage", stage: "blocked", reason: "infra", detail }] : null))) !== null;
  const { repo, branch, target } = fold;
  let base: string;
  try {
    base = await git(runCommand, repo, ["rev-parse", "--verify", `refs/heads/${target}^{commit}`]);
    // Still empty (its tip is on the target): it moves to the target's tip, with the code of the waves it waited for.
    if ((await runCommand(["git", "merge-base", "--is-ancestor", branch, base], { cwd: repo })).exitCode !== 0) throw new Error(`it holds commits ${target} lacks`);
    await git(runCommand, repo, ["branch", "--force", branch, base]);
  } catch (error) {
    return block(`its branch ${branch} cannot start on ${target}: ${oneLine(errorText(error))}; waves.retry`);
  }
  await appendWaveEvents(id, (now) => (now.stage === "queued" ? [{ kind: "start", base }] : null));
  return true;
}

/**
 * Pokes every queued wave that waits for the merged wave `id`: the one whose last named wave this was starts. A poke
 * that fails is left to the next one (`waves.retry`); the error is returned for the runner's log.
 */
export async function pokeQueuedAfter(id: string, env?: RunnerEnv): Promise<string[]> {
  const failures: string[] = [];
  for (const fold of queuedAfter(id, await listWaves())) {
    await pokeWave(fold.id, env).catch((error: unknown) => failures.push(`wave ${short(fold.id)}: ${oneLine(errorText(error))}`));
  }
  return failures;
}

/**
 * The wave `id` as clients see it: its fold, its tasks' states and usage, whether its runner lives. `all`: every wave,
 * read already (else they are read); `read`: a listing's shared reads.
 */
export async function lookWave(id: string, all?: readonly WaveFile[], read: ListingReads = {}): Promise<WaveLook> {
  // Liveness before the log: a runner writes its last stage before it exits, so the log read after a dead runner is its
  // last one. A copy read before, by a runner that wrote `merged` and exited since, would look interrupted.
  const runners = await liveWaveRunners(id);
  // A poke's lock before its runner has it counts too: the wave is starting, not interrupted.
  const held = runners.length > 0 || (await lockHeld(waveLockPath(id)));
  const file = await readWave(id);
  const full = file.fold;
  const { overrides: _overrides, base: _base, contracts: _contracts, conflicts: _conflicts, taskReviews: _taskReviews, fixes: _fixes, reviewBegan: _began, gatedCommit: _gated, started: _started, ...fold } = full;
  const { states, views, usages } = await waveTaskViews(full, read);
  const running = runners.length > 0;
  const waitingForSlot = await slotWaiting(runners);
  const waves = all ?? (await listWaves());
  const queue = fold.stage === "queued" ? await queueLook(full, waves) : null;
  const stuck = (fold.stage === "building" && stuckKeys(full, states).length > 0) || (queue !== null && queue.never !== null);
  const interrupted = (!waveRests(fold.stage) && !held && !stuck) || (queue !== null && (await queueStalled(full, queue, running)));
  let usage: Usage | null = null;
  const tasks = fold.tasks.map((task) => {
    usage = addUsage(usage, usages.get(task.key) ?? null);
    const state = waveTaskState(task, states);
    return { key: task.key, title: task.title, after: task.after, model: task.model, taskId: task.taskId, sessionId: task.sessionId, state, usage: views.get(task.key)?.usage ?? null, id: task.taskId ?? task.id };
  });
  for (const review of fold.reviews) usage = addUsage(usage, review.usage);
  const minors: MinorFinding[] = [
    ...fold.tasks.flatMap((task) => (views.get(task.key)?.minors ?? []).map((minor) => ({ ...minor, task: task.key }))),
    ...fold.reviews.flatMap((review) => minorFindings(review.round, review.findings)),
  ];
  // The wave's own scouts (its reviewer's), then its tasks' (in their usage already).
  usage = addUsage(usage, await scoutUsage({ kind: "wave", id: fold.id }));
  // The predicates of the wave actions' own checks, as one list for clients.
  const allowed: Record<WaveActionName, boolean> = {
    "waves.add": !waveClosed(fold.stage),
    "waves.retry": fold.stage === "blocked" || interrupted,
    "waves.approve": fold.stage === "waiting_approve",
    "waves.cancel": !waveFinal(fold.stage),
    // `tasks.remove` of a task maybe only with force, as for the task itself; its done tasks go with the wave. Not
    // while a wave that has not started waits for it.
    "waves.remove": !running && [...views.values()].every((view) => refusal(view, "tasks.remove", null) === null) && queuedAfter(fold.id, waves).length === 0,
  };
  const actions = (Object.keys(allowed) as WaveActionName[]).filter((name) => allowed[name]);
  const reviews = fold.reviews.map((review) => ({ ...review, usage: { ...review.usage, cost: cents(review.usage.cost) } }));
  const total = usage === null ? null : { ...usage, cost: cents(usage.cost) };
  const attention = interrupted || stuck || waveAttention(fold.stage);
  return { view: { ...fold, reviews, minors, running, interrupted, stuck, attention, tasks, counts: waveCounts(full, states), usage: total, actions, ...(waitingForSlot ? { waitingForSlot } : {}) }, events: file.events };
}

/**
 * What notifications (`notify.ts`) judge for the Pi session `origin`: the views of the tasks it started and of the
 * waves it declared, a wave with whether it builds stuck and its log. Only those records are read; the ids in `skip`
 * not even those (the notifier's finished, delivered ones).
 */
export async function noticeInputs(
  origin: string,
  skip: { tasks?: ReadonlySet<string>; waves?: ReadonlySet<string> } = {},
): Promise<{ tasks: TaskView[]; waves: NoticeWave[] }> {
  const records = (await listTasks()).filter((record) => record.origin === origin && !skip.tasks?.has(record.id));
  const all = await listWaves();
  const files = all.filter((file) => file.declaration.origin === origin && !skip.waves?.has(file.declaration.id));
  const tasks = await Promise.all(records.map((record) => taskView(record)));
  const waves = await Promise.all(files.map((file) => lookWave(file.declaration.id, all)));
  return { tasks, waves };
}

/**
 * The scheduler: starts every pending task of the wave whose `after` tasks are all `done`, through `launchTask` with
 * the wave's branch as target, its tag, plan and id, and records a `task` event for each. Only the wave's runner calls
 * it, holding the runner's lock: no task starts twice. A record of this wave no `task` event names (a runner died
 * between the launch and its event) is adopted for the first pending task of its title instead of a second launch.
 * Nothing starts unless the wave is `building`. Resolves with the started keys; a launch that fails throws (`refused` or `failed`) after the tasks started before it are recorded.
 * `signal` (the runner stops): no further launch, the running one is undone (`launchTask`), and it resolves with the
 * keys started before. A conflict task (`conflictTask`) starts on the wave's branch moved to the target's tip it
 * recorded, its worktree holding the wave's change merged onto that tip with the markers left.
 */
export async function startWaveTasks(id: string, env?: RunnerEnv, signal?: AbortSignal): Promise<string[]> {
  const { declaration, fold } = await readWave(id);
  if (fold.stage !== "building") return [];
  const { states } = await waveTaskViews(fold);
  const { maxRounds, review } = declaration.overrides;
  // The wave's models only (`launchTask` reads no stored models for a wave's task); a name the wave sets none for runs
  // with Pi's session model, except `small`, which a task asking for it takes from `defaults.yaml` when listed.
  const models = { ...declaration.overrides.models };
  if (models.small === undefined && fold.tasks.some((task) => task.model === "small")) {
    const small = await defaultSmallModel();
    if (small !== undefined) models.small = small;
  }
  // A wave's task always merges into the wave branch by itself; `merge` of the overrides is the wave's.
  const overrides: StoredSettings = { models, maxRounds, review, merge: "auto", branch: fold.branch };
  const named = new Set(fold.tasks.map((task) => task.taskId));
  const orphans = (await listTasks()).filter((record) => record.wave === id && !named.has(record.id));
  const started: string[] = [];
  for (const key of startableKeys(fold, states)) {
    if (signal?.aborted) break;
    const found = fold.tasks.find((candidate) => candidate.key === key);
    if (found === undefined) continue;
    const orphan = orphans.findIndex((record) => record.id === found.id);
    let record: TaskRecord;
    if (orphan >= 0) {
      // A runner that died after the launch: its record is adopted, no second launch.
      [record] = orphans.splice(orphan, 1);
    } else {
      // Launched with its spec as the log holds it now (`tasks.update` may have changed it since the fold above).
      const spec = await launchSpec(id, key, found.after);
      if (spec === null) continue;
      if (spec.model === "small" && models.small === undefined) {
        const small = await defaultSmallModel();
        if (small !== undefined) models.small = small;
      }
      try {
        // A conflict task: the wave's branch on the target's tip, its worktree the wave's change merged onto it.
        const conflict = fold.conflicts.find((candidate) => candidate.key === key);
        if (conflict !== undefined) await conflictBranch(fold, conflict);
        const prepare = conflict === undefined ? {} : { beforeRecord: (_branch: string, worktree: string) => leaveMarkers(worktree, conflict) };
        // The task's size picks its coder's model of the wave's (`taskModels`); the reviewer's stays the wave's.
        record = await launchTask({ repo: declaration.repo, title: spec.title, request: spec.request, overrides, size: spec.model, id: spec.id, tag: declaration.tag, plan: declaration.plan, wave: id, origin: declaration.origin, env, signal, ...prepare, ...(declaration.contracts === undefined ? {} : { contracts: declaration.contracts }) });
      } catch (error) {
        if (signal?.aborted) break;
        const why = `starting its task ${key} failed: ${oneLine(errorText(error))}`;
        throw new FactoryError(error instanceof FactoryError && error.code === "refused" ? "refused" : "failed", why);
      }
    }
    await appendWaveEvent(id, { kind: "task", key, taskId: record.id, sessionId: record.sessionId });
    started.push(key);
  }
  return started;
}

/** How many conflict tasks (`conflict-<n>`) a wave gets; the next conflict blocks it. */
export const CONFLICT_TASKS = 2;
/** How many commit subjects of each side a conflict task's request names. */
const SUBJECTS_SHOWN = 20;

/**
 * The events that send a wave whose rebase onto its target conflicted back to building: a
 * `conflict` event (the branch's tip `head`, the target's tip `onto`, the conflicting files of their merge, else
 * `rebaseFiles`) and the task `conflict-<n>` that resolves it, its request naming the files and the subjects of both
 * sides' commits. Null once the wave had `CONFLICT_TASKS`: the conflict blocks it.
 */
export async function conflictTask(fold: WaveFold, phase: "review" | "merge", rebaseFiles: readonly string[]): Promise<{ key: string; events: NewWaveEvent[] } | null> {
  const count = fold.conflicts.length;
  if (count >= CONFLICT_TASKS) return null;
  const { repo, branch, target } = fold;
  const head = await git(runCommand, repo, ["rev-parse", `refs/heads/${branch}`]);
  const onto = await git(runCommand, repo, ["rev-parse", `refs/heads/${target}`]);
  const base = await git(runCommand, repo, ["merge-base", head, onto]);
  const merged = await mergeTrees(runCommand, repo, base, onto, head);
  const files = merged.conflicts.length > 0 ? merged.conflicts : [...rebaseFiles];
  const subjects = async (tip: string) => {
    const lines = (await git(runCommand, repo, ["log", "--no-merges", "--format=%s", `${base}..${tip}`, "--", ...files])).split("\n").filter(Boolean);
    const shown = lines.slice(0, SUBJECTS_SHOWN).map((subject) => `- ${subject}`);
    if (lines.length > SUBJECTS_SHOWN) shown.push(`- and ${lines.length - SUBJECTS_SHOWN} more`);
    return shown.length === 0 ? "- (none on these files)" : shown.join("\n");
  };
  let n = count + 1;
  while (fold.tasks.some((task) => task.key === `conflict-${n}`)) n++;
  const key = `conflict-${n}`;
  // A file one side deleted holds no markers: the merge keeps the other side's version.
  const has = async (rev: string, file: string) => (await runCommand(["git", "cat-file", "-e", `${rev}:${file}`], { cwd: repo })).exitCode === 0;
  const marked: string[] = [];
  const deleted: string[] = [];
  for (const file of files) {
    const [inOnto, inHead] = [await has(onto, file), await has(head, file)];
    if (inOnto && inHead) marked.push(`- ${file}`);
    else if (inHead) deleted.push(`- ${file}: ${target} deleted it, the wave changed it; your worktree holds the wave's version`);
    else if (inOnto) deleted.push(`- ${file}: the wave deleted it, ${target} changed it; your worktree holds ${target}'s version`);
    else marked.push(`- ${file}`);
  }
  const request = [
    `The wave's branch ${branch} conflicts with ${target}. Your worktree is on ${target}'s tip ${onto.slice(0, 12)} with the wave's whole change (${head.slice(0, 12)}) on it, uncommitted.`,
    ...(marked.length === 0 ? [] : [`These files hold both versions between conflict markers (<<<<<<< ${onto.slice(0, 12)}… is ${target}, >>>>>>> ${head.slice(0, 12)}… is the wave):\n${marked.join("\n")}`]),
    ...(deleted.length === 0 ? [] : [`One side deleted these files, the other changed them (no markers): keep, delete or move what the change meant:\n${deleted.join("\n")}`]),
    `Commits of ${target} on them since the wave branched off:\n${await subjects(onto)}`,
    `Commits of the wave on them:\n${await subjects(head)}`,
    "Resolve every conflict keeping what both sides meant, remove the markers, leave the rest of the wave's change as it is.",
  ].join("\n\n");
  const spec: WaveTaskEntry = { key, title: `fix: resolve the conflict of ${fold.tag} with ${target}`, request, after: [], id: crypto.randomUUID() };
  return { key, events: [{ kind: "conflict", phase, key, head, onto, files }, { kind: "tasks", tasks: [spec] }] };
}

/**
 * Puts the wave's branch on the target's tip the conflict recorded (from the tip it recorded; there already: nothing),
 * so its conflict task's commit lands on it. Any other tip, or the branch checked out somewhere: `failed`.
 */
async function conflictBranch(fold: WaveFold, conflict: WaveConflict): Promise<void> {
  const tip = await git(runCommand, fold.repo, ["rev-parse", `refs/heads/${fold.branch}`]);
  if (tip === conflict.onto) return;
  if (tip !== conflict.head) throw new FactoryError("failed", `its branch ${fold.branch} moved since the conflict of ${conflict.key} (${tip.slice(0, 12)}, not ${conflict.head.slice(0, 12)}): waves.cancel, or merge it by hand and waves.retry`);
  const worktrees = await git(runCommand, fold.repo, ["worktree", "list", "--porcelain"]);
  if (worktrees.split("\n").includes(`branch refs/heads/${fold.branch}`)) throw new FactoryError("failed", `its branch ${fold.branch} is checked out in a worktree: remove that worktree, then waves.retry`);
  await git(runCommand, fold.repo, ["update-ref", "-m", `factory: ${fold.branch} onto ${fold.target} for ${conflict.key}`, `refs/heads/${fold.branch}`, conflict.onto, conflict.head]);
}

/**
 * The latest conflict's task was cancelled or removed while the wave's branch sits on the target's tip `conflictBranch`
 * moved it to: the branch goes back to the tip the conflict recorded (`update-ref` from that tip only), so no review
 * sees an empty diff and records `merged` without the wave's change. The detail of the block, or null when nothing
 * is to undo.
 */
export async function undoConflictBranch(fold: WaveFold, states: TaskStates): Promise<string | null> {
  const conflict = fold.conflicts.at(-1);
  if (conflict === undefined) return null;
  const task = fold.tasks.find((candidate) => candidate.key === conflict.key);
  if (task !== undefined && waveTaskState(task, states) !== "cancelled") return null;
  const tip = await git(runCommand, fold.repo, ["rev-parse", `refs/heads/${fold.branch}`]);
  if (tip !== conflict.onto) return null;
  const why = `its conflict task ${conflict.key} was cancelled`;
  const worktrees = await git(runCommand, fold.repo, ["worktree", "list", "--porcelain"]);
  if (worktrees.split("\n").includes(`branch refs/heads/${fold.branch}`)) {
    return `${why} and its branch ${fold.branch} is still on ${fold.target}'s ${conflict.onto.slice(0, 12)}, checked out in a worktree: remove that worktree, put it back on ${conflict.head.slice(0, 12)}, then waves.retry`;
  }
  await git(runCommand, fold.repo, ["update-ref", "-m", `factory: ${fold.branch} back from ${fold.target}, ${conflict.key} cancelled`, `refs/heads/${fold.branch}`, conflict.head, conflict.onto]);
  return `${why}: its branch ${fold.branch} is back on ${conflict.head.slice(0, 12)}; waves.retry rebases it again, or waves.cancel`;
}

/**
 * The conflict task's new worktree (on the target's tip `onto`): the wave's change (`head`) merged onto it with the
 * conflict markers left, uncommitted. On the files the merge changes it
 * wins over what the `after_create` hooks left there; their changes to other files stay, as in any task's worktree.
 */
async function leaveMarkers(worktree: string, conflict: WaveConflict): Promise<void> {
  const head = await git(runCommand, worktree, ["rev-parse", "HEAD"]);
  if (head !== conflict.onto) throw new Error(`the worktree of ${conflict.key} is on ${head.slice(0, 12)}, not on ${conflict.onto.slice(0, 12)}`);
  const base = await git(runCommand, worktree, ["merge-base", conflict.head, conflict.onto]);
  const merged = await mergeTrees(runCommand, worktree, base, conflict.onto, conflict.head);
  await git(runCommand, worktree, ["read-tree", "--reset", "-u", "HEAD", merged.tree]);
  await git(runCommand, worktree, ["reset", "-q"]);
}

export const WAVE_HANDLERS = {
  "waves.start": async (params, { cwd, env, origin }) => {
    const tag = tagParam("waves.start", params.tag);
    const title = nonEmpty(params.title);
    const request = nonEmpty(params.request);
    if (tag === undefined) throw new FactoryError("invalid", "waves.start needs a tag");
    if (title === undefined) throw new FactoryError("invalid", "waves.start needs a title that is not empty");
    if (request === undefined) throw new FactoryError("invalid", "waves.start needs a request (the reviewer's instructions) that is not empty");
    if (params.plan !== undefined && nonEmpty(params.plan) === undefined) throw new FactoryError("invalid", "waves.start: plan must not be empty");
    const specs = validateTaskSpecs(params.tasks);
    const contracts = await waveContracts(params.plan as string | undefined, params.contracts as string[] | undefined);
    const given = checkSettings(params.overrides, "wave", "waves.start: overrides.");
    const repo = await primaryOf(params.repo as string, cwd);
    if (!(await registeredRepos()).includes(repo)) throw new FactoryError("not_found", `${repo} is not registered, add it with repos.add first`);
    const stored = await loadSettings(repo);
    // Resolved once, here: the wave's tasks, review and merge read only the declaration.
    const { merge, maxRounds, review, models, squash } = resolveSettings([stored, given], "");
    // `squash` stored only when on: a wave that does not squash keeps the declaration it had, byte for byte.
    const overrides: WaveOverrides = { merge, maxRounds, review, models, ...(squash ? { squash } : {}) };
    await requireModels(wantedModels(models, specs));
    const target = await targetOf(repo, given.branch ?? stored.branch);
    const branch = waveBranchName(target, tag);
    if ((await runCommand(["git", "check-ref-format", "--branch", branch], { cwd: repo })).exitCode !== 0) {
      throw new FactoryError("invalid", `waves.start: ${branch} (target and tag) is no valid branch name`);
    }
    if (await localBranchExists(repo, branch)) throw new FactoryError("refused", `${repo}: the wave branch ${branch} exists already (another wave of tag ${tag} on ${target}?)`);
    const after = resolveAfter(params.after as string[] | undefined, await listWaves(repo), target, tag);
    const queued = after.length > 0;
    // A queued wave's branch moves to the target's tip when it starts (`startQueuedWave`).
    const base = await git(runCommand, repo, ["rev-parse", "--verify", `refs/heads/${target}^{commit}`]);
    await git(runCommand, repo, ["branch", branch, base]);
    const declaration: WaveDeclaration = {
      id: crypto.randomUUID(),
      repo,
      tag,
      plan: (params.plan as string | undefined) ?? null,
      title,
      request,
      branch,
      target,
      base,
      ...(queued ? { after } : {}),
      ...(contracts === undefined ? {} : { contracts }),
      origin: origin ?? null,
      createdAt: new Date().toISOString(),
      overrides,
    };
    // Declared in full or not at all: a step that fails leaves no branch, no record (and no task a runner started).
    try {
      await createWave(declaration);
      await appendWaveEvent(declaration.id, { kind: "tasks", tasks: specs });
      await pokeWaveRunner(declaration.id, env);
    } catch (error) {
      await undoWaveStart(declaration).catch(() => undefined);
      throw error;
    }
    return { wave: (await lookWave(declaration.id)).view };
  },

  "waves.add": async (params, { env }) => {
    const file = await findWave(params.id);
    const { id } = file.declaration;
    // Task states only move on: pending tasks that can never start now never will (a cancel is final).
    const current = file.fold;
    const { states } = await waveTaskViews(current);
    // The models list is read before the log lock; the specs are checked again under it. `waves.start` checked the big
    // model; the small one the wave names only when an added task is the first to ask for it.
    if (validateTaskSpecs(params.tasks, current.tasks).some((spec) => spec.model === "small")) {
      await requireModels({ small: file.declaration.overrides.models?.small });
    }
    // Checked and appended under the log lock: a runner's stage change after it loses, never the added tasks.
    await appendWaveEvents(id, (fold) => {
      if (waveClosed(fold.stage)) throw new FactoryError("refused", `wave ${short(id)} is ${fold.stage}, it takes no more tasks`);
      const tasks = validateTaskSpecs(params.tasks, fold.tasks);
      // The supervisor acts on a wave whose pending tasks can never start: they leave it (count as cancelled).
      const dropped = unreachableKeys(fold, states);
      const events: NewWaveEvent[] = [{ kind: "tasks", tasks, ...(dropped.length > 0 ? { dropped } : {}) }];
      // A wave that never started (queued, or blocked at its start) waits for its waves again.
      const builds: WaveStage = fold.started ? "building" : "queued";
      if (fold.stage !== builds) events.push({ kind: "stage", stage: builds, reason: null });
      return events;
    });
    await pokeWaveRunner(id, env);
    return { wave: (await lookWave(id)).view };
  },

  "waves.get": async (params) => {
    const file = await findWave(params.id);
    const { view } = await lookWave(file.declaration.id);
    return { wave: { ...view, feedback: await waveFeedback(file.declaration.plan, view.id) } };
  },

  "waves.list": async (params, { cwd }) => {
    const tag = tagParam("waves.list", params.tag);
    const repo = params.repo === undefined ? undefined : await primaryOf(params.repo as string, cwd);
    const origin = params.origin === undefined ? undefined : nonEmpty(params.origin)?.trim();
    if (params.origin !== undefined && origin === undefined) throw new FactoryError("invalid", "waves.list: origin must be a non-empty session id");
    const all = await listWaves();
    const files = all.filter(
      (file) =>
        (repo === undefined || file.declaration.repo === repo) &&
        (tag === undefined || tagInGroup(file.declaration.tag, tag)) &&
        (origin === undefined || file.declaration.origin === origin) &&
        (params.open !== true || !waveFinal(file.fold.stage)),
    );
    if (files.length === 0) return { waves: [] };
    // One read of the task records for every wave, not one per wave and task.
    const read: ListingReads = { records: await tasksById() };
    // A wave removed since the listing is left out.
    const looks = await Promise.all(files.map((file) => lookWave(file.declaration.id, all, read).catch((error: unknown) => (error instanceof FactoryError && error.code === "not_found" ? null : Promise.reject(error)))));
    return { waves: looks.flatMap((look) => (look === null ? [] : [look.view])) };
  },

  "waves.retry": async (params, { env }) => {
    const file = await findWave(params.id);
    const { view } = await lookWave(file.declaration.id);
    const { id } = view;
    if (!view.actions.includes("waves.retry")) throw new FactoryError("refused", `wave ${short(id)} is ${waveStageText(view)}, retry needs blocked or interrupted`);
    // Blocked with tasks not started or not finished (a launch failed): build again, the runner starts them. Blocked
    // otherwise: review and merge again from the rebase. Interrupted: the runner resumes the stage the log holds.
    if (view.stage === "blocked") {
      // Blocked at its start: queued again, it starts once its branch can.
      const unfinished = view.tasks.some((task) => task.state !== "done" && task.state !== "cancelled");
      let to: WaveStage = unfinished ? "building" : "reviewing";
      if (!file.fold.started) to = "queued";
      await moveWave(id, "blocked", to, "retry needs blocked or interrupted");
    }
    // Its tasks a dead runner left running (`interrupted`) run again through `tasks.retry`'s internals; a refusal is
    // named in the answer and keeps no other from its retry.
    const records = await tasksById();
    const { views } = await waveTaskViews(file.fold, { records });
    const outcomes = await Promise.all(
      [...views.values()]
        .filter((task) => task.interrupted)
        .map(async (task) => {
          try {
            await retryRestingTask(records.get(task.id) as TaskRecord, env);
            return { id: task.id, why: null };
          } catch (error) {
            return { id: task.id, why: oneLine(errorText(error)) };
          }
        }),
    );
    const retried = outcomes.filter((outcome) => outcome.why === null).map((outcome) => outcome.id);
    const refused = outcomes.flatMap((outcome) => (outcome.why === null ? [] : [{ id: outcome.id, why: outcome.why }]));
    await pokeWaveRunner(id, env);
    return { wave: (await lookWave(id)).view, retried, refused };
  },

  "waves.approve": async (params, { env }) => {
    const { id } = (await findWave(params.id)).declaration;
    await moveWave(id, "waiting_approve", "merging", "approve needs waiting_approve");
    await pokeWaveRunner(id, env);
    return { wave: (await lookWave(id)).view };
  },

  "waves.cancel": async (params, { env }) => {
    const { id } = (await findWave(params.id)).declaration;
    // The stage first: a runner (or a poke from a task's runner) that looks now sees the wave rest and starts nothing.
    await appendWaveEvents(id, (fold) => {
      if (waveFinal(fold.stage)) throw new FactoryError("refused", `wave ${short(id)} is ${fold.stage} already`);
      return [{ kind: "stage", stage: "cancelled", reason: null }];
    });
    await stopWaveRunners(id);
    // The queued waves that wait for it can never start: each records why (once).
    for (const fold of queuedAfter(id, await listWaves())) await recordNeverStart(fold).catch(() => undefined);
    await cancelScouts({ kind: "wave", id });
    const failures: string[] = [];
    for (const record of await waveRecords(id)) {
      const view = await taskView(record);
      if (view.state !== null && isFinal(view.state)) continue;
      try {
        await cancelTask(record, env);
      } catch (error) {
        failures.push(`${short(record.id)}: ${oneLine(errorText(error))}`);
      }
    }
    // A conflict task that did not finish moved the wave's branch onto the target's tip: back to the wave's own commits.
    const { fold } = await readWave(id);
    try {
      const undone = await undoConflictBranch(fold, (await waveTaskViews(fold)).states);
      if (undone !== null && undone.includes("checked out")) failures.push(`its branch ${fold.branch}: ${undone}`);
    } catch (error) {
      failures.push(`its branch ${fold.branch}: ${oneLine(errorText(error))}`);
    }
    if (failures.length > 0) throw new FactoryError("failed", `wave ${short(id)} is cancelled, but cleaning up after it failed (${failures.join("; ")}); cancel its tasks with tasks.cancel, put its branch back by hand`);
    return { wave: (await lookWave(id)).view };
  },

  "waves.remove": async (params) => {
    const { declaration } = await findWave(params.id);
    const { id, repo } = declaration;
    const shown = short(id);
    // The runner's lock for the whole removal: no poke starts a runner meanwhile.
    try {
      await lockWave(id);
    } catch (error) {
      if (isBusy(error)) throw new FactoryError("refused", `wave ${shown} has a runner, cancel it first`);
      throw error;
    }
    try {
      if ((await liveWaveRunners(id)).length > 0) throw new FactoryError("refused", `wave ${shown} has a runner, cancel it first`);
      const { stage, branch, started, target } = (await readWave(id)).fold;
      const waiting = queuedAfter(id, await listWaves());
      if (waiting.length > 0) {
        const names = waiting.map((fold) => `${fold.tag} (${short(fold.id)}, ${fold.stage})`).join(", ");
        const one = waiting.length === 1;
        throw new FactoryError("refused", `wave ${shown}: the ${one ? "wave" : "waves"} ${names} ${one ? "waits" : "wait"} for it and ${one ? "has" : "have"} not started, cancel or remove ${one ? "that" : "those"} first`);
      }
      const records = await waveRecords(id);
      // Every refusal before anything is deleted.
      for (const record of records) {
        try {
          const view = await taskView(record);
          requireRemovable(view);
          await droppedWork(record, params.force === true, stage === "merged" && view.state === "done");
        } catch (error) {
          if (error instanceof FactoryError) throw new FactoryError(error.code, `wave ${shown}: ${error.message}`, error.detail);
          throw error;
        }
      }
      // A review worktree a block left behind: removed with the wave, unless it holds somebody's work (without force).
      const review = waveReviewWorktree(declaration);
      const hasReview = existsSync(review);
      if (hasReview && params.force !== true && (await worktreeChanges(runCommand, review, true))) {
        throw new FactoryError("refused", `wave ${shown}: its review worktree ${review} holds uncommitted changes, commit or remove them there, or give force: true to remove it anyway`, {
          force: true,
        });
      }
      for (const record of records) {
        await withTaskLock(
          record,
          async (view) => requireRemovable(view),
          async (view) => {
            await droppedWork(record, params.force === true, stage === "merged" && view.state === "done");
            await deleteTask(record);
          },
        );
      }
      // Before the branch: `git branch -D` refuses a branch a worktree has checked out.
      if (hasReview) {
        const removed = await runCommand(["git", "worktree", "remove", ...(params.force === true ? ["--force"] : []), review], { cwd: repo });
        if (removed.exitCode !== 0) throw new FactoryError("failed", `wave ${shown}: removing its review worktree ${review} failed: ${oneLine(removed.output)}`);
      }
      // Only a branch the target has all of: a merged wave's (a `squash` wave's runner deleted it already, its commits
      // stay under their ref, which the factory never deletes), or an empty one of a wave that never started. Any other
      // branch may hold work nobody merged.
      const empty = async () => (await runCommand(["git", "merge-base", "--is-ancestor", branch, target], { cwd: repo })).exitCode === 0;
      if ((await localBranchExists(repo, branch)) && (stage === "merged" || (!started && (await empty())))) {
        const deleted = await runCommand(["git", "branch", "-D", branch], { cwd: repo });
        if (deleted.exitCode !== 0) throw new FactoryError("failed", `wave ${shown}: deleting its branch ${branch} failed: ${oneLine(deleted.output)}`);
      }
      await removeWave(id);
      return { removed: id };
    } finally {
      await unlockFile(waveLockPath(id)).catch(() => undefined);
    }
  },
} satisfies Record<string, Handler>;

/** How many `fix:` tasks a wave's reviewer may start (`startReviewerFix`); more go to the supervisor. */
export const REVIEWER_FIX_CAP = 3;

/**
 * The events of a reviewer's `fix:` task: a pending task `fix-<n>` titled `fix: ...` (a `tasks` event
 * `by: "reviewer"`); null once the wave has its `REVIEWER_FIX_CAP` of them. `fold` is the wave under its log lock.
 */
export function reviewerFixEvents(fold: WaveFold, fix: { title: string; request: string; model?: ModelSize }): { key: string; events: NewWaveEvent[] } | null {
  const bare = fix.title.trim().replace(/^fix:\s*/i, "");
  const started = fold.fixes;
  if (started >= REVIEWER_FIX_CAP) return null;
  const keys = new Set(fold.tasks.map((task) => task.key));
  let n = started + 1;
  while (keys.has(`fix-${n}`)) n++;
  const key = `fix-${n}`;
  const tasks = validateTaskSpecs([{ key, title: `fix: ${bare}`, request: fix.request, model: fix.model ?? "small" }], fold.tasks);
  return { key, events: [{ kind: "tasks", tasks, by: "reviewer" }] };
}

/**
 * The reviewer's `start_fix`: adds the task of `reviewerFixEvents` to the wave and pokes its runner. Refused past
 * `REVIEWER_FIX_CAP` (checked under the log lock) and in the stages `waves.add` refuses. Resolves with the task's key.
 */
export async function startReviewerFix(waveId: string, fix: { title: string; request: string; model?: ModelSize }, env?: RunnerEnv): Promise<string> {
  const bare = fix.title.trim().replace(/^fix:\s*/i, "");
  if (bare === "") throw new FactoryError("invalid", "start_fix needs a title");
  let key = "";
  await appendWaveEvents(waveId, (fold) => {
    const shown = short(waveId);
    if (waveClosed(fold.stage)) throw new FactoryError("refused", `wave ${shown} is ${fold.stage}, it takes no more tasks`);
    const added = reviewerFixEvents(fold, fix);
    if (added === null) throw new FactoryError("refused", `wave ${shown} has its ${REVIEWER_FIX_CAP} fix tasks already: tell the supervisor with notify_supervisor`);
    key = added.key;
    return added.events;
  });
  await pokeWaveRunner(waveId, env);
  return key;
}

/** The reviewer's `notify_supervisor`: one `note` event, which `notify.ts` turns into one notice to the wave's origin. */
export async function noteToSupervisor(waveId: string, text: string, taskId: string | null): Promise<void> {
  await appendWaveEvents(waveId, [{ kind: "note", text, taskId }]);
}

/** The wave's stage, `interrupted (<stage> ...)` when no runner drives it. */
function waveStageText(view: WaveView): string {
  return view.interrupted ? `interrupted (${view.stage}, no runner)` : view.stage;
}

/** Appends the stage `to` when the wave is at `from` (compare-and-append), else `refused` naming `what`. */
async function moveWave(id: string, from: WaveStage, to: WaveStage, what: string): Promise<void> {
  await appendWaveEvents(id, (fold) => {
    if (fold.stage !== from) throw new FactoryError("refused", `wave ${short(id)} is ${fold.stage}, ${what}`);
    return [{ kind: "stage", stage: to, reason: null }];
  });
}

/** The records of the wave's tasks (those it started and that were not removed). */
async function waveRecords(id: string): Promise<TaskRecord[]> {
  return (await listTasks()).filter((record) => record.wave === id);
}

/** Undoes a `waves.start` that failed midway: its runner, any task it started, its home, its record and its branch. */
async function undoWaveStart(declaration: WaveDeclaration): Promise<void> {
  await stopWaveRunners(declaration.id).catch(() => undefined);
  for (const record of await waveRecords(declaration.id)) await deleteTask(record).catch(() => undefined);
  await rm(await realpath(waveDir(declaration.id)), { recursive: true, force: true }).catch(() => undefined);
  await removeWave(declaration.id);
  await runCommand(["git", "branch", "-D", declaration.branch], { cwd: declaration.repo });
}

/**
 * The ids of the waves `waves.start`'s `after` names among `waves` (the repository's) on `target`: an id or a unique
 * prefix of one, or a tag (the newest wave carrying it that is not cancelled). The new wave's own tag, a name no wave
 * of `target` carries, a cancelled wave: `invalid`.
 */
function resolveAfter(raw: string[] | undefined, waves: readonly WaveFile[], target: string, tag: string): string[] {
  if (raw === undefined) return [];
  const folds = waves.map((file) => file.fold).filter((fold) => fold.target === target);
  const ids: string[] = [];
  for (const item of raw) {
    const name = item.trim();
    if (name === "") throw new FactoryError("invalid", "waves.start: after must name waves by tag or id, not by an empty string");
    if (name === tag) throw new FactoryError("invalid", `waves.start: after names ${name}, the wave itself`);
    let found = folds.find((fold) => fold.id === name);
    if (found === undefined) found = folds.filter((fold) => fold.tag === name && fold.stage !== "cancelled").at(-1);
    if (found === undefined) {
      const matches = folds.filter((fold) => fold.id.startsWith(name));
      if (matches.length > 1) throw new FactoryError("invalid", `waves.start: after names "${name}", which matches ${matches.length} waves, give more of the id`);
      found = matches[0];
    }
    if (found === undefined) throw new FactoryError("invalid", `waves.start: after names "${name}", no wave of this repository on ${target}`);
    if (found.stage === "cancelled") throw new FactoryError("invalid", `waves.start: after names wave ${found.tag} (${short(found.id)}), which is cancelled: the wave could never start`);
    if (!ids.includes(found.id)) ids.push(found.id);
  }
  return ids;
}
