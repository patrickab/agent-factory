/**
 * Cards: the one view model of every factory event. A surface (Pi's TUI, gigachad-bot) renders a card as it is and
 * never computes one; the agent reads the same card as text (`cardText`). Pure: no I/O, no Pi import.
 * - `present`: a card that cannot be built is a quiet one titled `fallback`, never a failure: an action that happened
 *   must not be reported as failed
 * - Tone `attention` only for what needs a ruling; everything else is `quiet`
 * - Cost is in cents. A card has no undefined field and no empty list: it survives a JSON round trip unchanged
 */
import { plural, scrub } from "./agent-view.ts";
import type { TaskView } from "./core-tasks.ts";
import type { ProofView } from "./gates-prove.ts";
import type { ScoutView } from "./scouts.ts";
import type { Finding, MinorFinding } from "./state.ts";
import { dollars, short } from "./util.ts";
import type { WaveUpdate, WaveView } from "./waves.ts";

export type CardKind = "wave" | "task" | "scout" | "proof" | "contract" | "decision" | "action";
export type CardTone = "attention" | "quiet";
export type CardRow = { label: string; text: string };
export type CardFinding = { severity: "blocker" | "major" | "minor"; file?: string; line?: number; text: string };

/** Version 1 (contract `cards`). A renderer ignores fields it does not know. */
export interface FactoryCard {
  v: 1;
  kind: CardKind;
  tone: CardTone;
  /** One line, no `factory:` prefix. */
  title: string;
  /** The wave's tag, on every card of a wave or of its tasks. */
  tag?: string;
  /** The short id of the wave, task, scout or proof. */
  id?: string;
  state?: string;
  /** Cents. */
  cost?: number;
  progress?: { done: number; total: number };
  rows?: CardRow[];
  findings?: CardFinding[];
  /** Markdown: the question, the message sent, a report, a brief. */
  text?: string;
  /** The notice key of the card this one answers (a decision). */
  answers?: string;
}

type Draft = Omit<FactoryCard, "v" | "kind" | "tone" | "title"> & { kind?: CardKind; tone?: CardTone; title?: string };

/** The card with no undefined field, no empty list and no empty text. */
export function card(kind: CardKind, tone: CardTone, title: string, draft: Draft = {}): FactoryCard {
  const out: Record<string, unknown> = { v: 1, kind, tone, title };
  for (const [key, value] of Object.entries(draft)) {
    if (key === "v" || key === "kind" || key === "tone" || key === "title") continue;
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  // SAFETY: out holds v, kind, tone and title, and only Draft fields besides: a FactoryCard.
  return out as unknown as FactoryCard;
}

function cents(usage: { cost: number } | null | undefined): number | undefined {
  return usage ? Math.round(usage.cost * 100) : undefined;
}

/** `text` as a fenced block (output, logs): code, never markdown. */
export function fenced(text: string | null | undefined, lang = ""): string | undefined {
  if (text === null || text === undefined || text.trim() === "") return undefined;
  return `\`\`\`${lang}\n${text.trimEnd()}\n\`\`\``;
}

const row = (label: string, text: string | null | undefined | false): CardRow[] => (typeof text === "string" && text !== "" ? [{ label, text }] : []);

/** The actions valid now, the last row of a card an agent acts on. */
const next = (actions: readonly string[]): CardRow => ({ label: "next", text: actions.length === 0 ? "none, it runs" : actions.join(", ") });

/** Lines of a failure or a gate's output shown: its first line (what failed), then the last ones of the rest. */
const TAIL_LINES = 20;
function tail(text: string): string {
  const [first, ...rest] = text.trimEnd().split("\n");
  return [first, ...rest.slice(-TAIL_LINES)].join("\n");
}

/** The blocker and major `findings`, then every minor one stored with the review (and the wave's task) that found it. */
function findingsOf(findings: readonly Finding[], minors: readonly MinorFinding[] = []): CardFinding[] {
  const minor = minors.map((found) => ({ ...found, severity: "minor" as const, text: `${found.text} (${found.task === undefined ? "" : `task ${found.task}, `}review ${found.round})` }));
  return [...findings.filter((finding) => finding.severity !== "minor"), ...minor].map(({ severity, file, line, text }) => ({
    severity: severity as CardFinding["severity"],
    text,
    ...(file === "" ? {} : { file }),
    ...(line === null ? {} : { line }),
  }));
}

export function taskState(task: TaskView): string {
  return task.interrupted ? "interrupted" : (task.state ?? "starting");
}

/** A task: its id, tag, state, cost and every fact of its state; the question, the failure or the coder's last message as text. */
export function taskCard(task: TaskView, title: string, tone: CardTone = "quiet", kind: CardKind = "task"): FactoryCard {
  const asked = task.state === "waiting_answer" && !task.interrupted;
  const review = task.review !== null && !task.review.approved ? task.review : null;
  return card(kind, tone, title, {
    tag: task.tag,
    id: short(task.id),
    state: taskState(task),
    cost: cents(task.usage),
    rows: [
      ...row("task", task.title),
      ...row("wave", task.wave !== null && short(task.wave)),
      ...row("round", task.round === null ? null : String(task.round)),
      ...row("interrupted", task.interrupted && `${task.state}, no runner lives`),
      ...row("why", task.state === "blocked" || task.state === "done" || task.state === "cancelled" ? task.reason : null),
      ...row("review", review !== null && `${review.round}: ${review.status === "ok" ? "rejected" : `failed (${review.status})`}`),
      ...row("merged", task.merged !== null && short(task.merged)),
      ...row("slot", task.waitingForSlot && "waits for a test slot"),
      ...row("flaky", task.flaky.join(", ")),
      next(task.actions.map((action) => (action === "tasks.message" && asked ? "tasks.message (answers it)" : action))),
    ],
    findings: findingsOf(review?.findings ?? [], task.minors),
    text: asked ? (task.question ?? "(the question is not recorded)") : task.state === "blocked" && task.failure !== null ? fenced(tail(task.failure)) : (task.lastMessage ?? undefined),
  });
}

/** The pending tasks that never can start: a task they wait for, directly or through others, is cancelled. */
export function unreachableTasks(tasks: WaveView["tasks"]): string[] {
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

export function waveState(view: WaveView): string {
  if (view.interrupted) return "interrupted";
  if (view.stage === "queued" && view.stuck) return "queued: can never start";
  return view.stage;
}

/** `docs (request), wave (title)`: what `tasks.update` and `waves.update` changed, each once, last change last. */
function updated(updates: readonly WaveUpdate[]): string {
  const changed = new Map<string, Set<string>>();
  for (const update of updates) {
    const name = update.key ?? "wave";
    const fields = changed.get(name) ?? new Set<string>();
    changed.delete(name);
    for (const field of update.fields) fields.add(field);
    changed.set(name, fields);
  }
  return [...changed].map(([name, fields]) => `${name} (${[...fields].join(", ")})`).join(", ");
}

/** A wave: tag, id, stage, cost, progress, every fact of its stage, its tasks with their ids; the open findings. */
export function waveCard(view: WaveView, title: string, tone: CardTone = "quiet", kind: CardKind = "wave"): FactoryCard {
  const last = view.reviews.at(-1);
  const multiline = view.detail !== null && view.detail.includes("\n");
  const failedGate = view.stage === "blocked" && view.reason === "gates" ? view.gates.findLast((gate) => !gate.passed) : undefined;
  return card(kind, tone, title, {
    tag: view.tag,
    id: short(view.id),
    state: waveState(view),
    cost: cents(view.usage),
    progress: { done: view.counts.done, total: view.counts.total },
    rows: [
      ...row("wave", view.title),
      ...row("interrupted", view.interrupted && `${view.stage}, no runner lives`),
      ...row("why", [view.reason, multiline ? null : view.detail].filter((part) => part !== null).join(": ")),
      ...row("waits for", view.stage === "queued" && view.after.map(short).join(", ")),
      ...row("can never start", view.stage === "building" && unreachableTasks(view.tasks).join(", ")),
      ...row("tasks", view.tasks.map((task) => `${task.key} ${task.state} (${short(task.id)})`).join(", ")),
      ...row("review", view.stage === "reviewing" ? `${view.reviews.length + 1} runs` : last && `${last.round}: ${last.verdict}${last.verdict === "failed" ? ` (${last.status})` : ""}`),
      ...row("gates failed", failedGate?.phase),
      ...row("merged", view.merge !== null && `${short(view.merge.from)}..${short(view.merge.to)} into ${view.target}`),
      ...row("history", view.merge?.ref !== undefined && `${view.merge.ref} (${plural(view.merge.commits ?? 0, "commit")})`),
      ...row("slot", view.waitingForSlot && "waits for a test slot"),
      ...row("flaky", [...new Set(view.gates.flatMap((gate) => gate.flaky ?? []))].join(", ")),
      ...row("updated", updated(view.updates)),
      ...(view.feedback ?? []).map((entry) => ({
        label: `feedback ${entry.kind}`,
        text: [`${entry.role}, ${entry.task === null ? "the wave" : `task ${short(entry.task)}`}: ${entry.what}`, entry.cost && `cost: ${entry.cost}`, entry.suggestion && `suggestion: ${entry.suggestion}`].filter(Boolean).join(" · "),
      })),
      next(view.actions),
    ],
    findings: findingsOf(last?.findings ?? [], view.minors),
    text: [multiline ? fenced(view.detail) : undefined, failedGate && (fenced(tail(failedGate.log ?? "")) ?? "no output")].filter(Boolean).join("\n\n"),
  });
}

/** A scout: id, state, cost, concern; the report as text, else what it wrote so far. */
export function scoutCard(scout: ScoutView, title: string, tone: CardTone = "quiet"): FactoryCard {
  return card("scout", tone, title, {
    id: short(scout.id),
    state: scout.interrupted ? "interrupted" : scout.state,
    cost: cents(scout.usage),
    rows: [
      ...row("concern", scout.concern),
      ...(scout.questions ?? []).flatMap((question) => row("question", question)),
      ...row("error", scout.error),
      ...row("report", scout.reportPath),
      ...row("written", scout.report === null && (scout.written.join(", ") || "nothing yet")),
    ],
    text: scout.report?.trimEnd(),
  });
}

/** A gate proof: id, state, branch and commit, each step; the failing step's tail as text. */
export function proofCard(proof: ProofView, title: string, tone: CardTone = "quiet"): FactoryCard {
  const runs = proof.state === "running" && !proof.interrupted;
  return card("proof", tone, title, {
    id: short(proof.id),
    state: proof.interrupted ? "interrupted" : proof.state,
    rows: [
      ...row("branch", `${proof.branch} at ${short(proof.commit)}`),
      ...proof.steps.map((step) => ({ label: step.passed ? "passed" : "failed", text: step.command })),
      ...row("flaky", proof.flaky.join(", ")),
      ...row("failing", proof.failing?.step),
      ...row("log", proof.failing?.log),
      { label: "next", text: runs ? "none, it runs (tasks.wait {ids})" : proof.state === "failing" || proof.interrupted ? "fix the branch, then gates.prove again" : "waves.start on it" },
    ],
    text: proof.failing === null ? undefined : (fenced(tail(proof.failing.tail)) ?? "no output"),
  });
}

/** `contracts.apply` changed a contract the wave's done tasks worked by. */
export function contractCard(view: WaveView, name: string, paths: readonly string[], done: readonly string[]): FactoryCard {
  return card("contract", "quiet", `contract ${name} changed`, {
    tag: view.tag,
    id: short(view.id),
    rows: [...row("changed", paths.join(", ")), ...row("done tasks", done.join(", ")), { label: "next", text: "the done tasks may need a follow-up task" }],
  });
}

/** A supervisor's action on a card's subject as a decision: no findings, `text` what was sent or changed, `rows` (given) instead of the subject's. */
export function decision(subject: FactoryCard, title: string, text?: string, rows?: CardRow[]): FactoryCard {
  const { findings: _findings, text: _text, ...rest } = subject;
  return card("decision", "quiet", title, { ...rest, text, ...(rows === undefined ? {} : { rows }) });
}

/** `text` under `label`, every continuation line indented as deep as the first. */
function labelled(label: string, text: string): string[] {
  const [first, ...rest] = text.trimEnd().split("\n");
  return [`  ${label}: ${first}`, ...rest.map((line) => `    ${line}`)];
}

/**
 * A card as the agent reads it: one header line (title, the id when the title lacks it, state, progress, tag, cost),
 * `label: text` per row, one line per finding, the text as it is (a report is read whole), then `next:`.
 */
export function cardText(built: FactoryCard): string {
  const { title, id, state, progress, tag, cost, rows = [], findings = [], text } = built;
  const head = [title, id !== undefined && !title.includes(id) && `id ${id}`, state, progress && `${progress.done}/${progress.total} done`, tag !== undefined && !title.includes(tag) && tag, cost !== undefined && dollars(cost / 100)];
  const lines = [head.filter((part) => typeof part === "string" && part !== "").join("  ")];
  for (const { label, text: value } of rows) if (label !== "next") lines.push(...labelled(label, value));
  for (const finding of findings) {
    const where = finding.file === undefined ? "" : finding.line === undefined ? `${finding.file}  ` : `${finding.file}:${finding.line}  `;
    lines.push(`  ${finding.severity}  ${where}${finding.text.replace(/\s*\n\s*/g, " ")}`);
  }
  if (text !== undefined) lines.push(text.trimEnd());
  for (const { label, text: value } of rows) if (label === "next") lines.push(`  next: ${value}`);
  return lines.join("\n");
}

/**
 * The card `build` makes (the first of several: the others are its subjects, `tasks.wait`'s) and the agent's text of
 * them, scrubbed (`keepPaths`: see `scrub`). A build that throws is a quiet card titled `fallback`, and that its text.
 * The text leaves out the card's text and rows that are one of `sent` (the request or message the agent sent): the card
 * shows it to people, the agent holds it already.
 */
export function present(build: () => FactoryCard | FactoryCard[], fallback: string, keepPaths = false, sent: unknown[] = []): { card: FactoryCard; text: string } {
  try {
    const [first, ...more] = [build()].flat();
    const receipt = { ...first, text: sent.includes(first.text) ? undefined : first.text, rows: first.rows?.filter((row) => !sent.includes(row.text)) };
    const nested = more.map((subject) => cardText(subject).replace(/^/gm, "  "));
    return { card: first, text: scrub([cardText(receipt), ...nested].join("\n"), keepPaths) };
  } catch {
    return { card: card("action", "quiet", fallback), text: fallback };
  }
}
