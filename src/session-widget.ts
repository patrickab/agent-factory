/**
 * The waves a Pi session declared, as the lines of the widget above its editor (`pi/index.ts`). Pure: no I/O.
 *
 * - Header: `Factory · <n> active[ · <m> needs you][ · <k> cards to rule on]` and the active waves' cost; with no
 *   active wave `Factory · <n> finished`. No waves and no card to rule on: no lines (the widget goes)
 * - Cards to rule on (`cardsToRule`): the session's attention notices that no later notice of the same task, wave,
 *   scout or proof replaced and no later decision answered
 * - Active (not `merged`, not `cancelled`): those that need the supervisor first (`WaveView.attention`), then newest
 *   first. A queued wave that can still start shows `queued`
 * - Finished: one line `<n> finished` while closed; open (`showFinished`), that line carries their cost and every
 *   finished wave follows, newest first
 * - A row: mark, tag, title, done/total, state, cost. Only the title gives way to the width. Tag and title go through
 *   the agent view's `scrub` (no paths, no long ids)
 */
import { scrub } from "./agent-view.ts";
import { WAVE_FINAL_STAGES } from "./core-tasks.ts";
import { dollars } from "./util.ts";
import type { WaveView } from "./waves.ts";

export interface SessionWidgetOptions {
  showFinished: boolean;
  /** Columns available: no line is longer. */
  width: number;
  /** The count of cards waiting for a ruling (`cardsToRule`). */
  rulings?: number;
}

/** The subject of a notice key: `task:<id>`, `wave:<id>`, `scout:<id>`, `proof:<id>`. */
function subject(key: string): string {
  return key.split(":").slice(0, 2).join(":");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** Notice events of a wave beside its stage (`notify.ts`): contract changes and the reviewer's notes and fix tasks. */
const QUIET_SIDE_EVENTS: readonly string[] = ["contract", "note", "fix"];

/**
 * The count of a session branch's cards waiting for a ruling: per subject the latest `factory-notice`, when its card's
 * tone is `attention` (a quiet contract, reviewer note or fix-task notice replaces none) and no `factory` tool result after it carries a decision card that answers that subject.
 */
export function cardsToRule(branch: Iterable<unknown>): number {
  const open = new Map<string, boolean>();
  for (const entry of branch) {
    const item = record(entry);
    if (item?.type === "custom_message" && item.customType === "factory-notice") {
      const details = record(item.details);
      const card = record(details?.card);
      if (typeof details?.key !== "string" || card === undefined) continue;
      // a quiet contract, reviewer note or fix-task notice (`wave:<id>:<contract|note|fix>:<n>`) says nothing of the
      // wave's stage: it keeps an open entry
      if (card.tone !== "attention" && QUIET_SIDE_EVENTS.includes(details.key.split(":")[2] ?? "")) continue;
      open.set(subject(details.key), card.tone === "attention");
      continue;
    }
    const message = record(item?.message);
    if (item?.type !== "message" || message?.role !== "toolResult" || message.toolName !== "factory") continue;
    const answers = record(record(message.details)?.card)?.answers;
    if (typeof answers === "string") open.delete(subject(answers));
  }
  return [...open.values()].filter(Boolean).length;
}

const ELLIPSIS = "…";

function state(view: WaveView): string {
  if (view.interrupted) return "interrupted";
  if (view.stuck) return "stuck";
  return view.stage;
}

function mark(view: WaveView): string {
  if (view.stage === "merged") return "✓";
  if (view.stage === "cancelled") return "✗";
  return view.attention ? "!" : "◐";
}

function money(cost: number | null): string {
  return cost === null ? "" : dollars(cost);
}

function totalCost(views: readonly WaveView[]): number | null {
  const costs = views.flatMap((view) => (view.usage === null ? [] : [view.usage.cost]));
  return costs.length === 0 ? null : costs.reduce((sum, cost) => sum + cost, 0);
}

/** Columns, counted per code point: every character the widget draws is one column wide. */
function columns(text: string): number {
  return Array.from(text).length;
}

function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  const chars = Array.from(text);
  return chars.length <= width ? text : `${chars.slice(0, width - 1).join("")}${ELLIPSIS}`;
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - columns(text)));
}

/** `left` and `right` at the two ends of the line; the left side gives way when both do not fit. */
function spread(left: string, right: string, width: number): string {
  if (right === "") return truncate(left, width);
  const room = width - columns(right) - 1;
  if (room <= 0) return truncate(right, width);
  const head = truncate(left, room);
  return `${head}${" ".repeat(width - columns(head) - columns(right))}${right}`;
}

function newestFirst(a: WaveView, b: WaveView): number {
  return b.createdAt.localeCompare(a.createdAt);
}

/** The rows of `views`, their fixed columns as wide as the widest of them; the title takes what is left. */
function rows(views: readonly WaveView[], width: number): string[] {
  const cells = views.map((view) => ({
    mark: mark(view),
    tag: scrub(view.tag),
    title: scrub(view.title.replace(/\s+/g, " ").trim()),
    count: `${view.counts.done}/${view.counts.total}`,
    state: state(view),
    cost: money(view.usage?.cost ?? null),
  }));
  const widest = (pick: (cell: (typeof cells)[number]) => string) => Math.max(0, ...cells.map((cell) => columns(pick(cell))));
  const tag = widest((cell) => cell.tag);
  const count = widest((cell) => cell.count);
  const stateWidth = widest((cell) => cell.state);
  const cost = widest((cell) => cell.cost);
  // ` ! <tag>  <title>  <count> <state>  <cost>`
  const fixed = 3 + tag + 2 + 2 + count + 1 + stateWidth + (cost > 0 ? 2 + cost : 0);
  const titleWidth = Math.max(0, width - fixed);
  return cells.map((cell) => {
    const right = `${pad(cell.count, count)} ${pad(cell.state, stateWidth)}${cost > 0 ? `  ${" ".repeat(cost - columns(cell.cost))}${cell.cost}` : ""}`;
    const line = ` ${cell.mark} ${pad(cell.tag, tag)}  ${pad(truncate(cell.title, titleWidth), titleWidth)}  ${right}`;
    return truncate(line.trimEnd(), width);
  });
}

export function sessionWidget(waves: readonly WaveView[], { showFinished, width, rulings = 0 }: SessionWidgetOptions): string[] {
  const toRule = rulings > 0 ? ` · ${rulings} ${rulings === 1 ? "card" : "cards"} to rule on` : "";
  if (waves.length === 0) return toRule === "" ? [] : [truncate(`Factory${toRule}`, width)];
  const active = waves.filter((view) => !WAVE_FINAL_STAGES.includes(view.stage));
  const finished = waves.filter((view) => WAVE_FINAL_STAGES.includes(view.stage)).sort(newestFirst);
  active.sort((a, b) => Number(b.attention) - Number(a.attention) || newestFirst(a, b));
  const finishedCost = showFinished ? money(totalCost(finished)) : "";
  if (active.length === 0) {
    return [spread(`Factory · ${finished.length} finished${toRule}`, finishedCost, width), ...(showFinished ? rows(finished, width) : [])];
  }
  const waiting = active.filter((view) => view.attention).length;
  const header = `Factory · ${active.length} active${waiting > 0 ? ` · ${waiting} needs you` : ""}${toRule}`;
  const lines = [spread(header, money(totalCost(active)), width), ...rows(active, width)];
  if (finished.length === 0) return lines;
  lines.push(spread(` ${finished.length} finished`, finishedCost, width));
  if (showFinished) lines.push(...rows(finished, width));
  return lines;
}
