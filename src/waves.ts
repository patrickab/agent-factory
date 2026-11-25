/**
 * A wave's record on disk and the fold from its events to its state. Pure: nothing here starts a process.
 *
 * - One file per wave, `<factoryHome>/waves/<id>.jsonl`, append-only: line 1 is the declaration (`createWave`), every
 *   later line one event (`appendWaveEvent`). Lock and runner log lie next to it (`waveLockPath`, `waveLogPath`)
 * - The wave's state is only ever `foldWave` of its events plus its tasks' states: the scheduling helpers
 *   (`startableKeys`, `readyForReview`, `allCancelled`, `waveCounts`) take the fold and a map key -> task state
 * - One writer appends: the holder of the wave's lock. A line is written by one write; a line cut short by a crash
 *   is skipped when read, and the next append starts on a line of its own
 * - `listWaves` skips files that are no valid wave, as `listTasks` does; `validateTaskSpecs` checks specs a wave adds
 */
import { link, mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FactoryError } from "./core.ts";
import { factoryHome } from "./settings.ts";
import { errorText, isRecord } from "./util.ts";

export type WaveStage = "building" | "reviewing" | "rejected" | "merging" | "waiting_approve" | "merged" | "blocked" | "cancelled";
export type WaveReason = "conflict" | "gates" | "dirty" | "infra" | "review_failed";
export type Usage = { input: number; output: number; cost: number };

/** `key` unique in the wave, `[A-Za-z0-9._-]+`; `after` = keys of the same wave. */
export type WaveTaskSpec = { key: string; title: string; request: string; after?: string[] };

export const WAVE_STAGES: readonly WaveStage[] = ["building", "reviewing", "rejected", "merging", "waiting_approve", "merged", "blocked", "cancelled"];
export const RESTING_WAVE_STAGES: readonly WaveStage[] = ["rejected", "waiting_approve", "merged", "blocked", "cancelled"];
const WAVE_REASONS: readonly WaveReason[] = ["conflict", "gates", "dirty", "infra", "review_failed"];

/** Line 1 of a wave's file. `base`: the commit the wave branched from; `origin`: the declaring Pi session's id. */
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
  origin: string | null;
  createdAt: string;
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
export type WaveGate = { at: string; phase: "review" | "merge"; passed: boolean; wallMs: number; log: string | null };
/** The commit range that reached the target. */
export type WaveMerge = { at: string; from: string; to: string; queueMs: number };
export type WaveRemote = { number: number | null; url: string | null; pushed: string | null; error: string | null };

/** One line after the declaration. A `remote` event sets only the fields it carries. */
export type WaveEvent =
  | { at: string; kind: "tasks"; tasks: Required<WaveTaskSpec>[] }
  | { at: string; kind: "task"; key: string; taskId: string; sessionId: string }
  | { at: string; kind: "stage"; stage: WaveStage; reason: WaveReason | null }
  | ({ kind: "gate" } & WaveGate)
  | ({ kind: "review" } & WaveReview)
  | ({ kind: "merge" } & WaveMerge)
  | ({ at: string; kind: "remote" } & Partial<WaveRemote>);

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An event to append; `at` defaults to now. */
export type NewWaveEvent = DistributiveOmit<WaveEvent, "at"> & { at?: string };

export interface WaveFile {
  declaration: WaveDeclaration;
  events: WaveEvent[];
}

/** A wave's task as the log knows it: null ids until the `task` event that started it. */
export type FoldedTask = { key: string; title: string; request: string; after: string[]; taskId: string | null; sessionId: string | null };

/** Everything of a `WaveView` that needs no task state. */
export interface WaveFold extends WaveDeclaration {
  stage: WaveStage;
  /** Only when `stage` is `blocked`. */
  reason: WaveReason | null;
  tasks: FoldedTask[];
  reviews: WaveReview[];
  gates: WaveGate[];
  merge: WaveMerge | null;
  remote: WaveRemote | null;
}

/** A wave as every client sees it (the contract's shape); the core builds it from the fold and the tasks. */
export interface WaveView extends WaveDeclaration {
  stage: WaveStage;
  reason: WaveReason | null;
  running: boolean;
  interrupted: boolean;
  tasks: { key: string; title: string; after: string[]; taskId: string | null; sessionId: string | null; state: string; usage: Usage | null }[];
  counts: { total: number; done: number };
  reviews: WaveReview[];
  gates: WaveGate[];
  merge: WaveMerge | null;
  remote: WaveRemote | null;
  usage: Usage | null;
  actions: string[];
}

/** Wave ids have the shape of task ids (`crypto.randomUUID`): never a path separator. */
const WAVE_ID = /^[0-9a-f-]{36}$/;
const TASK_KEY = /^[A-Za-z0-9._-]+$/;

export function isWaveId(id: string): boolean {
  return WAVE_ID.test(id);
}

export function wavesDir(): string {
  return join(factoryHome(), "waves");
}

export function wavePath(id: string): string {
  return join(wavesDir(), `${id}.jsonl`);
}

/** Where the detached runner of a wave writes its stdout and stderr. */
export function waveLogPath(id: string): string {
  return join(wavesDir(), `${id}.log`);
}

export function waveLockPath(id: string): string {
  return join(wavesDir(), `${id}.lock`);
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
  return { input: num(raw, "input"), output: num(raw, "output"), cost: num(raw, "cost") };
}

export function parseWaveDeclaration(raw: unknown, id: string): WaveDeclaration {
  if (!isRecord(raw)) throw new Error("the declaration is not an object");
  const declaration: WaveDeclaration = {
    id: str(raw, "id"),
    repo: str(raw, "repo"),
    tag: str(raw, "tag"),
    plan: strOrNull(raw, "plan"),
    title: str(raw, "title"),
    request: str(raw, "request", false),
    branch: str(raw, "branch"),
    target: str(raw, "target"),
    base: str(raw, "base"),
    origin: strOrNull(raw, "origin"),
    createdAt: str(raw, "createdAt"),
  };
  if (declaration.id !== id) throw new Error(`id ${declaration.id} is not the file's name`);
  return declaration;
}

function parseSpec(raw: unknown): Required<WaveTaskSpec> {
  if (!isRecord(raw)) throw new Error("a task is not an object");
  const after = raw.after ?? [];
  if (!Array.isArray(after) || !after.every((key) => typeof key === "string")) throw new Error("after must be an array of keys");
  return { key: str(raw, "key"), title: str(raw, "title"), request: str(raw, "request", false), after: [...after] };
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
      return { at, kind, tasks: raw.tasks.map(parseSpec) };
    }
    case "task":
      return { at, kind, key: str(raw, "key"), taskId: str(raw, "taskId"), sessionId: str(raw, "sessionId") };
    case "stage": {
      const stage = oneOf(raw, "stage", WAVE_STAGES);
      const reason = raw.reason ?? null;
      if (reason !== null && !WAVE_REASONS.includes(reason as WaveReason)) throw new Error(`reason must be one of ${WAVE_REASONS.join(", ")} or null`);
      return { at, kind, stage, reason: reason as WaveReason | null };
    }
    case "gate": {
      if (typeof raw.passed !== "boolean") throw new Error("passed must be a boolean");
      return { at, kind, phase: oneOf(raw, "phase", ["review", "merge"] as const), passed: raw.passed, wallMs: num(raw, "wallMs"), log: strOrNull(raw, "log") };
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

/** Appends one event to an existing wave; the caller holds the wave's lock. Returns the event as written. */
export async function appendWaveEvent(id: string, event: NewWaveEvent): Promise<WaveEvent> {
  if (!isWaveId(id)) throw new FactoryError("not_found", `${id} is not a wave id`);
  const written = parseWaveEvent({ ...event, at: event.at ?? new Date().toISOString() });
  let file;
  try {
    file = await open(wavePath(id), "r+");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new FactoryError("not_found", `no wave ${id}`);
    throw error;
  }
  try {
    const { size } = await file.stat();
    const last = Buffer.alloc(1);
    if (size > 0) await file.read(last, 0, 1, size - 1);
    // After a torn append the new event starts on a line of its own; the torn line is skipped on read.
    const prefix = size > 0 && last[0] !== 0x0a ? "\n" : "";
    await file.write(`${prefix}${JSON.stringify(written)}\n`, size);
  } finally {
    await file.close();
  }
  return written;
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

/** Removes the wave's file, its runner log and its lock. Its tasks and branch stay. */
export async function removeWave(id: string): Promise<void> {
  if (!isWaveId(id)) return;
  await rm(wavePath(id), { force: true });
  await rm(waveLogPath(id), { force: true });
  await rm(waveLockPath(id), { force: true });
}

// ---- the fold ----

/** The wave's state from its declaration and events: a declared wave is `building`. */
export function foldWave(declaration: WaveDeclaration, events: readonly WaveEvent[]): WaveFold {
  const fold: WaveFold = { ...declaration, stage: "building", reason: null, tasks: [], reviews: [], gates: [], merge: null, remote: null };
  for (const event of events) {
    switch (event.kind) {
      case "tasks":
        for (const spec of event.tasks) {
          // Validation keeps keys unique; a repeated key in a hand-edited log keeps its first declaration.
          if (fold.tasks.some((task) => task.key === spec.key)) continue;
          fold.tasks.push({ key: spec.key, title: spec.title, request: spec.request, after: [...spec.after], taskId: null, sessionId: null });
        }
        break;
      case "task": {
        const task = fold.tasks.find((candidate) => candidate.key === event.key);
        if (task) {
          task.taskId = event.taskId;
          task.sessionId = event.sessionId;
        }
        break;
      }
      case "stage":
        fold.stage = event.stage;
        fold.reason = event.stage === "blocked" ? event.reason : null;
        break;
      case "gate": {
        const { kind: _kind, ...gate } = event;
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
      default:
        throw new Error(`kind ${JSON.stringify((event as { kind: unknown }).kind)} is no wave event`);
    }
  }
  return fold;
}

// ---- scheduling ----

/** Task states by wave task key; a key missing or null means no state is known yet. */
export type TaskStates = ReadonlyMap<string, string | null>;

/** A wave task's state: `pending` before it started, `running` once started but before its first state. */
export function waveTaskState(task: FoldedTask, states: TaskStates): string {
  if (task.taskId === null) return "pending";
  return states.get(task.key) ?? "running";
}

/** The keys of tasks not yet started whose `after` tasks are all `done`, in declaration order. */
export function startableKeys(fold: WaveFold, states: TaskStates): string[] {
  const byKey = new Map(fold.tasks.map((task) => [task.key, task]));
  const done = (key: string) => {
    const task = byKey.get(key);
    return task !== undefined && waveTaskState(task, states) === "done";
  };
  return fold.tasks.filter((task) => task.taskId === null && task.after.every(done)).map((task) => task.key);
}

/**
 * The keys of tasks not yet started that never can: an `after` task, directly or through others, is `cancelled`.
 * The wave waits for the supervisor then (cancel the wave, or add tasks).
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
  return fold.tasks.filter((task) => task.taskId === null && task.after.some(dead)).map((task) => task.key);
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
 * title and request, `after` naming keys of the wave (existing or added), no cycle. Throws a `FactoryError` `invalid`.
 */
export function validateTaskSpecs(raw: unknown, existing: readonly { key: string }[] = []): Required<WaveTaskSpec>[] {
  const invalid = (message: string) => new FactoryError("invalid", message);
  if (!Array.isArray(raw) || raw.length === 0) throw invalid("tasks must be a non-empty array of {key, title, request, after?}");
  const keys = new Set(existing.map((task) => task.key));
  const specs: Required<WaveTaskSpec>[] = [];
  for (const [index, item] of raw.entries()) {
    if (!isRecord(item)) throw invalid(`tasks[${index}] must be an object`);
    const { key, title, request, after = [] } = item;
    if (typeof key !== "string" || !TASK_KEY.test(key)) throw invalid(`tasks[${index}].key must be a string of A-Z a-z 0-9 . _ -`);
    if (keys.has(key)) throw invalid(`task key ${key} is not unique in the wave`);
    if (typeof title !== "string" || title.trim() === "") throw invalid(`tasks[${index}].title must be a non-empty string`);
    if (typeof request !== "string" || request.trim() === "") throw invalid(`tasks[${index}].request must be a non-empty string`);
    if (!Array.isArray(after) || !after.every((name) => typeof name === "string")) throw invalid(`tasks[${index}].after must be an array of keys`);
    keys.add(key);
    specs.push({ key, title, request, after: [...new Set(after as string[])] });
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
