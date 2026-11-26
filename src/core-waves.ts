/**
 * The core's wave actions (`waves.*`, `core.ts` maps them), the wave as clients see it, and what the wave's runner
 * (`wave-runner.ts`), the plugin and the notifier ask of the core about waves.
 *
 * - Build on `waves.ts` (the log and its fold) and `wave-poke.ts` (the runner): a stage change is a compare-and-append
 *   on the log, then a poke; `WaveView.actions` holds the same predicates
 * - `waves.start` declares a wave in full or not at all: a step that fails leaves no branch, no record, no task
 * - `startWaveTasks` is the scheduler the wave's runner calls; `waveMergeRefusal` keeps a task's commits off a wave's
 *   branch once its review began (invariant 2)
 * - `noticeInputs`: the tasks and waves a Pi session started, for its notifications (`notify.ts`)
 */
import { existsSync } from "node:fs";
import { waveContracts } from "./core-contracts.ts";
import { launchSpec, recordStart } from "./core-plan.ts";
import { FactoryError, nonEmpty, oneLine, primaryOf, SHORT_ID_CHARS, shortId, tagParam, type Handler, type Params } from "./core-shared.ts";
import { branchHasConfig, defaultSmallModel, requireFactoryModels, wantedModels } from "./core-settings.ts";
import { cancelTask, cents, droppedWork, FINAL_STATES, rawScoutingCost, rawUsage, removable, requireRemovable, taskView, WAVE_FINAL_STAGES, withTaskLock, type TaskView } from "./core-tasks.ts";
import { git, uncommittedFiles } from "./git.ts";
import { defaultBranch, deleteTask, launchTask, LaunchRefusedError, localBranchExists, type RunnerEnv, worktreePath } from "./launch.ts";
import type { NoticeWave } from "./notify.ts";
import { runCommand } from "./run.ts";
import { DEFAULT_SETTINGS, loadSettings, modelChoice, registeredRepos, resolveSettings, type StoredSettings } from "./settings.ts";
import { normalizeModels, parseSettingsFields } from "./state.ts";
import { mergeTrees, sessionTask } from "./sync.ts";
import { listTasks, tagInGroup, TaskBusyError, type TaskRecord } from "./tasks.ts";
import { errorText } from "./util.ts";
import {
  appendWaveEvent,
  appendWaveEvents,
  createWave,
  foldWave,
  listWaves,
  lockWave,
  parseWaveOverrides,
  readWave,
  removeWave,
  RESTING_WAVE_STAGES,
  reviewBegan,
  startableKeys,
  stuckKeys,
  unreachableKeys,
  unlockWave,
  validateTaskSpecs,
  waveCounts,
  waveStarted,
  waveTaskState,
  type FoldedTask,
  type NewWaveEvent,
  type StartedWaveFold,
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
import { liveWaveRunners, pokeWave, runnerSnapshot, stopWaveRunners, type RunnerSnapshot } from "./wave-poke.ts";
import { cancelScouts, scoutUsage } from "./scouts.ts";
import { waveFeedback } from "./feedback.ts";
import { slotWaiting } from "./test-slots.ts";

export type WaveActionName = "waves.add" | "waves.retry" | "waves.approve" | "waves.cancel" | "waves.remove";

/** Stages a wave takes no tasks in: `merging` too, whose rebased branch is in the merge queue. */
const WAVE_ADD_REFUSED: readonly WaveStage[] = ["merged", "cancelled", "merging"];

/** The specs with their tasks' ids: given when a task is declared, its launch takes it. */
function withIds(specs: WaveTaskEntry[]): WaveTaskEntry[] {
  return specs.map((spec) => ({ ...spec, id: crypto.randomUUID() }));
}

/** The wave branch of `tag` on `target`: `<target>-<tag with "/" as "-">`. */
export function waveBranchName(target: string, tag: string): string {
  return `${target}-${tag.replaceAll("/", "-")}`;
}

/** The wave's review worktree (`wave-runner.ts`): one per wave, next to the tasks' worktrees. */
export function waveReviewWorktree(declaration: Pick<WaveDeclaration, "id" | "repo">): string {
  return worktreePath(declaration.repo, `wave-${declaration.id.slice(0, SHORT_ID_CHARS)}-review`);
}

/**
 * The wave of the task in the Pi session `sessionId` (files in `sessionDir`), null outside one. Only sessions the
 * factory keeps (under its home) are looked up.
 */
export async function taskWave(sessionDir: string, sessionId: string): Promise<string | null> {
  return (await sessionTask(sessionDir, sessionId))?.wave ?? null;
}

/**
 * Why the merge of the task in the Pi session `sessionId` (files in `sessionDir`) must not land now, null when it may
 * (invariant 2): a task of a wave whose review began (`reviewBegan`) would bring commits onto the wave's branch that
 * its gates and reviewer never saw, or that are lost once it merged. The plugin asks right before a task merges, so
 * no path (an action, a `/factory` command typed into the session, a resume) gets past it. Only sessions the factory
 * keeps (under its home) are looked up; a task outside a wave merges as before.
 */
export async function waveMergeRefusal(sessionDir: string, sessionId: string): Promise<string | null> {
  const record = await sessionTask(sessionDir, sessionId);
  if (record === undefined || record.wave === null) return null;
  const short = record.wave.slice(0, SHORT_ID_CHARS);
  let file: WaveFile;
  try {
    file = await readWave(record.wave);
  } catch (error) {
    if (error instanceof FactoryError && error.code === "not_found") return `its wave ${short} is removed: nothing more reaches its branch`;
    throw error;
  }
  if (!reviewBegan(file.events)) return null;
  const { stage, branch } = foldWave(file.declaration, file.events);
  return `its wave ${short} is ${stage}, its review began: nothing more reaches its branch ${branch} (the reviewed tree is what merges); give the work to the wave with waves.add`;
}

/** The wave whose id is `id` or starts with it. */
export async function findWave(id: unknown): Promise<WaveFile> {
  const wanted = nonEmpty(id)?.trim();
  if (wanted === undefined) throw new FactoryError("invalid", "the id of a wave must not be empty");
  const waves = await listWaves();
  const exact = waves.find((wave) => wave.declaration.id === wanted);
  if (exact) return exact;
  const matches = waves.filter((wave) => wave.declaration.id.startsWith(wanted));
  if (matches.length === 0) throw new FactoryError("not_found", `no wave has an id starting with "${wanted}"`);
  if (matches.length > 1) throw new FactoryError("invalid", `"${wanted}" matches ${matches.length} waves, give more of the id`);
  return matches[0];
}

/** Runs `act`, a `TaskBusyError` (the wave's log lock stayed taken) as `busy`. */
async function busyAsFactoryError<T>(act: () => Promise<T>): Promise<T> {
  try {
    return await act();
  } catch (error) {
    if (error instanceof TaskBusyError) throw new FactoryError("busy", error.message);
    throw error;
  }
}

/** Pokes the wave's runner (`wave-poke.ts`); a runner that cannot start is `failed`. */
async function pokeWaveRunner(id: string, env?: RunnerEnv): Promise<void> {
  try {
    await pokeWave(id, env);
  } catch (error) {
    throw new FactoryError("failed", `wave ${id.slice(0, SHORT_ID_CHARS)}: its runner did not start (${oneLine(errorText(error))}); a later poke tries again`);
  }
}

/**
 * The views of the wave's started tasks by key. A started task whose record is gone (removed) counts as `cancelled`:
 * it never finishes.
 */
export async function waveTaskViews(fold: WaveFold, read: ListingReads = {}): Promise<{ states: Map<string, string | null>; views: Map<string, TaskView> }> {
  const records = read.records ?? new Map((await listTasks()).map((record) => [record.id, record]));
  const states = new Map<string, string | null>();
  const views = new Map<string, TaskView>();
  await Promise.all(
    fold.tasks.map(async (task) => {
      if (task.taskId === null) return;
      const record = records.get(task.taskId);
      if (record === undefined) {
        states.set(task.key, "cancelled");
        return;
      }
      const view = await taskView(record, fold.stage, read.snapshot);
      views.set(task.key, view);
      states.set(task.key, view.state);
    }),
  );
  return { states, views };
}

/** What a listing reads once for all its waves: every task record by id, the live runners (`runnerSnapshot`). */
type ListingReads = { records?: ReadonlyMap<string, TaskRecord>; snapshot?: RunnerSnapshot };

function addUsage(sum: WaveView["usage"], usage: WaveView["usage"]): WaveView["usage"] {
  if (usage === null) return sum;
  return { input: (sum?.input ?? 0) + usage.input, output: (sum?.output ?? 0) + usage.output, cacheRead: (sum?.cacheRead ?? 0) + usage.cacheRead, cacheWrite: (sum?.cacheWrite ?? 0) + usage.cacheWrite, cost: (sum?.cost ?? 0) + usage.cost };
}

/**
 * A wave as `tasks.wait` judges it: its view, and whether it is stuck: it builds with tasks that can never start while
 * nothing else moves it (`stuckKeys`), or it is queued after a wave that was cancelled or removed (`queueLook`). A
 * stuck wave rests (its runner does too) and needs attention; it is not interrupted.
 */
export type WaveLook = { view: WaveView; stuck: boolean };

/** The wave as clients see it: its fold, its tasks' states and usage, whether its runner lives. */
async function waveView(file: WaveFile, all?: WaveFile[], read?: ListingReads): Promise<WaveView> {
  return (await lookWave(file, all, read)).view;
}

/**
 * The waves among `files` that wait for the wave `id` and have not started (queued, or blocked at their start), not
 * cancelled ones: a merge pokes them, a cancel makes them never start, and the wave is not removed under them.
 */
function queuedAfter(id: string, files: readonly WaveFile[]): WaveFold[] {
  return files.map((file) => foldWave(file.declaration, file.events)).filter((fold) => !waveStarted(fold) && fold.stage !== "cancelled" && fold.after.includes(id));
}

/**
 * A queued wave that can start and that nothing starts: every wave it names is merged, and neither its runner nor one
 * of theirs lives (a merged wave's runner died before it poked). It counts as interrupted; `waves.retry` pokes it.
 */
export async function queueStalled(fold: WaveFold, look: { waiting: string[]; never: string | null }, running: boolean, snapshot?: RunnerSnapshot): Promise<boolean> {
  if (fold.stage !== "queued" || running || look.never !== null || look.waiting.length > 0) return false;
  for (const id of fold.after) if ((await liveWaveRunners(id, snapshot)).length > 0) return false;
  return true;
}

/**
 * What a queued wave waits for: the ids of the waves it names that are not `merged` yet (`waiting`), and why it can
 * never start when one of them was cancelled or removed (`never`, the text of its `stage` event), else null. `all`:
 * the waves read already (else each is read).
 */
export async function queueLook(fold: WaveFold, all?: readonly WaveFile[]): Promise<{ waiting: string[]; never: string | null }> {
  const waiting: string[] = [];
  for (const id of fold.after) {
    const short = id.slice(0, SHORT_ID_CHARS);
    let file = all?.find((candidate) => candidate.declaration.id === id);
    if (file === undefined) {
      try {
        file = await readWave(id);
      } catch (error) {
        if (error instanceof FactoryError && error.code === "not_found") return { waiting, never: `it waits for wave ${short}, which was removed: it can never start; waves.cancel or waves.remove it` };
        throw error;
      }
    }
    const named = foldWave(file.declaration, file.events);
    if (named.stage === "cancelled") return { waiting, never: `it waits for wave ${named.tag} (${short}), which was cancelled: it can never start; waves.cancel or waves.remove it` };
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
 * The wave's runner on a queued wave: when every wave it names is `merged` it starts (a `start` event with its branch
 * and `base` = the target's tip; `startWaveTasks` cuts the branch), else it rests, recording why when it never can.
 * Its branch taken by then, or the target unreadable: `blocked`. Resolves with whether the wave moved on (look again).
 */
export async function startQueuedWave(id: string): Promise<boolean> {
  const file = await readWave(id);
  const fold = foldWave(file.declaration, file.events);
  if (fold.stage !== "queued") return true;
  if (await recordNeverStart(fold)) return false;
  if ((await queueLook(fold)).waiting.length > 0) return false;
  const block = async (detail: string) =>
    (await appendWaveEvents(id, (now) => (now.stage === "queued" ? [{ kind: "stage", stage: "blocked", reason: "infra", detail }] : null))) !== null;
  const branch = waveBranchName(fold.target, fold.tag);
  if (await localBranchExists(fold.repo, branch)) return block(`its branch ${branch} exists already (taken since the wave was declared): delete or rename it, then waves.retry`);
  let base: string;
  try {
    base = await git(runCommand, fold.repo, ["rev-parse", "--verify", `refs/heads/${fold.target}^{commit}`]);
  } catch (error) {
    return block(`its target ${fold.target}: ${oneLine(errorText(error))}; waves.retry`);
  }
  await appendWaveEvents(id, (now) => (now.stage === "queued" ? [{ kind: "start", branch, base }] : null));
  return true;
}

/**
 * Pokes every queued wave that waits for the merged wave `id`: the one whose last named wave this was starts. A poke
 * that fails is left to the next one (`waves.retry`); the error is returned for the runner's log.
 */
export async function pokeQueuedAfter(id: string, env?: RunnerEnv): Promise<string[]> {
  const failures: string[] = [];
  for (const fold of queuedAfter(id, await listWaves())) {
    await pokeWave(fold.id, env).catch((error: unknown) => failures.push(`wave ${fold.id.slice(0, SHORT_ID_CHARS)}: ${oneLine(errorText(error))}`));
  }
  return failures;
}

/** The wave as `tasks.wait` judges it (`WaveLook`). */
export async function waveLook(file: WaveFile): Promise<WaveLook> {
  return lookWave(file);
}

/** `waveLook` with the waves read already (`all`: every wave), else they are read; `read`: a listing's shared reads. */
async function lookWave(file: WaveFile, all?: readonly WaveFile[], read: ListingReads = {}): Promise<WaveLook> {
  const full = foldWave(file.declaration, file.events);
  const { overrides: _overrides, ...fold } = full;
  const { states, views } = await waveTaskViews(full, read);
  const runners = await liveWaveRunners(fold.id, read.snapshot);
  const running = runners.length > 0;
  const waitingForSlot = await slotWaiting(runners);
  const waves = all ?? (await listWaves());
  const queue = fold.stage === "queued" ? await queueLook(full, waves) : null;
  const stuck = (fold.stage === "building" && stuckKeys(full, states).length > 0) || (queue !== null && queue.never !== null);
  const interrupted = (!RESTING_WAVE_STAGES.includes(fold.stage) && !running && !stuck) || (queue !== null && (await queueStalled(full, queue, running, read.snapshot)));
  let usage: WaveView["usage"] = null;
  const tasks = fold.tasks.map((task) => {
    const taskView = views.get(task.key);
    const taskUsage = taskView?.usage ?? null;
    usage = addUsage(usage, taskView ? rawUsage(taskView) : null);
    const id = task.taskId ?? task.id;
    return { key: task.key, title: task.title, after: task.after, model: task.model, taskId: task.taskId, sessionId: task.sessionId, state: waveTaskState(task, states), usage: taskUsage, ...(id === undefined ? {} : { id }) };
  });
  for (const review of fold.reviews) usage = addUsage(usage, review.usage);
  // The wave's own scouts (its reviewer's), then its tasks' (in their usage already).
  const waveScouting = await scoutUsage({ kind: "wave", id: fold.id });
  usage = addUsage(usage, waveScouting);
  const scoutingCost = cents([...views.values()].reduce((sum, view) => sum + rawScoutingCost(view), waveScouting?.cost ?? 0));
  // The predicates of the wave actions' own checks, as one list for clients.
  const allowed: Record<WaveActionName, boolean> = {
    "waves.add": !WAVE_ADD_REFUSED.includes(fold.stage),
    "waves.retry": fold.stage === "blocked" || interrupted,
    "waves.approve": fold.stage === "waiting_approve",
    "waves.cancel": !WAVE_FINAL_STAGES.includes(fold.stage),
    // `tasks.remove` of a task maybe only with force, as for the task itself; its done tasks go with the wave. Not
    // while a wave that has not started waits for it.
    "waves.remove": !running && [...views.values()].every(removable) && queuedAfter(fold.id, waves).length === 0,
  };
  const actions = (Object.keys(allowed) as WaveActionName[]).filter((name) => allowed[name]);
  const reviews = fold.reviews.map((review) => (review.usage === null ? review : { ...review, usage: { ...review.usage, cost: cents(review.usage.cost) } }));
  const total = usage === null ? null : { ...(usage as NonNullable<WaveView["usage"]>), cost: cents((usage as NonNullable<WaveView["usage"]>).cost) };
  return { view: { ...fold, reviews, running, interrupted, tasks, counts: waveCounts(full, states), usage: total, scoutingCost, actions, ...(waitingForSlot ? { waitingForSlot } : {}) }, stuck };
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
  const waves = await Promise.all(files.map(async (file) => ({ ...(await lookWave(file, all)), events: file.events })));
  return { tasks, waves };
}

/**
 * The scheduler: starts every pending task of the wave whose `after` tasks are all `done`, through `launchTask` with
 * the wave's branch as target, its tag, plan and id, and records a `task` event for each. Only the wave's runner calls
 * it, holding the runner's lock: no task starts twice. A record of this wave no `task` event names (a runner died
 * between the launch and its event) is adopted for the first pending task of its title instead of a second launch.
 * Nothing starts unless the wave is `building`. A wave that started queued gets its branch here, cut at its `base`,
 * while none of its tasks started (a runner that died between the `start` event and the branch). A branch of that
 * name it did not cut (another commit than `base`, and no task of the wave exists) throws `refused`: the runner blocks
 * the wave, as `startQueuedWave` does. Resolves with the
 * started keys; a launch that fails throws (`refused` or `failed`) after the tasks started before it are recorded.
 * `signal` (the runner stops): no further launch, the running one is undone (`launchTask`), and it resolves with the
 * keys started before. A conflict task (`conflictTask`) starts on the wave's branch moved to the target's tip it
 * recorded, its worktree holding the wave's change merged onto that tip with the markers left.
 */
export async function startWaveTasks(id: string, env?: RunnerEnv, signal?: AbortSignal): Promise<string[]> {
  const { declaration, events } = await readWave(id);
  const fold = foldWave(declaration, events);
  if (fold.stage !== "building" || !waveStarted(fold)) return [];
  if (fold.after.length > 0 && fold.tasks.every((task) => task.taskId === null)) {
    if (!(await localBranchExists(fold.repo, fold.branch))) {
      const made = await runCommand(["git", "branch", fold.branch, fold.base], { cwd: fold.repo });
      if (made.exitCode !== 0) throw new FactoryError("failed", `cutting its branch ${fold.branch} at ${fold.base} failed: ${oneLine(made.output)}`);
    } else if (!(await listTasks()).some((record) => record.wave === id) && !(await ownEmptyBranch(fold.repo, fold.branch, fold.base, fold.target))) {
      throw new FactoryError("refused", `its branch ${fold.branch} exists already and is not the one it cut at its start (taken since): delete or rename it`);
    }
  }
  const { states } = await waveTaskViews(fold);
  const { maxRounds, review } = declaration.overrides;
  // The wave's models only (`launchTask` reads no stored models for a wave's task); a name the wave sets none for runs
  // with Pi's session model, except `small`, which a task asking for it takes from `defaults.yaml` when listed.
  const models = normalizeModels(declaration.overrides.models ?? {});
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
    // A declared id names its record; else (an old log's spec, a record of an older launch) its title does.
    const byId = found.id === undefined ? -1 : orphans.findIndex((record) => record.id === found.id);
    const orphan = byId >= 0 ? byId : orphans.findIndex((record) => record.title === found.title);
    let record: TaskRecord;
    // Launched with its spec as the log holds it now (`tasks.update` may have changed it since the fold above).
    let task: Pick<FoldedTask, "title" | "request" | "model"> = found;
    if (orphan >= 0) {
      [record] = orphans.splice(orphan, 1);
      // A runner that died after the launch: the coder got the launched text, a later update reaches it as a follow-up.
      const launch = events.findLast((event) => event.kind === "launch" && event.key === key);
      if (launch?.kind === "launch" && launch.request !== undefined) task = { ...found, title: launch.title ?? found.title, request: launch.request };
    } else {
      const spec = await launchSpec(id, key, found.after);
      if (spec === null) continue;
      task = spec;
      if (spec.model === "small" && models.small === undefined) {
        const small = await defaultSmallModel();
        if (small !== undefined) models.small = small;
      }
      try {
        // A conflict task: the wave's branch on the target's tip, its worktree the wave's change merged onto it.
        const conflict = fold.conflicts?.find((candidate) => candidate.key === key);
        if (conflict !== undefined) await conflictBranch(fold, conflict);
        const prepare = conflict === undefined ? {} : { beforeRecord: (_branch: string, worktree: string) => leaveMarkers(worktree, conflict) };
        // The task's size picks its coder's model of the wave's; the reviewer's stays the wave's.
        record = await launchTask({ repo: declaration.repo, title: spec.title, request: spec.request, overrides, size: spec.model, ...(spec.id === undefined ? {} : { id: spec.id }), tag: declaration.tag, plan: declaration.plan, wave: id, origin: declaration.origin, env, signal, ...prepare, ...(declaration.contracts === undefined ? {} : { contracts: declaration.contracts }) });
      } catch (error) {
        if (signal?.aborted) break;
        const why = `starting its task ${key} failed: ${oneLine(errorText(error))}`;
        throw new FactoryError(error instanceof LaunchRefusedError ? "refused" : "failed", why);
      }
    }
    // A `tasks.update` between the launch and this event reaches the coder as a follow-up.
    await recordStart(id, key, task, record);
    started.push(key);
  }
  return started;
}

/** How many conflict tasks (`conflict-<n>`) a wave gets; the next conflict blocks it. */
export const CONFLICT_TASKS = 2;
/** How many commit subjects of each side a conflict task's request names. */
const SUBJECTS_SHOWN = 20;

/**
 * The events that send a wave whose rebase onto its target conflicted (not additions-only) back to building: a
 * `conflict` event (the branch's tip `head`, the target's tip `onto`, the conflicting files of their merge, else
 * `rebaseFiles`) and the task `conflict-<n>` that resolves it, its request naming the files and the subjects of both
 * sides' commits. Null once the wave had `CONFLICT_TASKS`: the conflict blocks it.
 */
export async function conflictTask(fold: StartedWaveFold, phase: "review" | "merge", rebaseFiles: readonly string[]): Promise<{ key: string; events: NewWaveEvent[] } | null> {
  const count = fold.conflicts?.length ?? 0;
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
async function conflictBranch(fold: StartedWaveFold, conflict: WaveConflict): Promise<void> {
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
export async function undoConflictBranch(fold: StartedWaveFold, states: TaskStates): Promise<string | null> {
  const conflict = fold.conflicts?.at(-1);
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
 * conflict markers left, uncommitted, as `applySync` (`sync.ts`) leaves a sync's. On the files the merge changes it
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
    const specs = withIds(validateTaskSpecs(params.tasks));
    const contracts = await waveContracts(params.plan as string | undefined, params.contracts);
    let target: string | undefined;
    let overrides: WaveOverrides;
    try {
      const fields = parseSettingsFields((params.overrides ?? {}) as Params, "overrides.");
      target = fields.branch;
      overrides = parseWaveOverrides(params.overrides ?? {});
    } catch (error) {
      throw new FactoryError("invalid", `waves.start: ${errorText(error)}`);
    }
    const repo = await primaryOf(params.repo as string, cwd);
    if (!(await registeredRepos()).includes(repo)) throw new FactoryError("not_found", `${repo} is not registered, add it with repos.add first`);
    const stored = await loadSettings(repo);
    // Resolved once, here: the wave's tasks, review and merge read only the declaration.
    const { merge, maxRounds, review, models } = resolveSettings(stored, overrides, "");
    overrides = { merge, maxRounds, review, models: modelChoice(models), remote: overrides.remote ?? stored.remote ?? DEFAULT_SETTINGS.remote };
    await requireFactoryModels(wantedModels(models, specs));
    target ??= stored.branch ?? (await defaultBranch(repo).catch(() => undefined));
    if (target === undefined) throw new FactoryError("refused", `${repo} has no default branch (origin/HEAD, main and master do not exist locally)`);
    if (!(await localBranchExists(repo, target))) throw new FactoryError("not_found", `${repo} has no local branch ${target}`);
    if (!(await branchHasConfig(repo, target))) {
      throw new FactoryError("refused", `${repo}: branch ${target} has no factory.yaml (write one with /factory init or the config.write action, and commit it)`);
    }
    const branch = waveBranchName(target, tag);
    if ((await runCommand(["git", "check-ref-format", "--branch", branch], { cwd: repo })).exitCode !== 0) {
      throw new FactoryError("invalid", `waves.start: ${branch} (target and tag) is no valid branch name`);
    }
    if (await localBranchExists(repo, branch)) throw new FactoryError("refused", `${repo}: the wave branch ${branch} exists already (another wave of tag ${tag} on ${target}?)`);
    const all = await listWaves(repo);
    // A wave that has not started yet reserves its branch's name.
    const reserving = all.map((file) => foldWave(file.declaration, file.events)).find((fold) => !waveStarted(fold) && fold.stage !== "cancelled" && waveBranchName(fold.target, fold.tag) === branch);
    if (reserving !== undefined) throw new FactoryError("refused", `${repo}: the wave branch ${branch} is reserved by wave ${reserving.id.slice(0, SHORT_ID_CHARS)}, which is ${reserving.stage}`);
    const after = resolveAfter(params.after, all, target, tag);
    const queued = after.length > 0;
    // A queued wave gets its branch when it starts: off the target's tip then, with the code of the waves it waits for.
    const base = queued ? null : await git(runCommand, repo, ["rev-parse", "--verify", `refs/heads/${target}^{commit}`]);
    if (base !== null) await git(runCommand, repo, ["branch", branch, base]);
    const declaration: WaveDeclaration = {
      id: crypto.randomUUID(),
      repo,
      tag,
      plan: (params.plan as string | undefined) ?? null,
      title,
      request,
      branch: queued ? null : branch,
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
      await busyAsFactoryError(() => appendWaveEvent(declaration.id, { kind: "tasks", tasks: specs }));
      await pokeWaveRunner(declaration.id, env);
    } catch (error) {
      await undoWaveStart(declaration).catch(() => undefined);
      throw error;
    }
    return { wave: await waveView(await readWave(declaration.id)) };
  },

  "waves.add": async (params, { env }) => {
    const file = await findWave(params.id);
    const { id } = file.declaration;
    // Task states only move on: pending tasks that can never start now never will (a cancel is final).
    const current = foldWave(file.declaration, file.events);
    const { states } = await waveTaskViews(current);
    // The models list is read before the log lock; the specs are checked again under it. `waves.start` checked the big
    // model; the small one the wave names only when an added task is the first to ask for it.
    if (validateTaskSpecs(params.tasks, current.tasks).some((spec) => spec.model === "small")) {
      await requireFactoryModels({ small: file.declaration.overrides.models?.small });
    }
    // Checked and appended under the log lock: a runner's stage change after it loses, never the added tasks.
    await busyAsFactoryError(() =>
      appendWaveEvents(id, (fold) => {
        if (WAVE_ADD_REFUSED.includes(fold.stage)) throw new FactoryError("refused", `wave ${id.slice(0, SHORT_ID_CHARS)} is ${fold.stage}, it takes no more tasks`);
        const tasks = withIds(validateTaskSpecs(params.tasks, fold.tasks));
        // The supervisor acts on a wave whose pending tasks can never start: they leave it (count as cancelled).
        const dropped = unreachableKeys(fold, states);
        const events: NewWaveEvent[] = [{ kind: "tasks", tasks, ...(dropped.length > 0 ? { dropped } : {}) }];
        // A wave that never started (queued, or blocked at its start) waits for its waves again.
        const builds: WaveStage = waveStarted(fold) ? "building" : "queued";
        if (fold.stage !== builds) events.push({ kind: "stage", stage: builds, reason: null });
        return events;
      }),
    );
    await pokeWaveRunner(id, env);
    return { wave: await waveView(await readWave(id)) };
  },

  "waves.get": async (params) => {
    const file = await findWave(params.id);
    const view = await waveView(file);
    return { wave: { ...view, feedback: await waveFeedback(file.declaration.plan, view.id) } };
  },

  "waves.list": async (params, { cwd }) => {
    const tag = tagParam("waves.list", params.tag);
    const repo = params.repo === undefined ? undefined : await primaryOf(params.repo as string, cwd);
    const origin = params.origin === undefined ? undefined : nonEmpty(params.origin)?.trim();
    if (params.origin !== undefined && origin === undefined) throw new FactoryError("invalid", "waves.list: origin must be a non-empty session id");
    if (params.open !== undefined && typeof params.open !== "boolean") throw new FactoryError("invalid", "waves.list: open must be true or false");
    const all = await listWaves();
    const files = all.filter(
      (file) =>
        (repo === undefined || file.declaration.repo === repo) &&
        (tag === undefined || tagInGroup(file.declaration.tag, tag)) &&
        (origin === undefined || file.declaration.origin === origin) &&
        (params.open !== true || !WAVE_FINAL_STAGES.includes(foldWave(file.declaration, file.events).stage)),
    );
    if (files.length === 0) return { waves: [] };
    // One read of the task records and one of the runners for every wave, not one per wave and task.
    const [records, snapshot] = await Promise.all([listTasks(), runnerSnapshot()]);
    const read: ListingReads = { records: new Map(records.map((record) => [record.id, record])), snapshot };
    return { waves: await Promise.all(files.map((file) => waveView(file, all, read))) };
  },

  "waves.timeline": async (params) => {
    const { events } = await findWave(params.id);
    const since = (params.since as number | undefined) ?? 0;
    if (since > events.length) throw new FactoryError("invalid", `since ${since} is past the wave's last event (${events.length})`);
    return { events: events.slice(since), next: events.length };
  },

  "waves.retry": async (params, { env }) => {
    const file = await findWave(params.id);
    const view = await waveView(file);
    const { id } = view;
    if (!view.actions.includes("waves.retry")) throw new FactoryError("refused", `wave ${id.slice(0, SHORT_ID_CHARS)} is ${waveStageText(view)}, retry needs blocked or interrupted`);
    // Blocked with tasks not started or not finished (a launch failed): build again, the runner starts them. Blocked
    // otherwise: review and merge again from the rebase. Interrupted: the runner resumes the stage the log holds.
    if (view.stage === "blocked") {
      // Blocked at its start (its branch was taken): queued again, it starts once its branch name is free.
      const unfinished = view.tasks.some((task) => task.state !== "done" && task.state !== "cancelled");
      let to: WaveStage = unfinished ? "building" : "reviewing";
      if (view.branch === null) to = "queued";
      await moveWave(id, "blocked", to, "retry needs blocked or interrupted");
    }
    await pokeWaveRunner(id, env);
    return { wave: await waveView(await readWave(id)) };
  },

  "waves.approve": async (params, { env }) => {
    const { id } = (await findWave(params.id)).declaration;
    await moveWave(id, "waiting_approve", "merging", "approve needs waiting_approve");
    await pokeWaveRunner(id, env);
    return { wave: await waveView(await readWave(id)) };
  },

  "waves.cancel": async (params, { env }) => {
    const { id } = (await findWave(params.id)).declaration;
    // The stage first: a runner (or a poke from a task's runner) that looks now sees the wave rest and starts nothing.
    await busyAsFactoryError(() =>
      appendWaveEvents(id, (fold) => {
        if (WAVE_FINAL_STAGES.includes(fold.stage)) throw new FactoryError("refused", `wave ${id.slice(0, SHORT_ID_CHARS)} is ${fold.stage} already`);
        return [{ kind: "stage", stage: "cancelled", reason: null }];
      }),
    );
    await stopWaveRunners(id);
    // The queued waves that wait for it can never start: each records why (once).
    for (const fold of queuedAfter(id, await listWaves())) await recordNeverStart(fold).catch(() => undefined);
    await cancelScouts({ kind: "wave", id });
    const failures: string[] = [];
    for (const record of await waveRecords(id)) {
      const view = await taskView(record);
      if (view.state !== null && FINAL_STATES.includes(view.state)) continue;
      try {
        await cancelTask(record, env);
      } catch (error) {
        failures.push(`${shortId(record)}: ${oneLine(errorText(error))}`);
      }
    }
    // A conflict task that did not finish moved the wave's branch onto the target's tip: back to the wave's own commits.
    const after = await readWave(id);
    const fold = foldWave(after.declaration, after.events);
    if (waveStarted(fold)) {
      try {
        const undone = await undoConflictBranch(fold, (await waveTaskViews(fold)).states);
        if (undone !== null && undone.includes("checked out")) failures.push(`its branch ${fold.branch}: ${undone}`);
      } catch (error) {
        failures.push(`its branch ${fold.branch}: ${oneLine(errorText(error))}`);
      }
    }
    if (failures.length > 0) throw new FactoryError("failed", `wave ${id.slice(0, SHORT_ID_CHARS)} is cancelled, but cleaning up after it failed (${failures.join("; ")}); cancel its tasks with tasks.cancel, put its branch back by hand`);
    return { wave: await waveView(await readWave(id)) };
  },

  "waves.remove": async (params) => {
    const { declaration } = await findWave(params.id);
    const { id, repo } = declaration;
    const short = id.slice(0, SHORT_ID_CHARS);
    // The runner's lock for the whole removal: no poke starts a runner meanwhile.
    try {
      await lockWave(id);
    } catch (error) {
      if (error instanceof TaskBusyError) throw new FactoryError("refused", `wave ${short} has a runner, cancel it first`);
      throw error;
    }
    try {
      if ((await liveWaveRunners(id)).length > 0) throw new FactoryError("refused", `wave ${short} has a runner, cancel it first`);
      const file = await readWave(id);
      const { stage, branch } = foldWave(file.declaration, file.events);
      const waiting = queuedAfter(id, await listWaves());
      if (waiting.length > 0) {
        const names = waiting.map((fold) => `${fold.tag} (${fold.id.slice(0, SHORT_ID_CHARS)}, ${fold.stage})`).join(", ");
        const one = waiting.length === 1;
        throw new FactoryError("refused", `wave ${short}: the ${one ? "wave" : "waves"} ${names} ${one ? "waits" : "wait"} for it and ${one ? "has" : "have"} not started, cancel or remove ${one ? "that" : "those"} first`);
      }
      const records = await waveRecords(id);
      // Every refusal before anything is deleted.
      for (const record of records) {
        try {
          requireRemovable(await taskView(record));
          await droppedWork(record, params.force === true);
        } catch (error) {
          if (error instanceof FactoryError) throw new FactoryError(error.code, `wave ${short}: ${error.message}`, error.detail);
          throw error;
        }
      }
      // A review worktree a block left behind: removed with the wave, unless it holds somebody's work (without force).
      const review = waveReviewWorktree(declaration);
      const hasReview = existsSync(review);
      if (hasReview && params.force !== true && (await uncommittedFiles(runCommand, review))) {
        throw new FactoryError("refused", `wave ${short}: its review worktree ${review} holds uncommitted changes, commit or remove them there, or give force: true to remove it anyway`, {
          force: true,
        });
      }
      for (const record of records) {
        await withTaskLock(
          record,
          async (view) => requireRemovable(view),
          async () => {
            await droppedWork(record, params.force === true);
            await deleteTask(record);
          },
        );
      }
      // Before the branch: `git branch -D` refuses a branch a worktree has checked out.
      if (hasReview) {
        const removed = await runCommand(["git", "worktree", "remove", ...(params.force === true ? ["--force"] : []), review], { cwd: repo });
        if (removed.exitCode !== 0) throw new FactoryError("failed", `wave ${short}: removing its review worktree ${review} failed: ${oneLine(removed.output)}`);
      }
      // Only a merged wave's branch: the target has all of it. Any other branch may hold work nobody merged.
      if (stage === "merged" && branch !== null && (await localBranchExists(repo, branch))) {
        const deleted = await runCommand(["git", "branch", "-D", branch], { cwd: repo });
        if (deleted.exitCode !== 0) throw new FactoryError("failed", `wave ${short}: deleting its branch ${branch} failed: ${oneLine(deleted.output)}`);
      }
      await removeWave(id);
      return { removed: id };
    } finally {
      await unlockWave(id).catch(() => undefined);
    }
  },
} satisfies Record<string, Handler>;

/** The wave's stage, `interrupted (<stage> ...)` when no runner drives it. */
function waveStageText(view: WaveView): string {
  return view.interrupted ? `interrupted (${view.stage}, no runner)` : view.stage;
}

/** Appends the stage `to` when the wave is at `from` (compare-and-append), else `refused` naming `what`. */
async function moveWave(id: string, from: WaveStage, to: WaveStage, what: string): Promise<void> {
  await busyAsFactoryError(() =>
    appendWaveEvents(id, (fold) => {
      if (fold.stage !== from) throw new FactoryError("refused", `wave ${id.slice(0, SHORT_ID_CHARS)} is ${fold.stage}, ${what}`);
      return [{ kind: "stage", stage: to, reason: null }];
    }),
  );
}

/** The records of the wave's tasks (those it started and that were not removed). */
async function waveRecords(id: string): Promise<TaskRecord[]> {
  return (await listTasks()).filter((record) => record.wave === id);
}

/** Undoes a `waves.start` that failed midway: its runner, any task it started, its record and its branch. */
async function undoWaveStart(declaration: WaveDeclaration): Promise<void> {
  await stopWaveRunners(declaration.id).catch(() => undefined);
  for (const record of await waveRecords(declaration.id)) await deleteTask(record).catch(() => undefined);
  await removeWave(declaration.id);
  if (declaration.branch !== null) await runCommand(["git", "branch", "-D", declaration.branch], { cwd: declaration.repo });
}

/**
 * The ids of the waves `waves.start`'s `after` names among `waves` (the repository's) on `target`: an id or a unique
 * prefix of one, or a tag (the newest wave carrying it that is not cancelled). The new wave's own tag, a name no wave
 * of `target` carries, a cancelled wave: `invalid`.
 */
function resolveAfter(raw: unknown, waves: readonly WaveFile[], target: string, tag: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new FactoryError("invalid", "waves.start: after must be an array of wave tags or ids");
  const folds = waves.map((file) => foldWave(file.declaration, file.events)).filter((fold) => fold.target === target);
  const ids: string[] = [];
  for (const item of raw) {
    const name = typeof item === "string" ? item.trim() : "";
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
    if (found.stage === "cancelled") throw new FactoryError("invalid", `waves.start: after names wave ${found.tag} (${found.id.slice(0, SHORT_ID_CHARS)}), which is cancelled: the wave could never start`);
    if (!ids.includes(found.id)) ids.push(found.id);
  }
  return ids;
}

/**
 * Whether the local branch is the wave's own: at `base`, or (a sync fast-forwards an empty wave branch when another
 * wave merges) holding `base` as an ancestor and no commit beyond `target`.
 */
async function ownEmptyBranch(repo: string, branch: string, base: string, target: string): Promise<boolean> {
  const tip = await git(runCommand, repo, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
  if (tip === base) return true;
  if ((await runCommand(["git", "merge-base", "--is-ancestor", base, tip], { cwd: repo })).exitCode !== 0) return false;
  const beyond = await runCommand(["git", "rev-list", "--count", `${target}..${tip}`], { cwd: repo });
  return beyond.exitCode === 0 && beyond.output.trim() === "0";
}
