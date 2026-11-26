/**
 * A wave's record on disk and the fold from its events to its state. Pure: nothing here starts a process.
 *
 * - One file per wave, `<factoryHome>/waves/<id>.jsonl`, append-only: line 1 is the declaration (`createWave`), every
 *   later line one event (`appendWaveEvent`, `appendWaveEvents`). Its other files lie next to it (`wave-poke.ts`)
 * - The wave's state is only ever `foldWave` of its events plus its tasks' states: the scheduling helpers
 *   (`startableKeys`, `readyForReview`, `allCancelled`, `waveCounts`, `stuckKeys`) take the fold and a map key -> task
 *   state
 * - Invariant 8, a wave never waits silently: a `stage` event may carry `detail`, one sentence on why (a block's cause,
 *   the tasks that can never start). A `tasks` event may carry `dropped`: pending keys that could never start when the
 *   supervisor added tasks, which count as cancelled from then on
 * - Every append holds the log lock (`waveLogLockPath`) from the read of the log to its write: appends never interleave,
 *   and `appendWaveEvents` checks the fold under it (a compare-and-append: the runner's stage change loses against a
 *   `waves.add` that came first). A line cut short by a crash is skipped when read, and the next append starts on a
 *   line of its own
 * - `listWaves` skips files that are no valid wave, as `listTasks` does; `validateTaskSpecs` checks specs a wave adds
 */
import { link, mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { FactoryError } from "./core.ts";
import { MODEL_SIZES, normalizeModels, parseSettingsFields, RESTING_STATES, type ModelChoice, type ModelSize, type Settings, type State } from "./state.ts";
import { lockFile, TaskBusyError, unlockFile } from "./tasks.ts";
import { errorText, isRecord } from "./util.ts";
import { isWaveId, waveLockPath, waveLogLockPath, waveLogPath, wavePath, wavePokePath, waveReviewsDir, wavesDir } from "./wave-poke.ts";
import type { FeedbackEntry } from "./feedback.ts";

export { isWaveId, waveLockPath, waveLogLockPath, waveLogPath, wavePath, wavePokePath, waveReviewsDir, wavesDir };

/** How long an append waits for the log lock before the wave counts as busy. */
const LOG_LOCK_WAIT_MS = 10_000;

export type WaveStage = "queued" | "building" | "reviewing" | "rejected" | "merging" | "waiting_approve" | "merged" | "blocked" | "cancelled";
export type WaveReason = "conflict" | "gates" | "dirty" | "infra" | "review_failed";
export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };

/**
 * `key` unique in the wave, `[A-Za-z0-9._-]+`; `after` = keys of the same wave; `model`: which of the wave's two models
 * this task's coder runs with, absent: `big`. Resolved against the wave's stored settings when the task starts.
 */
export type WaveTaskSpec = { key: string; title: string; request: string; after?: string[]; model?: ModelSize };

/**
 * A task spec as the `tasks` event stores it; without `model` (old logs too) the task runs with the `big` model. `id`:
 * the task's id, given when it is declared and taken by its launch; absent in logs written before, then the launch makes one.
 */
export type WaveTaskEntry = { key: string; title: string; request: string; after: string[]; model?: ModelSize; id?: string };

export const WAVE_STAGES: readonly WaveStage[] = ["queued", "building", "reviewing", "rejected", "merging", "waiting_approve", "merged", "blocked", "cancelled"];
/** `queued` too: no runner drives a wave that waits for others, a merge of one of them pokes it (`queuedWaves`). */
export const RESTING_WAVE_STAGES: readonly WaveStage[] = ["queued", "rejected", "waiting_approve", "merged", "blocked", "cancelled"];
const WAVE_REASONS: readonly WaveReason[] = ["conflict", "gates", "dirty", "infra", "review_failed"];

/**
 * The settings `waves.start` got, stored with the wave. Its tasks start with `models`, `maxRounds` and `review` from
 * them, `branch` = the wave's branch and `merge: "auto"`; `merge` is the wave's own (`review`: wait for approve), so is
 * `remote` (the wave is shown on the origin's forge, `remote.ts`; absent = off).
 */
export type WaveOverrides = { models?: ModelChoice; maxRounds?: number; merge?: Settings["merge"]; review?: boolean; remote?: boolean };

/**
 * Line 1 of a wave's file. `base`: the commit the wave branched from; `origin`: the declaring Pi session's id. `after`:
 * the ids of the waves it waits for (absent: none); such a wave is declared `queued`, without `branch` and `base`
 * (null): its `start` event sets both.
 */
export interface WaveDeclaration {
  id: string;
  repo: string;
  tag: string;
  plan: string | null;
  title: string;
  /** The reviewer's instructions. */
  request: string;
  branch: string | null;
  target: string;
  base: string | null;
  after?: string[];
  /** The contracts (memory-store, the store is `plan`) its tasks work by (absent: none). */
  contracts?: string[];
  origin: string | null;
  createdAt: string;
  /** Stored only: not part of a `WaveView`. A file without it reads as `{}`. */
  overrides: WaveOverrides;
}

export type WaveFinding = { severity: "blocker" | "major" | "minor"; file: string; line: number | null; text: string };
export type WaveReview = {
  round: number;
  at: string;
  sessionId: string | null;
  model: string | null;
  verdict: "approved" | "rejected" | "failed";
  status: string;
  findings: WaveFinding[];
  usage: Usage | null;
  wallMs: number;
};
/** `flaky`: the failing test names (else the commands) of the steps that failed and then passed on their rerun; absent when none. */
export type WaveGate = { at: string; phase: "review" | "merge"; passed: boolean; wallMs: number; log: string | null; flaky?: string[] };
/** The commit range that reached the target. */
export type WaveMerge = { at: string; from: string; to: string; queueMs: number };
export type WaveRemote = { number: number | null; url: string | null; pushed: string | null; error: string | null };

/** One line after the declaration. A `remote` event sets only the fields it carries. */
export type WaveEvent =
  | { at: string; kind: "tasks"; tasks: WaveTaskEntry[]; dropped?: string[] }
  | { at: string; kind: "task"; key: string; taskId: string; sessionId: string }
  | { at: string; kind: "stage"; stage: WaveStage; reason: WaveReason | null; detail?: string }
  /** A queued wave starts: its branch is cut at `base` (after this event), it builds. */
  | { at: string; kind: "start"; branch: string; base: string }
  | ({ kind: "gate"; commit?: string } & WaveGate)
  | ({ kind: "review" } & WaveReview)
  | ({ kind: "merge" } & WaveMerge)
  | ({ at: string; kind: "remote" } & Partial<WaveRemote>)
  /** `contracts.apply` changed the contract `name` (its facts `paths`); `done`: the wave's done tasks, reported to the supervisor. */
  | { at: string; kind: "contract"; name: string; paths: string[]; done: string[] }
  /**
   * `tasks.update` (with `key`) or `waves.update` (without): the fields given replace the task's spec or the wave's
   * title and request. A started task's `after` and `model` stay what it started with.
   */
  | { at: string; kind: "update"; key?: string; title?: string; request?: string; after?: string[]; model?: ModelSize }
  /** The runner launches the pending task `key` with its spec as folded now; its `task` event follows (or a `stage` event). */
  | { at: string; kind: "launch"; key: string };

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
  /** The id declared with its spec (absent in old logs): the started task's id too. */
  id?: string;
  dropped?: boolean;
  /** The runner launches it (a `launch` event), its `task` event has not come yet. */
  launching?: boolean;
};

/** Everything of a `WaveView` that needs no task state, and the last stage event's `detail`. */
export interface WaveFold extends WaveDeclaration {
  /** The waves it waits for, `[]` when none. */
  after: string[];
  stage: WaveStage;
  /** Only when `stage` is `blocked`. */
  reason: WaveReason | null;
  /** Why the wave is at its stage, when the last `stage` event says (invariant 8); null otherwise. */
  detail: string | null;
  tasks: FoldedTask[];
  reviews: WaveReview[];
  gates: WaveGate[];
  merge: WaveMerge | null;
  remote: WaveRemote | null;
  /** The `update` events, oldest first; absent when none (a log without them folds as before). */
  updates?: WaveUpdate[];
}

/** A wave that has its branch: declared without `after`, or started (`start` event). */
export type StartedWaveFold = WaveFold & { branch: string; base: string };

/** Whether the wave has its branch (a queued wave gets it when it starts). */
export function waveStarted(fold: WaveFold): fold is StartedWaveFold {
  return fold.branch !== null && fold.base !== null;
}

/** A wave as every client sees it (the contract's shape); the core builds it from the fold and the tasks. */
export interface WaveView extends Omit<WaveDeclaration, "overrides" | "after"> {
  /** The ids of the waves it waits for (`queued` until every one is `merged`), `[]` when none. */
  after: string[];
  stage: WaveStage;
  reason: WaveReason | null;
  /** Why the wave is at its stage, when its last `stage` event says (`WaveFold.detail`); null otherwise. Added in factory/w2. */
  detail: string | null;
  running: boolean;
  interrupted: boolean;
  /** `id`: the task's id, a pending one's too (declared with it); absent for a pending task of an old log. */
  tasks: { key: string; title: string; after: string[]; model: ModelSize; taskId: string | null; sessionId: string | null; state: string; usage: Usage | null; id?: string }[];
  counts: { total: number; done: number };
  reviews: WaveReview[];
  gates: WaveGate[];
  merge: WaveMerge | null;
  remote: WaveRemote | null;
  /** What `tasks.update` and `waves.update` changed, oldest first; absent when nothing did. */
  updates?: WaveUpdate[];
  usage: Usage | null;
  /** The part of `usage.cost` the wave's and its tasks' scouts spent. Always set by the core. */
  scoutingCost?: number;
  actions: string[];
  /** What the agents reported (`feedback.ts`), oldest first; only `waves.get` reads the store. */
  feedback?: FeedbackEntry[];
}

const TASK_KEY = /^[A-Za-z0-9._-]+$/;

/** Takes the wave runner's lock for this process: a `TaskBusyError` while a live runner holds it. */
export async function lockWave(id: string): Promise<void> {
  await lockFile(waveLockPath(id), `wave ${id.slice(0, 8)} has a runner`);
}

/** Removes the wave runner's lock if this process holds it. */
export async function unlockWave(id: string): Promise<void> {
  await unlockFile(waveLockPath(id));
}

/** Runs `act` holding the wave's log lock, waiting up to `LOG_LOCK_WAIT_MS` for it; then a `TaskBusyError`. */
async function withLogLock<T>(id: string, act: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOG_LOCK_WAIT_MS;
  for (;;) {
    try {
      await lockFile(waveLogLockPath(id), `wave ${id.slice(0, 8)} is busy: another process writes its log, try again`);
      break;
    } catch (error) {
      if (!(error instanceof TaskBusyError) || Date.now() > deadline) throw error;
      await Bun.sleep(20);
    }
  }
  try {
    return await act();
  } finally {
    await unlockFile(waveLogLockPath(id));
  }
}

// ---- parsing ----

function str(raw: Record<string, unknown>, key: string, nonEmpty = true): string {
  const value = raw[key];
  if (typeof value !== "string" || (nonEmpty && value === "")) throw new Error(`${key} must be a ${nonEmpty ? "non-empty " : ""}string`);
  return value;
}

function strOrNull(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key] ?? null;
  if (value !== null && typeof value !== "string") throw new Error(`${key} must be a string or null`);
  return value;
}

function num(raw: Record<string, unknown>, key: string): number {
  const value = raw[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a number`);
  return value;
}

function oneOf<T extends string>(raw: Record<string, unknown>, key: string, values: readonly T[]): T {
  const value = raw[key];
  if (!values.includes(value as T)) throw new Error(`${key} must be one of ${values.join(", ")}`);
  return value as T;
}

function usageOf(raw: unknown): Usage | null {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw)) throw new Error("usage must be an object or null");
  // Old log entries predate the cache fields: absent reads as 0.
  const cache = (key: string) => (raw[key] === undefined ? 0 : num(raw, key));
  return { input: num(raw, "input"), output: num(raw, "output"), cacheRead: cache("cacheRead"), cacheWrite: cache("cacheWrite"), cost: num(raw, "cost") };
}

export function parseWaveOverrides(raw: unknown, prefix = "overrides."): WaveOverrides {
  if (raw === null || raw === undefined) return {};
  if (!isRecord(raw)) throw new Error(`${prefix.slice(0, -1)} must be an object`);
  const { branch: _branch, models, ...fields } = parseSettingsFields(raw, prefix);
  // Old declarations stored `{coder, reviewer}`: read as the contract's compatibility line says.
  const parsed: WaveOverrides = models === undefined ? fields : { ...fields, models: normalizeModels(models) };
  if (raw.remote === undefined) return parsed;
  if (typeof raw.remote !== "boolean") throw new Error(`${prefix}remote must be a boolean`);
  return { ...parsed, remote: raw.remote };
}

/** A string array, or undefined when absent. */
function strings(raw: Record<string, unknown>, key: string): string[] | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`${key} must be an array of strings`);
  return [...value];
}

export function parseWaveDeclaration(raw: unknown, id: string): WaveDeclaration {
  if (!isRecord(raw)) throw new Error("the declaration is not an object");
  const after = strings(raw, "after");
  const contracts = strings(raw, "contracts");
  const declaration: WaveDeclaration = {
    id: str(raw, "id"),
    repo: str(raw, "repo"),
    tag: str(raw, "tag"),
    plan: strOrNull(raw, "plan"),
    title: str(raw, "title"),
    request: str(raw, "request", false),
    // A queued wave has neither until its `start` event; every other declaration has both.
    branch: after === undefined ? str(raw, "branch") : strOrNull(raw, "branch"),
    target: str(raw, "target"),
    base: after === undefined ? str(raw, "base") : strOrNull(raw, "base"),
    ...(after === undefined ? {} : { after }),
    ...(contracts === undefined ? {} : { contracts }),
    origin: strOrNull(raw, "origin"),
    createdAt: str(raw, "createdAt"),
    overrides: parseWaveOverrides(raw.overrides),
  };
  if (declaration.id !== id) throw new Error(`id ${declaration.id} is not the file's name`);
  return declaration;
}

function parseSpec(raw: unknown): WaveTaskEntry {
  if (!isRecord(raw)) throw new Error("a task is not an object");
  const after = raw.after ?? [];
  if (!Array.isArray(after) || !after.every((key) => typeof key === "string")) throw new Error("after must be an array of keys");
  const model = strOrNull(raw, "model");
  if (model !== null && !MODEL_SIZES.includes(model as ModelSize)) throw new Error('model must be "small", "big" or null');
  const id = strOrNull(raw, "id");
  return { key: str(raw, "key"), title: str(raw, "title"), request: str(raw, "request", false), after: [...after], ...(model === null ? {} : { model: model as ModelSize }), ...(id === null ? {} : { id }) };
}

function parseFinding(raw: unknown): WaveFinding {
  if (!isRecord(raw)) throw new Error("a finding is not an object");
  const line = raw.line ?? null;
  if (line !== null && typeof line !== "number") throw new Error("line must be a number or null");
  return { severity: oneOf(raw, "severity", ["blocker", "major", "minor"] as const), file: str(raw, "file", false), line, text: str(raw, "text", false) };
}

export function parseWaveEvent(raw: unknown): WaveEvent {
  if (!isRecord(raw)) throw new Error("the event is not an object");
  const at = str(raw, "at");
  const kind = raw.kind;
  switch (kind) {
    case "tasks": {
      if (!Array.isArray(raw.tasks)) throw new Error("tasks must be an array");
      const event: WaveEvent = { at, kind, tasks: raw.tasks.map(parseSpec) };
      if (raw.dropped !== undefined && raw.dropped !== null) {
        if (!Array.isArray(raw.dropped) || !raw.dropped.every((key) => typeof key === "string")) throw new Error("dropped must be an array of keys");
        event.dropped = [...raw.dropped];
      }
      return event;
    }
    case "task":
      return { at, kind, key: str(raw, "key"), taskId: str(raw, "taskId"), sessionId: str(raw, "sessionId") };
    case "stage": {
      const stage = oneOf(raw, "stage", WAVE_STAGES);
      const reason = raw.reason ?? null;
      if (reason !== null && !WAVE_REASONS.includes(reason as WaveReason)) throw new Error(`reason must be one of ${WAVE_REASONS.join(", ")} or null`);
      const event: WaveEvent = { at, kind, stage, reason: reason as WaveReason | null };
      const detail = strOrNull(raw, "detail");
      if (detail !== null) event.detail = detail;
      return event;
    }
    case "start":
      return { at, kind, branch: str(raw, "branch"), base: str(raw, "base") };
    case "gate": {
      if (typeof raw.passed !== "boolean") throw new Error("passed must be a boolean");
      const event: WaveEvent = { at, kind, phase: oneOf(raw, "phase", ["review", "merge"] as const), passed: raw.passed, wallMs: num(raw, "wallMs"), log: strOrNull(raw, "log") };
      const commit = strOrNull(raw, "commit");
      if (commit !== null) event.commit = commit;
      if (Array.isArray(raw.flaky)) event.flaky = raw.flaky.filter((name): name is string => typeof name === "string");
      return event;
    }
    case "review": {
      if (!Array.isArray(raw.findings)) throw new Error("findings must be an array");
      return {
        at,
        kind,
        round: num(raw, "round"),
        sessionId: strOrNull(raw, "sessionId"),
        model: strOrNull(raw, "model"),
        verdict: oneOf(raw, "verdict", ["approved", "rejected", "failed"] as const),
        status: str(raw, "status"),
        findings: raw.findings.map(parseFinding),
        usage: usageOf(raw.usage),
        wallMs: num(raw, "wallMs"),
      };
    }
    case "merge":
      return { at, kind, from: str(raw, "from"), to: str(raw, "to"), queueMs: num(raw, "queueMs") };
    case "remote": {
      const event: WaveEvent = { at, kind };
      if ("number" in raw) {
        if (raw.number !== null && typeof raw.number !== "number") throw new Error("number must be a number or null");
        event.number = raw.number;
      }
      for (const key of ["url", "pushed", "error"] as const) if (key in raw) event[key] = strOrNull(raw, key);
      return event;
    }
    case "contract":
      return { at, kind, name: str(raw, "name"), paths: strings(raw, "paths") ?? [], done: strings(raw, "done") ?? [] };
    case "update": {
      const event: WaveEvent = { at, kind };
      if (raw.key !== undefined && raw.key !== null) event.key = str(raw, "key");
      if (raw.title !== undefined && raw.title !== null) event.title = str(raw, "title");
      if (raw.request !== undefined && raw.request !== null) event.request = str(raw, "request");
      const after = strings(raw, "after");
      if (after !== undefined) event.after = after;
      if (raw.model !== undefined && raw.model !== null) event.model = oneOf(raw, "model", MODEL_SIZES);
      return event;
    }
    case "launch":
      return { at, kind, key: str(raw, "key") };
    default:
      throw new Error(`kind ${JSON.stringify(kind)} is no wave event`);
  }
}

/**
 * The declaration and events of a file's text. A line that is no JSON is a torn append (a writer died mid-line) and is
 * skipped, so is a last line without its newline; a JSON line that is no event makes the file invalid.
 */
export function parseWaveFile(text: string, id: string): WaveFile {
  const lines = text.split("\n");
  // A complete file ends with "\n": the last element is "" then, else it is a torn line.
  lines.pop();
  const [head] = lines;
  if (head === undefined) throw new Error("the file has no declaration");
  let first: unknown;
  try {
    first = JSON.parse(head);
  } catch (error) {
    throw new Error(`line 1: ${errorText(error)}`);
  }
  const declaration = parseWaveDeclaration(first, id);
  const events: WaveEvent[] = [];
  for (const [index, line] of lines.slice(1).entries()) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    try {
      events.push(parseWaveEvent(raw));
    } catch (error) {
      throw new Error(`line ${index + 2}: ${errorText(error)}`);
    }
  }
  return { declaration, events };
}

// ---- the file ----

/** Writes a new wave's file holding its declaration. Throws when the file exists. */
export async function createWave(declaration: WaveDeclaration): Promise<void> {
  if (!isWaveId(declaration.id)) throw new Error(`${declaration.id} is not a wave id`);
  parseWaveDeclaration(declaration, declaration.id);
  await mkdir(wavesDir(), { recursive: true });
  const path = wavePath(declaration.id);
  // Written in full first, then linked: `link` fails on an existing file, and no reader sees a half-written one.
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(declaration)}\n`, "utf8");
    await link(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
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
export async function appendWaveEvents(id: string, events: NewWaveEvent[] | ((fold: WaveFold) => NewWaveEvent[] | null)): Promise<WaveEvent[] | null> {
  if (!isWaveId(id)) throw new FactoryError("not_found", `${id} is not a wave id`);
  return withLogLock(id, async () => {
    let chosen: NewWaveEvent[] | null;
    if (typeof events === "function") {
      const file = await readWave(id);
      chosen = events(foldWave(file.declaration, file.events));
      if (chosen === null) return null;
    } else {
      chosen = events;
    }
    const at = new Date().toISOString();
    const written = chosen.map((event) => parseWaveEvent({ ...event, at: event.at ?? at }));
    let handle;
    try {
      handle = await open(wavePath(id), "r+");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new FactoryError("not_found", `no wave ${id}`);
      throw error;
    }
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
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new FactoryError("not_found", `no wave ${id}`);
    throw error;
  }
  try {
    return parseWaveFile(text, id);
  } catch (error) {
    throw new Error(`${path}: ${errorText(error)}`);
  }
}

/** Every wave, oldest first; only those of `repo` when given. Files that are no valid wave are skipped. */
export async function listWaves(repo?: string): Promise<WaveFile[]> {
  let names: string[];
  try {
    names = await readdir(wavesDir());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const waves: WaveFile[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const wave = await readWave(name.slice(0, -".jsonl".length)).catch(() => undefined);
    if (wave !== undefined && (repo === undefined || wave.declaration.repo === repo)) waves.push(wave);
  }
  return waves.sort((a, b) => a.declaration.createdAt.localeCompare(b.declaration.createdAt));
}

/** Removes the wave's file, its runner log, its locks, its poke marker and its reviews. Its tasks and branch stay. */
export async function removeWave(id: string): Promise<void> {
  if (!isWaveId(id)) return;
  for (const path of [wavePath(id), waveLogPath(id), waveLockPath(id), waveLogLockPath(id), wavePokePath(id), waveReviewsDir(id)]) await rm(path, { recursive: true, force: true });
}

/**
 * The commit the wave's `merge_gates` last passed on before its review (the `commit` of the last passed `review` gate
 * event), null when none: its merge runs them again only on another commit (the target moved since).
 */
export function gatedCommit(events: readonly WaveEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.kind === "gate" && event.phase === "review" && event.passed && event.commit !== undefined) return event.commit;
  }
  return null;
}

// ---- the fold ----

/** The wave's state from its declaration and events: a declared wave is `building`, `queued` with `after`. */
export function foldWave(declaration: WaveDeclaration, events: readonly WaveEvent[]): WaveFold {
  const after = declaration.after ?? [];
  const stage: WaveStage = after.length > 0 ? "queued" : "building";
  const fold: WaveFold = { ...declaration, after: [...after], stage, reason: null, detail: null, tasks: [], reviews: [], gates: [], merge: null, remote: null };
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
          fold.tasks.push({ key: spec.key, title: spec.title, request: spec.request, after: [...spec.after], model: spec.model ?? "big", taskId: null, sessionId: null, ...(spec.id === undefined ? {} : { id: spec.id }) });
        }
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
        // A launch the runner did not record ended with it (failed, stopped): the task is plainly pending again.
        for (const task of fold.tasks) delete task.launching;
        break;
      case "start":
        fold.branch = event.branch;
        fold.base = event.base;
        fold.stage = "building";
        fold.reason = null;
        fold.detail = null;
        break;
      case "gate": {
        const { kind: _kind, commit: _commit, ...gate } = event;
        fold.gates.push(gate);
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
      case "remote": {
        const { at: _at, kind: _kind, ...fields } = event;
        fold.remote = { ...(fold.remote ?? { number: null, url: null, pushed: null, error: null }), ...fields };
        break;
      }
      case "contract":
        break;
      default:
        throw new Error(`kind ${JSON.stringify((event as { kind: unknown }).kind)} is no wave event`);
    }
  }
  return fold;
}

/** Applies an `update` event: to the task `key` (a started one keeps its `after` and `model`), else to the wave. */
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
    // `tasks.update` gives a task being launched no `after` or `model` (unless its launch died with its runner).
    const pending = task.taskId === null;
    if (event.title !== undefined) {
      task.title = event.title;
      fields.push("title");
    }
    if (event.request !== undefined) {
      task.request = event.request;
      fields.push("request");
    }
    if (pending && event.after !== undefined) {
      task.after = [...event.after];
      fields.push("after");
    }
    if (pending && event.model !== undefined) {
      task.model = event.model;
      fields.push("model");
    }
  }
  (fold.updates ??= []).push({ at: event.at, key: event.key ?? null, fields });
}

/** Stages that keep what came before them: a wave blocked or cancelled is as far as it was when that happened. */
const KEEPS_REVIEW: readonly WaveStage[] = ["queued", "building", "blocked", "cancelled"];

/**
 * Whether the wave's review began since it last built (invariant 2): from then on nothing may reach its branch until
 * `waves.add` makes it build again. A wave blocked or cancelled while it built (a launch failed) has not begun one, so
 * the merges of its tasks still running land.
 */
export function reviewBegan(events: readonly WaveEvent[]): boolean {
  let began = false;
  for (const event of events) {
    if (event.kind !== "stage") continue;
    if (event.stage === "building") began = false;
    else if (!KEEPS_REVIEW.includes(event.stage)) began = true;
  }
  return began;
}

// ---- scheduling ----

/** Task states by wave task key; a key missing or null means no state is known yet. */
export type TaskStates = ReadonlyMap<string, string | null>;

/** A wave task's state: `pending` before it started (`cancelled` when dropped), `running` once started but before its first state. */
export function waveTaskState(task: FoldedTask, states: TaskStates): string {
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
    return state === null || !RESTING_STATES.includes(state as State);
  });
  return active ? [] : unreachable;
}

/** Every task, started or pending, is `done` or `cancelled`, and at least one is `done`. */
export function readyForReview(fold: WaveFold, states: TaskStates): boolean {
  const all = fold.tasks.map((task) => waveTaskState(task, states));
  return all.every((state) => state === "done" || state === "cancelled") && all.includes("done");
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
 * given (never a concrete model: the wave's settings name those). Throws a `FactoryError` `invalid`.
 */
export function validateTaskSpecs(raw: unknown, existing: readonly { key: string }[] = []): WaveTaskEntry[] {
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
    specs.push({ key, title, request, after: [...new Set(after as string[])], ...(model === null ? {} : { model: model as ModelSize }) });
  }
  for (const spec of specs) {
    for (const name of spec.after) {
      if (name === spec.key) throw invalid(`task ${spec.key} waits for itself`);
      if (!keys.has(name)) throw invalid(`task ${spec.key} waits for ${name}, no task of the wave`);
    }
  }
  // Existing tasks wait only for existing ones, so a cycle runs through the added specs alone.
  const byKey = new Map(specs.map((spec) => [spec.key, spec]));
  const visiting = new Set<string>();
  const finished = new Set<string>();
  const visit = (key: string, path: string[]): void => {
    if (finished.has(key)) return;
    if (visiting.has(key)) throw invalid(`tasks wait for each other in a cycle: ${[...path.slice(path.indexOf(key)), key].join(" -> ")}`);
    const spec = byKey.get(key);
    if (spec === undefined) return;
    visiting.add(key);
    for (const name of spec.after) visit(name, [...path, key]);
    visiting.delete(key);
    finished.add(key);
  };
  for (const spec of specs) visit(spec.key, []);
  return specs;
}
