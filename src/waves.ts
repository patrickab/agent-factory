/**
 * A wave's record on disk and the fold from its events to its state. Pure: nothing here starts a process.
 * - One append-only log per wave, `wave.jsonl` in its home (`waveHome`), read through the link `wavesDir()/<id>`
 *   (`wavePath`): line 1 the declaration, every later line one event. The state is only ever `foldWave` of the events
 *   plus the tasks' states. (`<id>.log` beside the link is the runner's output, not this log.)
 * - Invariant 8, a wave never waits silently: a `stage` event may carry `detail`, one sentence on why
 * - Every append holds `<id>.log.lock` from the read to the write: appends never interleave, and `appendWaveEvents` is a
 *   compare-and-append. A line cut short by a crash is skipped when read; the next append starts a line of its own
 */
import { mkdir, open, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MODEL_SIZES, type ModelSize, type StoredSettings } from "./settings.ts";
import { isFactoryTurn, isFinal, isResting, type Finding, type MinorFinding, type State } from "./state.ts";
import { withLock } from "./lock.ts";
import { errorText, FactoryError, ifMissing, isRecord, jsonLines, type Usage } from "./util.ts";
import { isWaveId, waveDir, waveHome, waveLockPath, waveLogLockPath, waveLogPath, wavePath, wavePokePath, wavesDir } from "./wave-poke.ts";
import type { FeedbackEntry } from "./feedback.ts";

/** How long an append waits for the log lock before the wave counts as busy. */
const LOG_LOCK_WAIT_MS = 10_000;

export type WaveStage = "queued" | "building" | "reviewing" | "rejected" | "merging" | "waiting_approve" | "merged" | "blocked" | "cancelled";
export type WaveReason = "conflict" | "gates" | "dirty" | "infra" | "review_failed";

/**
 * `key` unique in the wave, `[A-Za-z0-9._-]+`; `after` = keys of the same wave; `model`: which of the wave's two models
 * this task's coder runs with, absent: `big`. Resolved against the wave's stored settings when the task starts.
 */
export type WaveTaskSpec = { key: string; title: string; request: string; after?: string[]; model?: ModelSize };

/**
 * A task spec as the `tasks` event stores it; without `model` the task runs with the `big` model. `id`: the task's id,
 * given when it is declared and taken by its launch.
 */
export type WaveTaskEntry = { key: string; title: string; request: string; after: string[]; model?: ModelSize; id: string };

/**
 * One row per stage: `rests`: no runner drives it (`queued` too: a merge of a wave it waits for pokes it,
 * `queuedWaves`); `final`: nothing leaves it; `attention`: it waits for the supervisor (`interrupted` and stuck too:
 * `WaveView.attention`); `closed`: it takes no more tasks (`merging` too: its rebased branch is in the merge queue);
 * `keepsReview`: entering it does not begin the review.
 */
const WAVE_STAGES: Record<WaveStage, { rests: boolean; final?: true; attention?: true; closed?: true; keepsReview?: true }> = {
  queued: { rests: true, keepsReview: true },
  building: { rests: false, keepsReview: true },
  reviewing: { rests: false },
  rejected: { rests: true, attention: true },
  merging: { rests: false, closed: true },
  waiting_approve: { rests: true, attention: true },
  merged: { rests: true, final: true, closed: true },
  blocked: { rests: true, attention: true, keepsReview: true },
  cancelled: { rests: true, final: true, closed: true, keepsReview: true },
};
export const waveRests = (stage: WaveStage): boolean => WAVE_STAGES[stage].rests;
export const waveFinal = (stage: WaveStage): boolean => WAVE_STAGES[stage].final === true;
export const waveAttention = (stage: WaveStage): boolean => WAVE_STAGES[stage].attention === true;
export const waveClosed = (stage: WaveStage): boolean => WAVE_STAGES[stage].closed === true;

/**
 * The settings `waves.start` got, stored with the wave. Its tasks start with `models`, `maxRounds` and `review` from
 * them, `branch` = the wave's branch and `merge: "auto"`; `merge` is the wave's own (`review`: wait for approve), so is
 * `squash` (the wave lands as one commit, `merge.ts`; absent = off, stored only when on).
 */
export type WaveOverrides = Pick<StoredSettings, "models" | "maxRounds" | "merge" | "review" | "squash">;

/**
 * Line 1 of a wave's file. `base`: the commit the wave branched from; `origin`: the declaring Pi session's id. `after`:
 * the ids of the waves it waits for (absent: none); such a wave is declared `queued`, its branch cut at the target's
 * tip: its `start` event moves it to the target's tip then, its new `base`.
 */
export interface WaveDeclaration {
  id: string;
  repo: string;
  tag: string;
  plan: string | null;
  title: string;
  /** The reviewer's instructions. */
  request: string;
  branch: string;
  target: string;
  base: string;
  after?: string[];
  /** The contracts (memory-store, the store is `plan`) its tasks work by (absent: none). */
  contracts?: string[];
  origin: string | null;
  createdAt: string;
  /** Stored only: not part of a `WaveView`. */
  overrides: WaveOverrides;
}

export type WaveReview = {
  round: number;
  at: string;
  sessionId: string | null;
  model: string | null;
  verdict: "approved" | "rejected" | "failed";
  status: string;
  findings: Finding[];
  usage: Usage;
  wallMs: number;
};
/**
 * One review of a task of a wave (`review-each.ts`): `key`/`taskId` the task, `round` the task's round
 * judged, `tree` the worktree's tree it judged on `base` (the next review's diff starts there while the base stays),
 * `contracts` the hash of the contracts' text in its prompt (null: none).
 */
export type WaveTaskReview = WaveReview & { key: string; taskId: string; tree: string; base: string; contracts: string | null };
/** `flaky`: the failing test names (else the commands) of the steps that failed and then passed on their rerun; absent when none. */
export type WaveGate = { at: string; phase: "review" | "merge"; passed: boolean; wallMs: number; log: string | null; flaky?: string[] };
/**
 * The commit range that reached the target. A `squash` wave's (one commit, `to`) also names `ref`, the ref that keeps
 * its task commits, and `commits`, how many; absent otherwise.
 */
export type WaveMerge = { at: string; from: string; to: string; ref?: string; commits?: number };
/**
 * A rebase onto the target that conflicted (`wave-runner.ts`): the wave builds again with the task `key`,
 * whose worktree holds the wave's branch `head` merged onto the target's tip `onto` with the markers left
 * (`core-waves.ts`). `files`: the conflicting paths.
 */
export type WaveConflict = { at: string; phase: "review" | "merge"; key: string; head: string; onto: string; files: string[] };

/** One line after the declaration. */
export type WaveEvent =
  /** `by: "reviewer"`: added by the wave's reviewer (`start_fix`), counted against `REVIEWER_FIX_CAP`; absent otherwise. */
  | { at: string; kind: "tasks"; tasks: WaveTaskEntry[]; dropped?: string[]; by?: "reviewer" }
  | { at: string; kind: "task"; key: string; taskId: string; sessionId: string }
  | { at: string; kind: "stage"; stage: WaveStage; reason: WaveReason | null; detail?: string }
  /** A queued wave starts: its branch is on the target's tip `base`, it builds. */
  | { at: string; kind: "start"; base: string }
  | ({ kind: "gate"; commit?: string } & WaveGate)
  | ({ kind: "review" } & WaveReview)
  | ({ kind: "task_review" } & WaveTaskReview)
  | ({ kind: "merge" } & WaveMerge)
  /** `contracts.apply` changed the contract `name` (its facts `paths`); `done`: the wave's done tasks, reported to the supervisor. */
  | { at: string; kind: "contract"; name: string; paths: string[]; done: string[] }
  /**
   * `tasks.update` (with `key`, a pending task) or `waves.update` (without): the fields given replace the task's spec or
   * the wave's title and request.
   */
  | { at: string; kind: "update"; key?: string; title?: string; request?: string; after?: string[]; model?: ModelSize }
  /** The runner launches the pending task `key` with its spec as folded now; its `task` event follows (or a `stage` event). */
  | { at: string; kind: "launch"; key: string }
  | ({ kind: "conflict" } & WaveConflict)
  /** The wave's reviewer told the supervisor `text` (`notify_supervisor`), while reviewing the task `taskId` (null: none). */
  | { at: string; kind: "note"; text: string; taskId: string | null };

/** One `update` event as `waves.get` shows it: the task's `key` (null: the wave's own) and the fields it changed. */
export type WaveUpdate = { at: string; key: string | null; fields: string[] };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An event to append; `at` defaults to now. */
export type NewWaveEvent = DistributiveOmit<WaveEvent, "at"> & { at?: string };

export interface WaveFile {
  declaration: WaveDeclaration;
  events: WaveEvent[];
}

/**
 * A wave's task as the log knows it: null ids until the `task` event that started it. `dropped`: never started, and a
 * later `tasks` event dropped it (it could never start); it counts as cancelled.
 */
export type FoldedTask = {
  key: string;
  title: string;
  request: string;
  after: string[];
  /** Which of the wave's models this task's coder runs with (absent in the log: `big`). */
  model: ModelSize;
  taskId: string | null;
  sessionId: string | null;
  /** The id declared with its spec: the started task's id too. */
  id: string;
  dropped?: boolean;
  /** The runner launches it (a `launch` event), its `task` event has not come yet. */
  launching?: boolean;
};

/** Everything of a `WaveView` that needs no task state, and the last stage event's `detail`. */
export interface WaveFold extends WaveDeclaration {
  /** The waves it waits for, `[]` when none. */
  after: string[];
  /** Declared without `after`, or its `start` event came. */
  started: boolean;
  stage: WaveStage;
  /** Only when `stage` is `blocked`. */
  reason: WaveReason | null;
  /** Why the wave is at its stage, when the last `stage` event says (invariant 8); null otherwise. */
  detail: string | null;
  tasks: FoldedTask[];
  reviews: WaveReview[];
  gates: WaveGate[];
  merge: WaveMerge | null;
  /** The `update` events, oldest first. */
  updates: WaveUpdate[];
  /** The `conflict` events, oldest first. */
  conflicts: WaveConflict[];
  /** The `task_review` events, oldest first. */
  taskReviews: WaveTaskReview[];
  /** How many tasks the wave's reviewer added (`start_fix`). */
  fixes: number;
  /**
   * Whether the wave's review began since it last built (invariant 2): from then on nothing may reach its branch until
   * `waves.add` makes it build again. A wave blocked or cancelled while it built (a launch failed) has not begun one,
   * so the merges of its tasks still running land.
   */
  reviewBegan: boolean;
  /**
   * The commit the wave's `merge_gates` last passed on before its review (the last passed `review` gate), null when
   * none: its merge runs them again only on another commit (the target moved since).
   */
  gatedCommit: string | null;
}

/** A wave as every client sees it (the contract's shape); the core builds it from the fold and the tasks. */
export interface WaveView extends Omit<WaveDeclaration, "overrides" | "after" | "base" | "contracts"> {
  /** The ids of the waves it waits for (`queued` until every one is `merged`), `[]` when none. */
  after: string[];
  stage: WaveStage;
  reason: WaveReason | null;
  /** Why the wave is at its stage, when its last `stage` event says (`WaveFold.detail`); null otherwise. Added in factory/w2. */
  detail: string | null;
  running: boolean;
  interrupted: boolean;
  /**
   * It builds with tasks that can never start while nothing else moves it (`stuckKeys`), or it is queued after a wave
   * that was cancelled or removed (`queueLook`). A stuck wave rests (its runner does too); it is not interrupted.
   */
  stuck: boolean;
  /** It waits for the supervisor: interrupted, stuck, or in one of `waveAttention`, whatever `running` says. */
  attention: boolean;
  /** Its runner waits for a test slot (`test-slots.ts`) to run a merge gate; absent otherwise. */
  waitingForSlot?: true;
  /** `id`: the task's id, a pending one's too (declared with it). */
  tasks: { key: string; title: string; after: string[]; model: ModelSize; taskId: string | null; sessionId: string | null; state: State | "pending"; usage: Usage | null; id: string }[];
  counts: { total: number; done: number };
  reviews: WaveReview[];
  /**
   * The minor findings of its tasks' reviews (`task`: the task's key), then of its own reviews, oldest first: stored,
   * they never reject.
   */
  minors: MinorFinding[];
  gates: WaveGate[];
  merge: WaveMerge | null;
  /** What `tasks.update` and `waves.update` changed, oldest first. */
  updates: WaveUpdate[];
  usage: Usage | null;
  actions: string[];
  /** What the agents reported (`feedback.ts`), oldest first; only `waves.get` reads the store. */
  feedback?: FeedbackEntry[];
}

const TASK_KEY = /^[A-Za-z0-9._-]+$/;

// ---- the file ----

/** Makes a new wave's home with its log holding its declaration, then links it from `wavesDir()`. Throws when the wave exists. */
export async function createWave(declaration: WaveDeclaration): Promise<void> {
  if (!isWaveId(declaration.id)) throw new Error(`${declaration.id} is not a wave id`);
  const home = waveHome(declaration);
  await mkdir(home, { recursive: true });
  // Written in full before the link: no reader sees a half-written log; `wx` and the link fail on an existing wave.
  await writeFile(join(home, "wave.jsonl"), `${JSON.stringify(declaration)}\n`, { encoding: "utf8", flag: "wx" });
  await mkdir(wavesDir(), { recursive: true });
  await symlink(home, waveDir(declaration.id));
}

/** Appends one event to an existing wave under its log lock. Returns the event as written. */
export async function appendWaveEvent(id: string, event: NewWaveEvent): Promise<WaveEvent> {
  const [written] = (await appendWaveEvents(id, [event])) ?? [];
  return written;
}

/**
 * Appends events to an existing wave in one write, under its log lock. `events` may be a function of the wave's fold
 * read under that lock (a compare-and-append): it returns the events, or null to append nothing; it may throw. Returns
 * the events as written, null when the function returned null.
 */
export async function appendWaveEvents(id: string, events: NewWaveEvent[] | ((fold: WaveFold) => NewWaveEvent[] | null | Promise<NewWaveEvent[] | null>)): Promise<WaveEvent[] | null> {
  if (!isWaveId(id)) throw new FactoryError("not_found", `${id} is not a wave id`);
  return withLock(waveLogLockPath(id), `wave ${id.slice(0, 8)} is busy: another process writes its log, try again`, LOG_LOCK_WAIT_MS, async () => {
    let chosen: NewWaveEvent[] | null;
    if (typeof events === "function") {
      const file = await readWave(id);
      chosen = await events(foldWave(file.declaration, file.events));
      if (chosen === null) return null;
    } else {
      chosen = events;
    }
    const at = new Date().toISOString();
    const written = chosen.map((event) => ({ ...event, at: event.at ?? at }) as WaveEvent);
    const handle = await ifMissing(open(wavePath(id), "r+"), null);
    if (handle === null) throw new FactoryError("not_found", `no wave ${id}`);
    try {
      const { size } = await handle.stat();
      const last = Buffer.alloc(1);
      if (size > 0) await handle.read(last, 0, 1, size - 1);
      // After a torn append the new events start on a line of their own; the torn line is skipped on read.
      const prefix = size > 0 && last[0] !== 0x0a ? "\n" : "";
      await handle.write(`${prefix}${written.map((event) => `${JSON.stringify(event)}\n`).join("")}`, size);
    } finally {
      await handle.close();
    }
    return written;
  });
}

/** The wave's file. A missing wave is a `not_found` `FactoryError`; an invalid file an `Error` naming it. */
export async function readWave(id: string): Promise<WaveFile> {
  const path = wavePath(id);
  if (!isWaveId(id)) throw new FactoryError("not_found", `${id} is not a wave id`);
  const text = await ifMissing(readFile(path, "utf8"), null);
  if (text === null) throw new FactoryError("not_found", `no wave ${id}`);
  // Line 1 the declaration, then the events; a torn append is skipped, a corrupt declaration is not.
  const newline = text.indexOf("\n");
  let declaration: WaveDeclaration;
  try {
    declaration = JSON.parse(newline === -1 ? text : text.slice(0, newline));
  } catch (error) {
    throw new Error(`${path}: the declaration is no JSON (${errorText(error)})`);
  }
  return { declaration, events: jsonLines<WaveEvent>(newline === -1 ? "" : text.slice(newline + 1)) };
}

/** Every wave, oldest first; only those of `repo` when given. Entries that are no valid wave (a home deleted by hand) are skipped. */
export async function listWaves(repo?: string): Promise<WaveFile[]> {
  const waves: WaveFile[] = [];
  for (const name of await ifMissing(readdir(wavesDir()), [])) {
    if (!isWaveId(name)) continue;
    const wave = await readWave(name).catch(() => undefined);
    if (wave !== undefined && (repo === undefined || wave.declaration.repo === repo)) waves.push(wave);
  }
  return waves.sort((a, b) => a.declaration.createdAt.localeCompare(b.declaration.createdAt));
}

/** Removes the wave's link, its runner log, its locks and its poke marker. Its home, tasks and branch stay. */
export async function removeWave(id: string): Promise<void> {
  if (!isWaveId(id)) return;
  for (const path of [waveDir(id), waveLogPath(id), waveLockPath(id), waveLogLockPath(id), wavePokePath(id)]) await rm(path, { recursive: true, force: true });
}

// ---- the fold ----

/** Stages that keep what came before them: a wave blocked or cancelled is as far as it was when that happened. */

/** The wave's state from its declaration and events: a declared wave is `building`, `queued` with `after`. */
export function foldWave(declaration: WaveDeclaration, events: readonly WaveEvent[]): WaveFold {
  const after = declaration.after ?? [];
  const stage: WaveStage = after.length > 0 ? "queued" : "building";
  const fold: WaveFold = { ...declaration, after: [...after], started: after.length === 0, stage, reason: null, detail: null, tasks: [], reviews: [], gates: [], merge: null, updates: [], conflicts: [], taskReviews: [], fixes: 0, reviewBegan: false, gatedCommit: null };
  for (const event of events) {
    switch (event.kind) {
      case "tasks":
        for (const key of event.dropped ?? []) {
          const task = fold.tasks.find((candidate) => candidate.key === key);
          if (task !== undefined && task.taskId === null) task.dropped = true;
        }
        for (const spec of event.tasks) {
          // Validation keeps keys unique; a repeated key in a hand-edited log keeps its first declaration.
          if (fold.tasks.some((task) => task.key === spec.key)) continue;
          fold.tasks.push({ key: spec.key, title: spec.title, request: spec.request, after: [...spec.after], model: spec.model ?? "big", taskId: null, sessionId: null, id: spec.id });
        }
        if (event.by === "reviewer") fold.fixes += event.tasks.length;
        break;
      case "task": {
        const task = fold.tasks.find((candidate) => candidate.key === event.key);
        if (task) {
          task.taskId = event.taskId;
          task.sessionId = event.sessionId;
          delete task.launching;
        }
        break;
      }
      case "launch": {
        const task = fold.tasks.find((candidate) => candidate.key === event.key);
        if (task !== undefined && task.taskId === null) task.launching = true;
        break;
      }
      case "update":
        foldUpdate(fold, event);
        break;
      case "stage":
        fold.stage = event.stage;
        fold.reason = event.stage === "blocked" ? event.reason : null;
        fold.detail = event.detail ?? null;
        if (event.stage === "building") fold.reviewBegan = false;
        else if (!WAVE_STAGES[event.stage].keepsReview) fold.reviewBegan = true;
        // A launch the runner did not record ended with it (failed, stopped): the task is plainly pending again.
        for (const task of fold.tasks) delete task.launching;
        break;
      case "start":
        fold.started = true;
        fold.base = event.base;
        fold.stage = "building";
        fold.reason = null;
        fold.detail = null;
        break;
      case "gate": {
        const { kind: _kind, commit, ...gate } = event;
        fold.gates.push(gate);
        if (gate.phase === "review" && gate.passed && commit !== undefined) fold.gatedCommit = commit;
        break;
      }
      case "review": {
        const { kind: _kind, ...review } = event;
        fold.reviews.push({ ...review, findings: review.findings.map((finding) => ({ ...finding })) });
        break;
      }
      case "merge": {
        const { kind: _kind, ...merge } = event;
        fold.merge = merge;
        break;
      }
      case "contract":
      case "note":
        break;
      case "conflict": {
        const { kind: _kind, ...conflict } = event;
        fold.conflicts.push({ ...conflict, files: [...conflict.files] });
        break;
      }
      case "task_review": {
        const { kind: _kind, ...review } = event;
        fold.taskReviews.push({ ...review, findings: review.findings.map((finding) => ({ ...finding })) });
        break;
      }
      default:
        throw new Error(`kind ${JSON.stringify((event as { kind: unknown }).kind)} is no wave event`);
    }
  }
  return fold;
}

/** Applies an `update` event: to the task `key`, else to the wave. */
function foldUpdate(fold: WaveFold, event: Extract<WaveEvent, { kind: "update" }>): void {
  const fields: string[] = [];
  if (event.key === undefined) {
    if (event.title !== undefined) fields.push("title");
    if (event.request !== undefined) fields.push("request");
    fold.title = event.title ?? fold.title;
    fold.request = event.request ?? fold.request;
  } else {
    const task = fold.tasks.find((candidate) => candidate.key === event.key);
    if (task === undefined) return;
    if (event.title !== undefined) {
      task.title = event.title;
      fields.push("title");
    }
    if (event.request !== undefined) {
      task.request = event.request;
      fields.push("request");
    }
    if (event.after !== undefined) {
      task.after = [...event.after];
      fields.push("after");
    }
    if (event.model !== undefined) {
      task.model = event.model;
      fields.push("model");
    }
  }
  fold.updates.push({ at: event.at, key: event.key ?? null, fields });
}

// ---- scheduling ----

/** Task states by wave task key; a key missing or null means no state is known yet. */
export type TaskStates = ReadonlyMap<string, State | null>;

/** A wave task's state: `pending` before it started (`cancelled` when dropped), `running` once started but before its first state. */
export function waveTaskState(task: FoldedTask, states: TaskStates): State | "pending" {
  if (task.taskId === null) return task.dropped ? "cancelled" : "pending";
  return states.get(task.key) ?? "running";
}

/** The keys of tasks not yet started (nor dropped) whose `after` tasks are all `done`, in declaration order. */
export function startableKeys(fold: WaveFold, states: TaskStates): string[] {
  const byKey = new Map(fold.tasks.map((task) => [task.key, task]));
  const done = (key: string) => {
    const task = byKey.get(key);
    return task !== undefined && waveTaskState(task, states) === "done";
  };
  return fold.tasks.filter((task) => task.taskId === null && !task.dropped && task.after.every(done)).map((task) => task.key);
}

/**
 * The keys of tasks not yet started (nor dropped) that never can: an `after` task, directly or through others, is
 * `cancelled`.
 */
export function unreachableKeys(fold: WaveFold, states: TaskStates): string[] {
  const byKey = new Map(fold.tasks.map((task) => [task.key, task]));
  const memo = new Map<string, boolean>();
  const dead = (key: string): boolean => {
    const known = memo.get(key);
    if (known !== undefined) return known;
    memo.set(key, false); // a cycle (only in a hand-edited log) is no proof of anything
    const task = byKey.get(key);
    const state = task === undefined ? "cancelled" : waveTaskState(task, states);
    const result = state === "cancelled" || (state === "pending" && task !== undefined && task.after.some(dead));
    memo.set(key, result);
    return result;
  };
  return fold.tasks.filter((task) => task.taskId === null && !task.dropped && task.after.some(dead)).map((task) => task.key);
}

/**
 * The keys of the tasks that can never start while nothing else can move the wave: no task can start and no started
 * task is active (every one rests). Empty otherwise. A `building` wave with such keys waits for the supervisor
 * (`waves.cancel`, or `waves.add`, which drops them): it needs attention and its runner rests.
 */
export function stuckKeys(fold: WaveFold, states: TaskStates): string[] {
  const unreachable = unreachableKeys(fold, states);
  if (unreachable.length === 0 || startableKeys(fold, states).length > 0) return [];
  const active = fold.tasks.some((task) => {
    if (task.taskId === null) return false;
    const state = states.get(task.key) ?? null;
    return state === null || !isResting(state) || isFactoryTurn(state);
  });
  return active ? [] : unreachable;
}

/** Every task, started or pending, is `done` or `cancelled`, and at least one is `done`. */
export function readyForReview(fold: WaveFold, states: TaskStates): boolean {
  const all = fold.tasks.map((task) => waveTaskState(task, states));
  return all.every((state) => state !== "pending" && isFinal(state)) && all.includes("done");
}

/** The wave has tasks and every one of them is `cancelled`. */
export function allCancelled(fold: WaveFold, states: TaskStates): boolean {
  return fold.tasks.length > 0 && fold.tasks.every((task) => waveTaskState(task, states) === "cancelled");
}

/** `total`: tasks not cancelled; `done`: tasks done. */
export function waveCounts(fold: WaveFold, states: TaskStates): { total: number; done: number } {
  const all = fold.tasks.map((task) => waveTaskState(task, states));
  return { total: all.filter((state) => state !== "cancelled").length, done: all.filter((state) => state === "done").length };
}

// ---- validation ----

/**
 * Checks task specs a wave adds against the keys it has: an object each, unique key of `[A-Za-z0-9._-]+`, non-empty
 * title and request, `after` naming keys of the wave (existing or added), no cycle, `model` `"small"` or `"big"` when
 * given (never a concrete model: the wave's settings name those). Gives each a new task id. Throws a `FactoryError` `invalid`.
 */
export function validateTaskSpecs(raw: unknown, existing: readonly { key: string; after?: readonly string[] }[] = []): WaveTaskEntry[] {
  const invalid = (message: string) => new FactoryError("invalid", message);
  if (!Array.isArray(raw) || raw.length === 0) throw invalid("tasks must be a non-empty array of {key, title, request, after?, model?}");
  const keys = new Set(existing.map((task) => task.key));
  const specs: WaveTaskEntry[] = [];
  for (const [index, item] of raw.entries()) {
    if (!isRecord(item)) throw invalid(`tasks[${index}] must be an object`);
    const { key, title, request, after = [], model = null } = item;
    if (typeof key !== "string" || !TASK_KEY.test(key)) throw invalid(`tasks[${index}].key must be a string of A-Z a-z 0-9 . _ -`);
    if (keys.has(key)) throw invalid(`task key ${key} is not unique in the wave`);
    if (typeof title !== "string" || title.trim() === "") throw invalid(`tasks[${index}].title must be a non-empty string`);
    if (typeof request !== "string" || request.trim() === "") throw invalid(`tasks[${index}].request must be a non-empty string`);
    if (!Array.isArray(after) || !after.every((name) => typeof name === "string")) throw invalid(`tasks[${index}].after must be an array of keys`);
    if (model !== null && !MODEL_SIZES.includes(model as ModelSize)) {
      throw invalid(`tasks[${index}].model must be "small" or "big" (the wave's settings name the models), not ${JSON.stringify(model)}`);
    }
    keys.add(key);
    specs.push({ key, title, request, after: [...new Set(after as string[])], ...(model === null ? {} : { model: model as ModelSize }), id: crypto.randomUUID() });
  }
  checkTaskGraph([...specs, ...existing]);
  return specs;
}

/**
 * Checks that the wave's tasks wait only for other tasks of the wave and not in a cycle; a cycle is named from the
 * first of `tasks` in it. Throws a `FactoryError` `invalid`.
 */
export function checkTaskGraph(tasks: readonly { key: string; after?: readonly string[] }[]): void {
  const invalid = (message: string) => new FactoryError("invalid", message);
  const graph = new Map(tasks.map((task) => [task.key, task.after ?? []]));
  const finished = new Set<string>();
  const visit = (key: string, path: string[]): void => {
    if (finished.has(key)) return;
    if (path.includes(key)) throw invalid(`tasks wait for each other in a cycle: ${[...path.slice(path.indexOf(key)), key].join(" -> ")}`);
    for (const name of graph.get(key) ?? []) {
      if (name === key) throw invalid(`task ${key} waits for itself`);
      if (!graph.has(name)) throw invalid(`task ${key} waits for ${name}, no task of the wave`);
      visit(name, [...path, key]);
    }
    finished.add(key);
  };
  for (const key of graph.keys()) visit(key, []);
}
