/**
 * Cards (contract `cards`): the readable form of every factory event, next to the text the agent reads. Pure: no I/O,
 * no Pi import. A surface (Pi's TUI, gigachad-bot) renders a card as it is and never computes one.
 *
 * - A notice carries `details {key, card}` (`notify.ts`, the features' notices); a `factory` tool result carries
 *   `details {result, card}` (`factory-tool.ts`, `pi/tool.ts`)
 * - `taskCard`, `waveCard`, `scoutCard`, `proofCard`, `contractCard`: one view object → one card, with the title and
 *   tone the caller gives
 * - `actionCard(name, params, result, cause?)`: the card of an action's result, from the builder its feature registers
 *   (`feature.ts` `cards`); with a cause (`decisions.ts`) the card is a decision, `answers` the notice key it settles
 * - Tone `attention` only for what needs a ruling: a question, blocked, waiting for approve, interrupted, rejected,
 *   tasks that can never start, failing gates, a wait that ended on attention. Everything else is `quiet`
 * - Cost is in cents. A card has no undefined field and no empty list: it survives a JSON round trip unchanged
 */
import { neverStarts, unreachableTasks } from "./agent-view.ts";
import type { Params } from "./core-shared.ts";
import type { TaskView } from "./core-tasks.ts";
import { FEATURES } from "./features.ts";
import type { ProofView } from "./gates-prove.ts";
import type { ScoutView } from "./scouts.ts";
import type { WaveView } from "./waves.ts";

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

/** A feature's card of one action's result (`feature.ts` `cards`). */
export type CardBuilder = (params: Params, result: never) => FactoryCard;

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

export const shortId = (id: string): string => id.slice(0, 8);

/** Dollars as cents; undefined without a cost. */
export function cents(usage: { cost: number } | null | undefined): number | undefined {
  return usage ? Math.round(usage.cost * 100) : undefined;
}

/** `text` as a fenced block (output, logs): code, never markdown. */
export function fenced(text: string | null | undefined): string | undefined {
  if (text === null || text === undefined || text.trim() === "") return undefined;
  return `\`\`\`\n${text.trimEnd()}\n\`\`\``;
}

const row = (label: string, text: string | null | undefined | false): CardRow[] => (typeof text === "string" && text !== "" ? [{ label, text }] : []);

function findingsOf(findings: readonly { severity: string; file: string; line: number | null; text: string }[]): CardFinding[] {
  return findings.map((finding) => {
    const out: CardFinding = { severity: finding.severity as CardFinding["severity"], text: finding.text };
    if (finding.file !== "") out.file = finding.file;
    if (finding.line !== null) out.line = finding.line;
    return out;
  });
}

export function taskCardState(task: TaskView): string {
  if (task.interrupted) return "interrupted";
  return task.state ?? "starting";
}

/** A task: its id, tag, state, cost, title, round; the question, the failure or the coder's last message as text; an unapproved review's findings. */
export function taskCard(task: TaskView, title: string, tone: CardTone = "quiet", kind: CardKind = "task"): FactoryCard {
  const text = task.state === "waiting_answer" ? (task.question ?? undefined) : task.state === "blocked" ? fenced(task.failure) : (task.lastMessage ?? undefined);
  return card(kind, tone, title, {
    tag: task.tag,
    id: shortId(task.id),
    state: taskCardState(task),
    cost: cents(task.usage),
    rows: [
      ...row("task", task.title),
      ...row("round", task.round === null ? null : String(task.round)),
      ...row("why", task.state === "blocked" ? task.reason : null),
      ...row("merged", task.merged === null ? null : task.merged.slice(0, 7)),
      ...row("flaky", task.flaky.join(", ")),
    ],
    findings: task.review !== null && !task.review.approved ? findingsOf(task.review.findings) : [],
    text,
  });
}

export function waveCardState(view: WaveView): string {
  if (view.interrupted) return "interrupted";
  if (view.stage === "queued" && neverStarts(view)) return "queued: can never start";
  return view.stage;
}

/** A wave: tag, id, stage, cost, task progress, why, merge, the tasks; the last review's findings unless it approved. */
export function waveCard(view: WaveView, title: string, tone: CardTone = "quiet", kind: CardKind = "wave"): FactoryCard {
  const last = view.reviews.at(-1);
  const multiline = view.detail !== null && view.detail.includes("\n");
  const unreachable = view.stage === "building" ? unreachableTasks(view.tasks) : [];
  return card(kind, tone, title, {
    tag: view.tag,
    id: shortId(view.id),
    state: waveCardState(view),
    cost: cents(view.usage),
    progress: { done: view.counts.done, total: view.counts.total },
    rows: [
      ...row("wave", view.title),
      ...row("why", [view.reason, multiline ? null : view.detail].filter((part) => part !== null).join(": ")),
      ...row("waits for", view.stage === "queued" ? view.after.map(shortId).join(", ") : null),
      ...row("can never start", unreachable.join(", ")),
      ...row("merged", view.merge === null ? null : `${view.merge.from.slice(0, 7)}..${view.merge.to.slice(0, 7)} into ${view.target}`),
      ...row("pull request", view.remote?.url),
      ...row("tasks", view.tasks.map((task) => `${task.key} ${task.state}`).join(", ")),
    ],
    findings: last !== undefined && last.verdict !== "approved" ? findingsOf(last.findings) : [],
    text: multiline ? fenced(view.detail) : undefined,
  });
}

export function scoutCardState(scout: ScoutView): string {
  return scout.interrupted ? "interrupted" : scout.state;
}

/** A scout: id, state, cost, concern; the report as text, else what it wrote so far. */
export function scoutCard(scout: ScoutView, title: string, tone: CardTone = "quiet"): FactoryCard {
  return card("scout", tone, title, {
    id: shortId(scout.id),
    state: scoutCardState(scout),
    cost: cents(scout.usage),
    rows: [
      ...row("concern", scout.concern),
      ...(scout.questions ?? []).flatMap((question) => row("question", question)),
      ...row("error", scout.error),
      ...row("report", scout.reportPath),
      ...row("written", scout.report === null ? scout.written.join(", ") || "nothing yet" : null),
    ],
    text: scout.report?.trimEnd(),
  });
}

/** A gate proof: id, state, branch and commit, each step; the failing step's tail as text. */
export function proofCard(proof: ProofView, title: string, tone: CardTone = "quiet"): FactoryCard {
  return card("proof", tone, title, {
    id: shortId(proof.id),
    state: proof.interrupted ? "interrupted" : proof.state,
    rows: [
      ...row("branch", `${proof.branch} at ${proof.commit.slice(0, 7)}`),
      ...proof.steps.map((step) => ({ label: step.passed ? "passed" : "failed", text: step.command })),
      ...row("flaky", proof.flaky.join(", ")),
      ...row("failing", proof.failing?.step),
      ...row("log", proof.failing?.log),
    ],
    text: fenced(proof.failing?.tail),
  });
}

/** `contracts.apply` changed a contract the wave's done tasks worked by. */
export function contractCard(view: WaveView, name: string, paths: readonly string[], done: readonly string[]): FactoryCard {
  return card("contract", "quiet", `contract ${name} changed`, {
    tag: view.tag,
    id: shortId(view.id),
    rows: [...row("changed", paths.join(", ")), ...row("done tasks", done.join(", ")), { label: "next", text: "the done tasks may need a follow-up task" }],
  });
}

/** A supervisor's action on a card's subject as a decision: no findings, `text` what was sent or changed, `rows` (given) instead of the subject's. */
export function decision(subject: FactoryCard, title: string, text?: string, rows?: CardRow[]): FactoryCard {
  const { findings: _findings, text: _text, ...rest } = subject;
  return card("decision", "quiet", title, { ...rest, text, ...(rows === undefined ? {} : { rows }) });
}

/** One row per timeline entry: its kind and time. */
export function timelineCard(title: string, entries: readonly { kind: string; at?: unknown }[], next: number): FactoryCard {
  return card("action", "quiet", title, { rows: [...entries.map((entry) => ({ label: entry.kind, text: typeof entry.at === "string" ? entry.at : "" })), { label: "next", text: String(next) }] });
}

/** `build()`, or a quiet card titled `title` when it throws: a card never stops a notice or an answer. */
export function safeCard(kind: CardKind, title: string, build: () => FactoryCard): FactoryCard {
  try {
    return build();
  } catch {
    return card(kind, "quiet", title);
  }
}

/** The card when an action's card cannot be built: the action's name. */
export function fallbackCard(name: string): FactoryCard {
  return card("action", "quiet", name);
}

/**
 * The card of `name`'s result, from its feature's builder. With a cause (`decisions.ts`) it is a decision, answering
 * the notice key the cause names.
 */
export function actionCard(name: string, params: unknown, result: unknown, cause?: { answers?: string } | null): FactoryCard {
  const builder = FEATURES.flatMap((feature) => (Object.hasOwn(feature.cards ?? {}, name) ? [(feature.cards as Record<string, CardBuilder>)[name]] : []))[0];
  const built = builder === undefined ? fallbackCard(name) : builder((params ?? {}) as Params, result as never);
  if (cause === undefined || cause === null) return built;
  const { answers: _answers, ...rest } = built;
  return cause.answers === undefined ? { ...rest, kind: "decision" } : { ...rest, kind: "decision", answers: cause.answers };
}
