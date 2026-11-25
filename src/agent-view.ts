/**
 * The agent view: what an agent gets back from the factory, as text lines that hold only what its next decision needs.
 * Pure: no I/O, no import but types. The full view (JSON, `callAction`'s answer) is for programs.
 *
 * - `agentView(action, params, result)`: the full view of every action in `ACTIONS` rendered as text
 * - `taskBlock`, `waveBlock`: one task, one wave. First line kind, short id (8 chars), state; then only the lines that
 *   matter in that state, and `next:` with the actions valid now. A notification is `factory: <what>` over one of them
 * - `agentError`: an error as one line with the way out. `agentActions`: the action list, or one action's params
 * - Never in the output (invariant 10): paths, timestamps, session ids, settings, an echoed request, per-message usage.
 *   Usage is one cost figure. Every rendering goes through `scrub`: a home directory becomes `~`, any other absolute
 *   path `<path>` (`withoutPaths`, also the rule of a wave's stage details), a uuid its short id
 */
import type { ActionSpec, TaskView } from "./core.ts";
import type { Finding } from "./state.ts";
import type { WaveView } from "./waves.ts";

const SHORT = 8;
/** Lines of a failed gate's output shown under a blocked wave. */
const GATE_TAIL_LINES = 20;
const TIMELINE_TEXT_CHARS = 120;

const UUID = /\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HOME = /\/(?:home|Users)\/[^/\s"'`]+/g;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** Every absolute path in free text as `<path>` (one rule for the agent view and a wave's stage details). */
export function withoutPaths(text: string): string {
  return text.replace(/(^|[\s'"`(=])\/[^\s'"`),;]+/g, "$1<path>");
}

/**
 * A home directory as `~`, any other absolute path as `<path>`, a uuid (task, wave, session) as its short id. With
 * `keepPaths` (the `repos.*` answers, whose repository paths are the handles an agent passes back) only the home goes.
 */
function scrub(text: string, keepPaths = false): string {
  const homeless = text.replace(HOME, "~");
  return (keepPaths ? homeless : withoutPaths(homeless)).replace(UUID, "$1");
}

function short(id: string | null | undefined): string {
  return (id ?? "").slice(0, SHORT);
}

function cost(usage: { cost: number } | null | undefined): string | null {
  return usage ? `$${usage.cost.toFixed(2)}` : null;
}

/** Fields joined by two spaces, the empty ones left out. */
function fields(...parts: (string | null | undefined | false)[]): string {
  return parts.filter((part): part is string => typeof part === "string" && part !== "").join("  ");
}

/** `text` on lines under `label`, every continuation line indented as deep as the first. */
function labelled(indent: string, label: string, text: string): string[] {
  const [first, ...rest] = text.trimEnd().split("\n");
  return [`${indent}${label}${first}`, ...rest.map((line) => `${indent}  ${line}`)];
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// ---- tasks ----

const FINISHED_TASK_STATES = ["done", "cancelled"];
const RESTING_TASK_STATES = ["waiting_approve", "waiting_answer", "blocked", "done", "cancelled"];

function taskState(view: TaskView): string {
  if (view.state === null) return "starting";
  if (view.interrupted) return "interrupted";
  if (view.state === "blocked") return `blocked: ${view.reason ?? "unknown"}`;
  return view.state;
}

function taskRests(view: TaskView): boolean {
  return !view.running && (view.interrupted || (view.state !== null && RESTING_TASK_STATES.includes(view.state)));
}

/** `task 4ae7325b  waiting_answer  round 1  factory/w1  wave 3f2a91c0  $2.10` */
function taskHeader(view: TaskView): string {
  return fields(
    `task ${short(view.id)}`,
    taskState(view),
    view.round === null ? null : `round ${view.round}`,
    view.tag,
    view.wave === null ? null : `wave ${short(view.wave)}`,
    cost(view.usage),
  );
}

function taskNext(view: TaskView): string {
  if (view.actions.length === 0) return "next: none, it runs";
  const named = view.actions.map((action) => (action === "tasks.message" && view.state === "waiting_answer" && !view.interrupted ? "tasks.message (answers it)" : action));
  return `next: ${named.join(", ")}`;
}

/** `review 2: rejected · 2 major, 5 minor` and, with `findings`, one line per finding. Tasks and waves alike. */
function reviewSummary(round: number, verdict: string, findings: readonly Finding[], withFindings: boolean): string[] {
  const counts = (["blocker", "major", "minor"] as const)
    .map((severity) => [severity, findings.filter((finding) => finding.severity === severity).length] as const)
    .filter(([, count]) => count > 0)
    .map(([severity, count]) => `${count} ${severity}`);
  const head = `  review ${round}: ${verdict}${counts.length > 0 ? ` · ${counts.join(", ")}` : ""}`;
  return withFindings ? [head, ...findings.map(findingLine)] : [head];
}

/** The lines of a task's state, under its header and title. */
function taskStateLines(view: TaskView): string[] {
  const indent = "  ";
  if (view.interrupted) return [`${indent}interrupted: ${view.state} when its runner ended, no runner lives`];
  switch (view.state) {
    case "waiting_answer":
      return labelled(indent, "question: ", view.question ?? "(the question is not recorded)");
    case "waiting_approve":
      return [`${indent}waits for tasks.approve`];
    case "blocked": {
      const lines = view.failure === null ? [] : labelled(indent, "failure: ", tailLines(view.failure));
      const review = view.review;
      if (review !== null && !review.approved && (view.reason ?? "").includes("review")) {
        lines.push(...reviewSummary(review.round, review.status === "ok" ? "rejected" : `failed (${review.status})`, review.findings, true));
      }
      return lines;
    }
    case "done": {
      const lines = [`${indent}done: ${view.reason ?? "unknown"}${view.merged === null ? "" : ` · merged ${short(view.merged)}`}`];
      if (view.lastMessage !== null) lines.push(...labelled(indent, "last message: ", view.lastMessage));
      return lines;
    }
    case "cancelled":
      return view.reason === null || view.reason === "cancelled" ? [] : [`${indent}cancelled: ${view.reason}`];
    default:
      return [];
  }
}

/** One task: header, title, the lines of its state, `next:`. Exported for notifications. */
export function taskBlock(view: TaskView): string {
  return scrub([taskHeader(view), `  ${view.title}`, ...taskStateLines(view), `  ${taskNext(view)}`].join("\n"));
}

/** One line of a list: the header and the title. */
function taskLine(view: TaskView): string {
  return fields(taskHeader(view), view.title);
}

/** `tasks.get` and the tasks.* mutations answer a TaskView; `{task}` is accepted too. */
function asTask(result: unknown): TaskView {
  const record = result as { task?: TaskView };
  return record.task ?? (result as TaskView);
}

function taskList(tasks: TaskView[]): string {
  const open = tasks.filter((task) => task.state === null || !FINISHED_TASK_STATES.includes(task.state));
  const rest = tasks.length - open.length;
  if (tasks.length === 0) return "no tasks";
  const lines = open.map(taskLine);
  if (open.length === 0) lines.push(`no unfinished tasks, ${rest} finished`);
  else if (rest > 0) lines.push(`${rest} finished, not shown`);
  return lines.join("\n");
}

// ---- waves ----

const FINISHED_WAVE_STAGES = ["merged", "cancelled"];
const RESTING_WAVE_STAGES = ["rejected", "waiting_approve", "merged", "blocked", "cancelled"];
/** Task states of a wave's task that wait for the supervisor: their id is shown. */
const TASK_ATTENTION = ["waiting_answer", "waiting_approve", "blocked"];

type WaveTask = WaveView["tasks"][number];

function waveState(view: WaveView): string {
  if (view.interrupted) return "interrupted";
  if (view.stage === "blocked") return `blocked: ${view.reason ?? "unknown"}`;
  return view.stage;
}

function waveRests(view: WaveView): boolean {
  return !view.running && (view.interrupted || RESTING_WAVE_STAGES.includes(view.stage));
}

/** `wave 3f2a91c0  rejected  4/5 done  factory/w1  $18.40` */
function waveHeader(view: WaveView): string {
  return fields(`wave ${short(view.id)}`, waveState(view), `${view.counts.done}/${view.counts.total} done`, view.tag, cost(view.usage));
}

/** The pending tasks that never can start: a task they wait for, directly or through others, is cancelled. */
export function unreachableTasks(tasks: readonly WaveTask[]): string[] {
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  const memo = new Map<string, boolean>();
  const dead = (key: string): boolean => {
    const known = memo.get(key);
    if (known !== undefined) return known;
    memo.set(key, false); // a cycle proves nothing
    const task = byKey.get(key);
    const result = task === undefined || task.state === "cancelled" || (task.state === "pending" && task.after.some(dead));
    memo.set(key, result);
    return result;
  };
  return tasks.filter((task) => task.state === "pending" && task.after.some(dead)).map((task) => task.key);
}

/** `tasks: record done · actions waiting_answer (4ae7325b) · docs pending` */
function waveTasksLine(view: WaveView): string {
  if (view.tasks.length === 0) return "  tasks: none";
  const items = view.tasks.map((task) => {
    const id = task.taskId !== null && TASK_ATTENTION.includes(task.state) ? ` (${short(task.taskId)})` : "";
    return `${task.key} ${task.state}${id}`;
  });
  return `  tasks: ${items.join(" · ")}`;
}

function findingLine(finding: Finding): string {
  const where = finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
  return `    ${fields(finding.severity, where, finding.text.replace(/\s*\n\s*/g, " "))}`;
}

/** `review 2: rejected · 2 major, 5 minor` and, with `findings`, one line per finding. */
function reviewLines(review: WaveView["reviews"][number], findings: boolean): string[] {
  if (review.verdict === "failed") return [`  review ${review.round}: failed (${review.status})`];
  return reviewSummary(review.round, review.verdict, review.findings, findings);
}

/** A failure text: its first line (what failed), then the last `GATE_TAIL_LINES` lines of the rest (the output). */
function tailLines(text: string): string {
  const [first, ...rest] = text.trimEnd().split("\n");
  return [first, ...rest.slice(-GATE_TAIL_LINES)].join("\n");
}

/** The failed gate run's last lines. */
function gateTail(view: WaveView): string[] {
  const failed = view.gates.findLast((gate) => !gate.passed);
  if (failed === undefined) return [];
  if (failed.log === null || failed.log.trim() === "") return [`  gates failed (${failed.phase}), no output`];
  const lines = failed.log.trimEnd().split("\n").slice(-GATE_TAIL_LINES);
  return [`  gates failed (${failed.phase}), last lines:`, ...lines.map((line) => `    ${line}`)];
}

function remoteLines(view: WaveView): string[] {
  if (view.remote === null) return [];
  const lines: string[] = [];
  if (view.remote.url !== null) lines.push(`  remote: ${view.remote.url}`);
  if (view.remote.error !== null) lines.push(`  remote failed: ${view.remote.error}`);
  return lines;
}

/** `why: <detail>`: the last stage event's sentence on why the wave is at its stage. */
function detailLine(view: WaveView): string[] {
  return view.detail === null || view.detail === undefined ? [] : labelled("  ", "why: ", view.detail);
}

/** The lines of a wave's stage, under its header and title. */
function waveStageLines(view: WaveView): string[] {
  const lastReview = view.reviews.at(-1);
  if (view.interrupted) return [`  interrupted: ${view.stage} when its runner ended, no runner lives`, waveTasksLine(view)];
  switch (view.stage) {
    case "building": {
      const unreachable = unreachableTasks(view.tasks);
      return [waveTasksLine(view), ...(unreachable.length > 0 ? [`  cannot start: ${unreachable.join(", ")}`] : [])];
    }
    case "reviewing":
      return [waveTasksLine(view), `  review ${view.reviews.length + 1} runs`];
    case "rejected":
      return [waveTasksLine(view), ...(lastReview ? reviewLines(lastReview, true) : [])];
    case "merging":
      return [`  merging into ${view.target}`];
    case "waiting_approve":
      return [...(lastReview ? reviewLines(lastReview, true) : []), "  waits for waves.approve"];
    case "blocked": {
      const lines = [waveTasksLine(view), ...detailLine(view)];
      if (view.reason === "gates") lines.push(...gateTail(view));
      if (view.reason === "review_failed" && lastReview) lines.push(...reviewLines(lastReview, false));
      return lines;
    }
    case "merged":
      return [...(view.merge ? [`  merged ${short(view.merge.from)}..${short(view.merge.to)} into ${view.target}`] : []), ...remoteLines(view)];
    case "cancelled":
      return [];
  }
}

/** One wave: header, title, the lines of its stage, `next:`. Exported for notifications. */
export function waveBlock(view: WaveView): string {
  const next = view.actions.length === 0 ? "next: none, it runs" : `next: ${view.actions.join(", ")}`;
  return scrub([waveHeader(view), `  ${view.title}`, ...waveStageLines(view), `  ${next}`].join("\n"));
}

function waveList(waves: WaveView[]): string {
  if (waves.length === 0) return "no waves";
  const open = waves.filter((wave) => !FINISHED_WAVE_STAGES.includes(wave.stage));
  const rest = waves.length - open.length;
  const lines = open.map((wave) => fields(waveHeader(wave), wave.title));
  if (open.length === 0) lines.push(`no unfinished waves, ${rest} merged or cancelled`);
  else if (rest > 0) lines.push(`${rest} merged or cancelled, not shown`);
  return lines.join("\n");
}

/** One line: the header of a wave after a mutation, with what it started. */
function waveReceipt(prefix: string, view: WaveView, extra: string[] = []): string {
  return [fields(`${prefix}wave ${short(view.id)}`, waveState(view), `${view.counts.done}/${view.counts.total} done`, view.tag), ...extra].join(" · ");
}

// ---- tasks.wait ----

type WaitResult = { tasks: TaskView[]; waves: WaveView[]; attention: string[]; timedOut: boolean };

function duration(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
}

function stillWorking(tasks: TaskView[], waves: WaveView[]): string | null {
  const parts: string[] = [];
  if (tasks.length > 0) parts.push(plural(tasks.length, "task"));
  for (const wave of waves) parts.push(`wave ${short(wave.id)} ${wave.stage} ${wave.counts.done}/${wave.counts.total}`);
  return parts.length === 0 ? null : `still working: ${parts.join(" · ")}`;
}

function indentBlock(block: string): string[] {
  return block.split("\n").map((line) => `  ${line}`);
}

function waitView(params: Record<string, unknown>, result: WaitResult): string {
  const attention = new Set(result.attention);
  const wanted = (id: string) => attention.has(id);
  const lines: string[] = [];
  const busyTasks = result.tasks.filter((task) => !wanted(task.id) && !taskRests(task));
  const busyWaves = result.waves.filter((wave) => !wanted(wave.id) && !waveRests(wave));
  if (result.timedOut) {
    const timeout = typeof params.timeoutMs === "number" ? params.timeoutMs : 600_000;
    lines.push(`timed out after ${duration(timeout)}`);
  }
  if (attention.size > 0) {
    lines.push("attention:");
    for (const wave of result.waves.filter((view) => wanted(view.id))) lines.push(...indentBlock(waveBlock(wave)));
    for (const task of result.tasks.filter((view) => wanted(view.id))) lines.push(...indentBlock(taskBlock(task)));
  }
  const working = stillWorking(busyTasks, busyWaves);
  if (working !== null) lines.push(working);
  if (attention.size === 0 && !result.timedOut) {
    // Everything rests: one line each, the tasks of a shown wave inside its line.
    const shownWaves = new Set(result.waves.map((wave) => wave.id));
    for (const wave of result.waves) {
      lines.push(fields(waveHeader(wave), wave.merge ? `${short(wave.merge.from)}..${short(wave.merge.to)}` : null));
    }
    for (const task of result.tasks.filter((view) => view.wave === null || !shownWaves.has(view.wave))) lines.push(taskLine(task));
    if (lines.length === 0) lines.push("nothing to wait for");
  }
  return lines.join("\n");
}

// ---- timelines (programs read them; the agent's tools do not offer them) ----

/** The primitive fields of an entry, no timestamps, cut to one line. */
function entryText(kind: string, data: Record<string, unknown>): string {
  if ((kind === "coder" || kind === "user") && typeof data.text === "string") {
    const first = data.text.trim().split("\n")[0] ?? "";
    return `${kind}: ${first.length > TIMELINE_TEXT_CHARS ? `${first.slice(0, TIMELINE_TEXT_CHARS)}...` : first}`;
  }
  const parts = Object.entries(data)
    .filter(([key, value]) => key !== "at" && key !== "kind" && !/session|path|dir|log|request|createdAt|timestamp/i.test(key) && (typeof value !== "string" || !ISO_TIME.test(value)))
    .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
    .map(([key, value]) => `${key}=${String(value).split("\n")[0]}`);
  const text = fields(kind, parts.join(" "));
  return text.length > TIMELINE_TEXT_CHARS ? `${text.slice(0, TIMELINE_TEXT_CHARS)}...` : text;
}

function timelineView(entries: { kind: string; data?: object }[], next: number, read: (entry: { kind: string; data?: object }) => Record<string, unknown>): string {
  const lines = entries.map((entry) => entryText(entry.kind, read(entry)));
  lines.push(`${entries.length} ${entries.length === 1 ? "entry" : "entries"} · since: ${next} for the next ones`);
  return lines.join("\n");
}

// ---- settings and config ----

type SettingsAnswer = { stored: Record<string, unknown>; resolved: Record<string, unknown>; defaults: Record<string, unknown> };

/** `key: value`, `models.coder: x`; `(default)` after a value not stored. */
function settingsLines(answer: SettingsAnswer, only?: Set<string>): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(answer.resolved)) {
    if (only !== undefined && !only.has(key)) continue;
    if (value !== null && typeof value === "object") {
      const stored = (answer.stored[key] ?? {}) as Record<string, unknown>;
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) lines.push(`${key}: none${key in answer.stored ? "" : " (default)"}`);
      for (const [inner, innerValue] of entries) {
        // `big` only repeats `coder` (its alias).
        if (key === "models" && inner === "big") continue;
        lines.push(`${key}.${inner}: ${String(innerValue)}${inner in stored ? "" : " (default)"}`);
      }
      continue;
    }
    lines.push(`${key}: ${String(value)}${key in answer.stored ? "" : " (default)"}`);
  }
  return lines;
}

// ---- the actions ----

type Params = Record<string, unknown>;
type Renderer = (params: Params, result: never) => string;

const RENDERERS: Record<string, Renderer> = {
  "models.get": (_params, result: { models: string[] }) => (result.models.length === 0 ? "no models set (models.set)" : result.models.join("\n")),
  "models.set": (_params, result: { models: string[] }) => `${plural(result.models.length, "model")} set`,

  "repos.list": (_params, result: { repos: string[] }) => (result.repos.length === 0 ? "no repositories registered (repos.add)" : result.repos.join("\n")),
  "repos.add": (_params, result: { repo: string }) => `registered ${result.repo}`,
  "repos.remove": (params) => `unregistered ${String(params.repo)}`,
  "branches.list": (_params, result: { branches: { name: string; default: boolean; hasConfig: boolean }[] }) =>
    result.branches.length === 0
      ? "no branches"
      : result.branches
          .map((branch) => {
            const marks = [branch.default ? "default" : null, branch.hasConfig ? "factory.yaml" : null].filter((mark) => mark !== null);
            return marks.length === 0 ? branch.name : `${branch.name} (${marks.join(", ")})`;
          })
          .join(" · "),

  "settings.get": (_params, result: SettingsAnswer) => settingsLines(result).join("\n"),
  "settings.set": (params, result: SettingsAnswer) => {
    const changed = new Set(Object.keys((params.settings ?? {}) as Params));
    const lines = settingsLines(result, changed);
    return lines.length === 0 ? "settings set: every value is the default" : ["settings set:", ...lines.map((line) => `  ${line}`)].join("\n");
  },
  "config.get": (params, result: { exists: boolean; text: string | null; draft: string | null; source: string[] }) => {
    if (result.exists) {
      const where = typeof params.branch === "string" ? `committed on ${params.branch}` : "working copy";
      return `factory.yaml (${where})\n${(result.text ?? "").trimEnd()}`;
    }
    const from = result.source.length > 0 ? `, a draft from ${result.source.join(", ")}` : ", a draft";
    return `no factory.yaml${from}:\n${(result.draft ?? "").trimEnd()}`;
  },
  "config.write": () => "wrote factory.yaml (not committed)",

  "tasks.list": (_params, result: { tasks: TaskView[] }) => taskList(result.tasks),
  "tasks.get": (_params, result: unknown) => taskBlock(asTask(result)),
  "tasks.import": (_params, result: unknown) => `imported ${taskHeader(asTask(result))}`,
  "tasks.timeline": (_params, result: { entries: { kind: string; data: object }[]; next: number }) =>
    timelineView(result.entries, result.next, (entry) => (entry.data ?? {}) as Record<string, unknown>),
  "tasks.diff": (_params, result: { files: { path: string; added: number; removed: number }[] }) => {
    if (result.files.length === 0) return "no changes";
    const added = result.files.reduce((sum, file) => sum + file.added, 0);
    const removed = result.files.reduce((sum, file) => sum + file.removed, 0);
    return [`${plural(result.files.length, "file")}  +${added} -${removed}`, ...result.files.map((file) => `  +${file.added} -${file.removed}  ${file.path}`)].join("\n");
  },
  "tasks.start": (_params, result: unknown) => {
    const task = asTask(result);
    return fields(`started task ${short(task.id)}`, taskState(task), task.tag);
  },
  "tasks.wait": (params, result: WaitResult) => waitView(params, result),
  "tasks.approve": (_params, result: unknown) => taskHeader(asTask(result)),
  "tasks.retry": (_params, result: unknown) => taskHeader(asTask(result)),
  "tasks.cancel": (_params, result: unknown) => taskHeader(asTask(result)),
  "tasks.remove": (_params, result: { removed: string; dropped: string | null }) =>
    [`removed task ${short(result.removed)}`, ...(result.dropped ? [`dropped: ${result.dropped}`] : [])].join(" · "),
  "tasks.message": (_params, result: unknown) => {
    const task = asTask(result);
    return fields(`sent to task ${short(task.id)}`, taskState(task), task.round === null ? null : `round ${task.round}`);
  },

  "waves.start": (_params, result: { wave: WaveView }) => {
    const wave = result.wave;
    const started = wave.tasks.filter((task) => task.taskId !== null).map((task) => task.key);
    const waiting = wave.tasks.filter((task) => task.taskId === null && task.state === "pending").map((task) => `${task.key} (${task.after.join(", ")})`);
    return waveReceipt("started ", wave, [`started: ${started.join(", ") || "none"}`, ...(waiting.length > 0 ? [`waits: ${waiting.join(", ")}`] : [])]);
  },
  "waves.add": (params, result: { wave: WaveView }) => {
    const wave = result.wave;
    const keys = new Set(Array.isArray(params.tasks) ? params.tasks.map((task) => String((task as Params).key)) : []);
    const added = wave.tasks.filter((task) => keys.has(task.key)).map((task) => `${task.key} ${task.state}`);
    return waveReceipt("", wave, [`added: ${added.join(", ") || "none"}`]);
  },
  "waves.get": (_params, result: { wave: WaveView }) => waveBlock(result.wave),
  "waves.list": (_params, result: { waves: WaveView[] }) => waveList(result.waves),
  "waves.timeline": (_params, result: { events: ({ kind: string } & Record<string, unknown>)[]; next: number }) =>
    timelineView(result.events, result.next, (event) => event as Record<string, unknown>),
  "waves.retry": (_params, result: { wave: WaveView }) => waveReceipt("", result.wave),
  "waves.approve": (_params, result: { wave: WaveView }) => waveReceipt("", result.wave),
  "waves.cancel": (_params, result: { wave: WaveView }) => waveReceipt("", result.wave),
  "waves.remove": (_params, result: { removed: string }) => `removed wave ${short(result.removed)}`,
};

/** Whether `agentView` renders `action`. */
export function hasAgentView(action: string): boolean {
  return Object.hasOwn(RENDERERS, action);
}

/** The full view `result` of `action` called with `params`, as the agent's text lines. Throws for an unknown action. */
export function agentView(action: string, params: unknown, result: unknown): string {
  if (!hasAgentView(action)) throw new Error(`no agent view for ${action}`);
  const given = params !== null && typeof params === "object" ? (params as Params) : {};
  return scrub(RENDERERS[action](given, result as never), action.startsWith("repos."));
}

// ---- errors ----

function wayOut(error: { code: string; message: string; detail?: { force?: boolean } }): string {
  const message = error.message.toLowerCase();
  switch (error.code) {
    case "invalid":
      return "fix the params (factory actions {name} lists them)";
    case "not_found":
      if (/registered|git repository|repositor/.test(message)) return "repos.list";
      if (/branch/.test(message)) return "branches.list";
      if (/model/.test(message)) return "models.get";
      if (/wave/.test(message)) return "waves.list";
      return "tasks.list";
    case "busy":
      return "try again once it rests (tasks.wait)";
    case "refused":
      if (error.detail?.force === true) return "the same call with force: true drops it";
      return /\bwave\b/.test(message) ? "waves.get shows the actions valid now" : "tasks.get shows the actions valid now";
    default:
      return "tell the user: the factory failed";
  }
}

/** An error as one line: `code: message · next: the way out`. */
export function agentError(error: { code: string; message: string; detail?: { force?: boolean } }): string {
  return scrub(`${error.code}: ${error.message.replace(/\s*\n\s*/g, " ")} · next: ${wayOut(error)}`);
}

// ---- the action list ----

type Schema = Record<string, unknown>;

/** `{repo, title, request, tag?}`: the required params first, the optional ones with `?`. */
function paramSignature(spec: ActionSpec): string {
  const names = Object.keys(spec.params.properties).map((key) => (spec.params.required.includes(key) ? key : `${key}?`));
  return `{${names.join(", ")}}`;
}

function schemaType(schema: Schema): string {
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  const type = String(schema.type ?? "any");
  if (type === "array" && schema.items !== null && typeof schema.items === "object") return `${schemaType(schema.items as Schema)}[]`;
  return type;
}

function schemaLines(properties: Record<string, Schema>, required: readonly string[], indent: string): string[] {
  const lines: string[] = [];
  for (const [key, schema] of Object.entries(properties)) {
    const bounds = [typeof schema.minimum === "number" ? `min ${schema.minimum}` : null, typeof schema.maximum === "number" ? `max ${schema.maximum}` : null].filter(
      (bound) => bound !== null,
    );
    const head = `${indent}${key}${required.includes(key) ? "" : "?"}: ${schemaType(schema)}${bounds.length > 0 ? ` (${bounds.join(", ")})` : ""}`;
    lines.push(typeof schema.description === "string" ? `${head} - ${schema.description}` : head);
    const nested = (schema.type === "array" ? schema.items : schema) as Schema | undefined;
    if (nested && typeof nested.properties === "object" && nested.properties !== null) {
      const inner = Array.isArray(nested.required) ? (nested.required as string[]) : [];
      lines.push(...schemaLines(nested.properties as Record<string, Schema>, inner, `${indent}  `));
    }
  }
  return lines;
}

/**
 * The action list, one line per action: `name {params} - summary`. With `name`: that action's summary and every param
 * in full (type, bounds, description, nested fields).
 */
export function agentActions(actions: Record<string, ActionSpec>, name?: string): string {
  if (name === undefined) return Object.entries(actions).map(([action, spec]) => `${action} ${paramSignature(spec)} - ${spec.summary}`).join("\n");
  const spec = Object.hasOwn(actions, name) ? actions[name] : undefined;
  if (spec === undefined) return agentError({ code: "not_found", message: `no action ${name}` }).replace(/next: .*$/, "next: factory actions lists them");
  const params = schemaLines(spec.params.properties, spec.params.required, "  ");
  return [`${name} ${paramSignature(spec)} - ${spec.summary}${spec.mutates ? "" : " (reads only)"}`, ...(params.length > 0 ? params : ["  no params"])].join("\n");
}
