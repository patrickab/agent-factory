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
import { join, resolve, sep } from "node:path";
import type { ActionName } from "./core.ts";
import { FactoryError, nonEmpty, oneLine, primaryOf, SHORT_ID_CHARS, shortId, tagParam, type Handler, type Params } from "./core-shared.ts";
import { branchHasConfig, defaultSmallModel, requireFactoryModels, wantedModels } from "./core-settings.ts";
import { cancelTask, cents, droppedWork, FINAL_STATES, rawUsage, removable, requireRemovable, taskView, WAVE_FINAL_STAGES, withTaskLock, type TaskView } from "./core-tasks.ts";
import { git, uncommittedFiles } from "./git.ts";
import { defaultBranch, deleteTask, launchTask, LaunchRefusedError, localBranchExists, type RunnerEnv, worktreePath } from "./launch.ts";
import type { NoticeWave } from "./notify.ts";
import { runCommand } from "./run.ts";
import { DEFAULT_SETTINGS, factoryHome, loadSettings, modelChoice, registeredRepos, resolveSettings, type StoredSettings } from "./settings.ts";
import { normalizeModels, parseSettingsFields } from "./state.ts";
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
  waveTaskState,
  type NewWaveEvent,
  type WaveDeclaration,
  type WaveFile,
  type WaveFold,
  type WaveOverrides,
  type WaveStage,
  type WaveView,
} from "./waves.ts";
import { liveWaveRunners, pokeWave, stopWaveRunners } from "./wave-poke.ts";

export type WaveActionName = "waves.add" | "waves.retry" | "waves.approve" | "waves.cancel" | "waves.remove";

/** Stages a wave takes no tasks in: `merging` too, whose rebased branch is in the merge queue. */
const WAVE_ADD_REFUSED: readonly WaveStage[] = ["merged", "cancelled", "merging"];

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
  const sessions = join(factoryHome(), "sessions") + sep;
  if (!resolve(sessionDir).startsWith(sessions)) return null;
  return (await listTasks()).find((task) => task.sessionId === sessionId)?.wave ?? null;
}

/**
 * Why the merge of the task in the Pi session `sessionId` (files in `sessionDir`) must not land now, null when it may
 * (invariant 2): a task of a wave whose review began (`reviewBegan`) would bring commits onto the wave's branch that
 * its gates and reviewer never saw, or that are lost once it merged. The plugin asks right before a task merges, so
 * no path (an action, a `/factory` command typed into the session, a resume) gets past it. Only sessions the factory
 * keeps (under its home) are looked up; a task outside a wave merges as before.
 */
export async function waveMergeRefusal(sessionDir: string, sessionId: string): Promise<string | null> {
  const sessions = join(factoryHome(), "sessions") + sep;
  if (!resolve(sessionDir).startsWith(sessions)) return null;
  const record = (await listTasks()).find((task) => task.sessionId === sessionId);
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
export async function waveTaskViews(fold: WaveFold): Promise<{ states: Map<string, string | null>; views: Map<string, TaskView> }> {
  const records = new Map((await listTasks()).map((record) => [record.id, record]));
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
      const view = await taskView(record, fold.stage);
      views.set(task.key, view);
      states.set(task.key, view.state);
    }),
  );
  return { states, views };
}

function addUsage(sum: WaveView["usage"], usage: WaveView["usage"]): WaveView["usage"] {
  if (usage === null) return sum;
  return { input: (sum?.input ?? 0) + usage.input, output: (sum?.output ?? 0) + usage.output, cacheRead: (sum?.cacheRead ?? 0) + usage.cacheRead, cacheWrite: (sum?.cacheWrite ?? 0) + usage.cacheWrite, cost: (sum?.cost ?? 0) + usage.cost };
}

/**
 * A wave as `tasks.wait` judges it: its view, and whether it builds stuck (`stuckKeys`): tasks that can never start
 * while nothing else moves it. A stuck wave rests (its runner does too) and needs attention; it is not interrupted.
 */
export type WaveLook = { view: WaveView; stuck: boolean };

/** The wave as clients see it: its fold, its tasks' states and usage, whether its runner lives. */
async function waveView(file: WaveFile): Promise<WaveView> {
  return (await waveLook(file)).view;
}

export async function waveLook(file: WaveFile): Promise<WaveLook> {
  const full = foldWave(file.declaration, file.events);
  const { overrides: _overrides, ...fold } = full;
  const { states, views } = await waveTaskViews(full);
  const running = (await liveWaveRunners(fold.id)).length > 0;
  const stuck = fold.stage === "building" && stuckKeys(full, states).length > 0;
  const interrupted = !RESTING_WAVE_STAGES.includes(fold.stage) && !running && !stuck;
  let usage: WaveView["usage"] = null;
  const tasks = fold.tasks.map((task) => {
    const taskView = views.get(task.key);
    const taskUsage = taskView?.usage ?? null;
    usage = addUsage(usage, taskView ? rawUsage(taskView) : null);
    return { key: task.key, title: task.title, after: task.after, model: task.model, taskId: task.taskId, sessionId: task.sessionId, state: waveTaskState(task, states), usage: taskUsage };
  });
  for (const review of fold.reviews) usage = addUsage(usage, review.usage);
  // The predicates of the wave actions' own checks, as one list for clients.
  const allowed: Record<WaveActionName, boolean> = {
    "waves.add": !WAVE_ADD_REFUSED.includes(fold.stage),
    "waves.retry": fold.stage === "blocked" || interrupted,
    "waves.approve": fold.stage === "waiting_approve",
    "waves.cancel": !WAVE_FINAL_STAGES.includes(fold.stage),
    // `tasks.remove` of a task maybe only with force, as for the task itself; its done tasks go with the wave.
    "waves.remove": !running && [...views.values()].every(removable),
  };
  const actions = (Object.keys(allowed) as WaveActionName[]).filter((name) => allowed[name]);
  const reviews = fold.reviews.map((review) => (review.usage === null ? review : { ...review, usage: { ...review.usage, cost: cents(review.usage.cost) } }));
  const total = usage === null ? null : { ...(usage as NonNullable<WaveView["usage"]>), cost: cents((usage as NonNullable<WaveView["usage"]>).cost) };
  return { view: { ...fold, reviews, running, interrupted, tasks, counts: waveCounts(full, states), usage: total, actions }, stuck };
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
  const files = (await listWaves()).filter((file) => file.declaration.origin === origin && !skip.waves?.has(file.declaration.id));
  const tasks = await Promise.all(records.map((record) => taskView(record)));
  const waves = await Promise.all(files.map(async (file) => ({ ...(await waveLook(file)), events: file.events })));
  return { tasks, waves };
}

/**
 * The scheduler: starts every pending task of the wave whose `after` tasks are all `done`, through `launchTask` with
 * the wave's branch as target, its tag, plan and id, and records a `task` event for each. Only the wave's runner calls
 * it, holding the runner's lock: no task starts twice. A record of this wave no `task` event names (a runner died
 * between the launch and its event) is adopted for the first pending task of its title instead of a second launch.
 * Nothing starts unless the wave is `building`. Resolves with the started keys; a launch that fails throws (`refused`
 * or `failed`) after the tasks started before it are recorded. `signal` (the runner stops): no further launch, the
 * running one is undone (`launchTask`), and it resolves with the keys started before.
 */
export async function startWaveTasks(id: string, env?: RunnerEnv, signal?: AbortSignal): Promise<string[]> {
  const { declaration, events } = await readWave(id);
  const fold = foldWave(declaration, events);
  if (fold.stage !== "building") return [];
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
  const overrides: StoredSettings = { models, maxRounds, review, merge: "auto", branch: declaration.branch };
  const named = new Set(fold.tasks.map((task) => task.taskId));
  const orphans = (await listTasks()).filter((record) => record.wave === id && !named.has(record.id));
  const started: string[] = [];
  for (const key of startableKeys(fold, states)) {
    if (signal?.aborted) break;
    const task = fold.tasks.find((candidate) => candidate.key === key);
    if (task === undefined) continue;
    const orphan = orphans.findIndex((record) => record.title === task.title);
    let record: TaskRecord;
    if (orphan >= 0) {
      [record] = orphans.splice(orphan, 1);
    } else {
      try {
        // The task's size picks its coder's model of the wave's; the reviewer's stays the wave's.
        record = await launchTask({ repo: declaration.repo, title: task.title, request: task.request, overrides, size: task.model, tag: declaration.tag, plan: declaration.plan, wave: id, origin: declaration.origin, env, signal });
      } catch (error) {
        if (signal?.aborted) break;
        const why = `starting its task ${key} failed: ${oneLine(errorText(error))}`;
        throw new FactoryError(error instanceof LaunchRefusedError ? "refused" : "failed", why);
      }
    }
    await appendWaveEvent(id, { kind: "task", key, taskId: record.id, sessionId: record.sessionId });
    started.push(key);
  }
  return started;
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
        const tasks = validateTaskSpecs(params.tasks, fold.tasks);
        // The supervisor acts on a wave whose pending tasks can never start: they leave it (count as cancelled).
        const dropped = unreachableKeys(fold, states);
        const events: NewWaveEvent[] = [{ kind: "tasks", tasks, ...(dropped.length > 0 ? { dropped } : {}) }];
        if (fold.stage !== "building") events.push({ kind: "stage", stage: "building", reason: null });
        return events;
      }),
    );
    await pokeWaveRunner(id, env);
    return { wave: await waveView(await readWave(id)) };
  },

  "waves.get": async (params) => ({ wave: await waveView(await findWave(params.id)) }),

  "waves.list": async (params, { cwd }) => {
    const tag = tagParam("waves.list", params.tag);
    const repo = params.repo === undefined ? undefined : await primaryOf(params.repo as string, cwd);
    const files = (await listWaves(repo)).filter((file) => tag === undefined || tagInGroup(file.declaration.tag, tag));
    return { waves: await Promise.all(files.map(waveView)) };
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
      const unfinished = view.tasks.some((task) => task.state !== "done" && task.state !== "cancelled");
      await moveWave(id, "blocked", unfinished ? "building" : "reviewing", "retry needs blocked or interrupted");
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
    if (failures.length > 0) throw new FactoryError("failed", `wave ${id.slice(0, SHORT_ID_CHARS)} is cancelled, but cancelling its tasks failed (${failures.join("; ")}); cancel them with tasks.cancel`);
    return { wave: await waveView(await readWave(id)) };
  },

  "waves.remove": async (params) => {
    const { declaration } = await findWave(params.id);
    const { id, repo, branch } = declaration;
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
      const { stage } = foldWave(file.declaration, file.events);
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
      if (stage === "merged" && (await localBranchExists(repo, branch))) {
        const deleted = await runCommand(["git", "branch", "-D", branch], { cwd: repo });
        if (deleted.exitCode !== 0) throw new FactoryError("failed", `wave ${short}: deleting its branch ${branch} failed: ${oneLine(deleted.output)}`);
      }
      await removeWave(id);
      return { removed: id };
    } finally {
      await unlockWave(id).catch(() => undefined);
    }
  },
} satisfies Partial<Record<ActionName, Handler>>;

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
  await runCommand(["git", "branch", "-D", declaration.branch], { cwd: declaration.repo });
}
