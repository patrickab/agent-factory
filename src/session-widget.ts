/**
 * The waves a Pi session declared, as the lines of the widget above its editor (`pi/index.ts`). Pure: no I/O.
 *
 * - Header: `Factory · <n> active[ · <m> needs you]` and the active waves' cost; with no active wave
 *   `Factory · <n> finished`. No waves: no lines (the widget goes)
 * - Active (not `merged`, not `cancelled`): those that need the supervisor first (`rejected`, `blocked`,
 *   `waiting_approve`, interrupted, building with tasks that can never start, whether a runner lives or not), then
 *   newest first
 * - Finished: one line `<n> finished` while closed; open (`showFinished`), that line carries their cost and every
 *   finished wave follows, newest first
 * - A row: mark, tag, title, done/total, state, cost. Only the title gives way to the width. Tag and title go through
 *   the agent view's `scrub` (no paths, no long ids)
 */
import { scrub, unreachableTasks } from "./agent-view.ts";
import type { WaveView } from "./waves.ts";

export interface SessionWidgetOptions {
  showFinished: boolean;
  /** Columns available: no line is longer. */
  width: number;
}

const FINISHED_STAGES: readonly string[] = ["merged", "cancelled"];
const ATTENTION_STAGES: readonly string[] = ["rejected", "blocked", "waiting_approve"];
const ELLIPSIS = "…";

/** Building with tasks that can never start: the agent view's and `tasks.wait`'s notion, whatever `running` says. */
function stuck(view: WaveView): boolean {
  return view.stage === "building" && unreachableTasks(view.tasks).length > 0;
}

function needsYou(view: WaveView): boolean {
  return view.interrupted || ATTENTION_STAGES.includes(view.stage) || stuck(view);
}

function state(view: WaveView): string {
  if (view.interrupted) return "interrupted";
  if (stuck(view)) return "stuck";
  return view.stage;
}

function mark(view: WaveView): string {
  if (view.stage === "merged") return "✓";
  if (view.stage === "cancelled") return "✗";
  return needsYou(view) ? "!" : "◐";
}

function money(cost: number | null): string {
  return cost === null ? "" : `$${cost.toFixed(2)}`;
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

export function sessionWidget(waves: readonly WaveView[], { showFinished, width }: SessionWidgetOptions): string[] {
  if (waves.length === 0) return [];
  const active = waves.filter((view) => !FINISHED_STAGES.includes(view.stage));
  const finished = waves.filter((view) => FINISHED_STAGES.includes(view.stage)).sort(newestFirst);
  active.sort((a, b) => Number(needsYou(b)) - Number(needsYou(a)) || newestFirst(a, b));
  const finishedCost = showFinished ? money(totalCost(finished)) : "";
  if (active.length === 0) {
    return [spread(`Factory · ${finished.length} finished`, finishedCost, width), ...(showFinished ? rows(finished, width) : [])];
  }
  const waiting = active.filter(needsYou).length;
  const header = `Factory · ${active.length} active${waiting > 0 ? ` · ${waiting} needs you` : ""}`;
  const lines = [spread(header, money(totalCost(active)), width), ...rows(active, width)];
  if (finished.length === 0) return lines;
  lines.push(spread(` ${finished.length} finished`, finishedCost, width));
  if (showFinished) lines.push(...rows(finished, width));
  return lines;
}
