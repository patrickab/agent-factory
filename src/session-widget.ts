/**
 * The waves a Pi session declared, as the tree of the widget above its editor (`pi/index.ts`). Pure: no I/O, no
 * colours (`rowLine` takes the surface's `paint`), no clock (`now` and `frame` are passed in).
 *
 * - Header: `Factory · <cost of all waves> · <n> workers · <n> active[ · <m> needs you][ · <k> cards to rule on]`; with
 *   no active wave `<n> finished` instead of the active count. No waves and no card to rule on: no rows (the widget goes)
 * - Cards to rule on (`cardsToRule`): the session's attention notices that no later notice of the same task, wave,
 *   scout or proof replaced and no later decision answered
 * - Workers: the tasks in `running` and the waves a reviewer runs for
 * - Nesting follows the tags: `plugin/m1/w1` is wave `w1` in group `m1` in group `plugin` (track, milestone, wave). A
 *   group that holds one thing is not drawn: its name joins the label below it. Under a wave: why it needs the
 *   supervisor, then its tasks in declared order
 * - Order in a group: what needs the supervisor first (`WaveView.attention`, or building with tasks that can never start), then oldest first; what is finished (`merged`,
 *   `cancelled`, a group of only those) stands under one `<n> finished` row, newest first
 * - Open by default: groups, and waves that are neither queued nor finished. `toggled` flips single rows (a click),
 *   `depth` opens (`all`) or closes (`none`) every row instead
 * - A row: tree lines, `▸`/`▾` when it has rows below, mark, label, title, then its facts joined by ` · `. Only the
 *   title gives way to the width. Tag and title go through the agent view's `scrub` (no paths, no long ids)
 */
import { scrub } from "./agent-view.ts";
import { unreachableTasks } from "./cards.ts";
import { dollars } from "./util.ts";
import { waveFinal, type WaveView } from "./waves.ts";

export type WidgetTone = "title" | "text" | "muted" | "dim" | "accent" | "success" | "warning" | "error";
export type WidgetMark = "working" | "done" | "cancelled" | "attention" | "waiting";
export type WidgetSpan = { text: string; tone: WidgetTone };
export type WidgetDepth = "default" | "all" | "none";

/** One line of the widget. `id`: what a click toggles (`HEADER_ROW`: the depth), null for a row with nothing below. */
export interface WidgetRow {
  id: string | null;
  /** The tree lines before the row. */
  lead: string;
  open: boolean | null;
  mark: WidgetMark | null;
  label: WidgetSpan;
  title: string;
  facts: WidgetSpan[];
}

export interface SessionWidgetOptions {
  /** The count of cards waiting for a ruling (`cardsToRule`). */
  rulings?: number;
  depth?: WidgetDepth;
  /** The ids of the rows whose open state is the opposite of what `depth` gives them. */
  toggled?: ReadonlySet<string>;
  /** The time the running waves' durations are counted to; without it no duration of a running wave. */
  now?: number;
}

export const HEADER_ROW = "#factory";

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

const ATTENTION_TASK_STATES: readonly string[] = ["blocked", "waiting_answer", "waiting_approve"];
const ELLIPSIS = "…";

/** `WaveView.stuck`, or building with tasks that can never start even while another task still runs: the user sees it early. */
function stuck(view: WaveView): boolean {
  return view.stuck || (view.stage === "building" && unreachableTasks(view.tasks).length > 0);
}

function needsYou(view: WaveView): boolean {
  return view.attention || stuck(view);
}

function finished(view: WaveView): boolean {
  return waveFinal(view.stage);
}

function state(view: WaveView): string {
  if (view.interrupted) return "interrupted";
  if (stuck(view)) return "stuck";
  return view.stage;
}

function waveMark(view: WaveView): WidgetMark {
  if (view.stage === "merged") return "done";
  if (view.stage === "cancelled") return "cancelled";
  if (needsYou(view)) return "attention";
  return view.stage === "queued" ? "waiting" : "working";
}

function taskMark(taskState: string): WidgetMark {
  if (taskState === "done") return "done";
  if (taskState === "cancelled") return "cancelled";
  if (taskState === "pending") return "waiting";
  return ATTENTION_TASK_STATES.includes(taskState) ? "attention" : "working";
}

const MARK_TONE: Record<WidgetMark, WidgetTone> = { working: "accent", done: "success", cancelled: "dim", attention: "warning", waiting: "dim" };

/** The tasks a coder runs for, and the wave itself while its reviewer runs. */
function workers(view: WaveView): number {
  return view.tasks.filter((task) => task.state === "running").length + Number(view.running && view.stage === "reviewing");
}

function money(cost: number | null): string {
  return cost === null ? "" : dollars(cost);
}

function totalCost(views: readonly WaveView[]): number | null {
  const costs = views.flatMap((view) => (view.usage === null ? [] : [view.usage.cost]));
  return costs.length === 0 ? null : costs.reduce((sum, cost) => sum + cost, 0);
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** `42s`, `8m`, `1h05m`. */
function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** How long the wave took until it merged, or has taken until `now` once it started; nothing for a cancelled one. */
function elapsed(view: WaveView, now: number | undefined): string {
  const end = view.merge !== null ? Date.parse(view.merge.at) : finished(view) || view.stage === "queued" ? undefined : now;
  const ms = end === undefined ? Number.NaN : end - Date.parse(view.createdAt);
  return Number.isFinite(ms) && ms >= 0 ? duration(ms) : "";
}

/** Columns, counted per code point: every character the widget draws itself is one column wide. */
function columns(text: string): number {
  return Array.from(text).length;
}

function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  const chars = Array.from(text);
  return chars.length <= width ? text : `${chars.slice(0, width - 1).join("")}${ELLIPSIS}`;
}

function oneLine(text: string): string {
  return scrub(text.replace(/\s+/g, " ").trim());
}

/** A wave, or a group of them under one tag segment. */
type Item = { label: string; id: string; view?: WaveView; items: Item[] };
type Group = { waves: WaveView[]; groups: Map<string, Group> };

function itemsOf(group: Group, path: string): Item[] {
  const items: Item[] = group.waves.map((view) => ({ label: view.tag.split("/").at(-1) ?? view.tag, id: `wave:${view.id}`, view, items: [] }));
  for (const [name, child] of group.groups) {
    const below = itemsOf(child, `${path}${name}/`);
    const [only] = below;
    if (below.length === 1 && only !== undefined) items.push({ ...only, label: `${name}/${only.label}` });
    else items.push({ label: name, id: `group:${path}${name}`, items: below });
  }
  return items;
}

function tree(waves: readonly WaveView[]): Item[] {
  const root: Group = { waves: [], groups: new Map() };
  for (const view of waves) {
    let group = root;
    for (const name of view.tag.split("/").slice(0, -1)) {
      const next = group.groups.get(name) ?? { waves: [], groups: new Map() };
      group.groups.set(name, next);
      group = next;
    }
    group.waves.push(view);
  }
  return itemsOf(root, "");
}

function wavesOf(item: Item): WaveView[] {
  return item.view !== undefined ? [item.view] : item.items.flatMap(wavesOf);
}

function oldest(item: Item): string {
  return wavesOf(item).reduce((least, view) => (view.createdAt < least ? view.createdAt : least), "\uffff");
}

function newest(item: Item): string {
  return wavesOf(item).reduce((most, view) => (view.createdAt > most ? view.createdAt : most), "");
}

function fact(text: string, tone: WidgetTone = "dim"): WidgetSpan[] {
  return text === "" ? [] : [{ text, tone }];
}

function stateTone(mark: WidgetMark): WidgetTone {
  return mark === "working" ? "muted" : MARK_TONE[mark];
}

/** The rows of the widget, top to bottom; none when there is nothing to show. */
export function widgetRows(waves: readonly WaveView[], { rulings = 0, depth = "default", toggled, now }: SessionWidgetOptions = {}): WidgetRow[] {
  const toRule = fact(rulings > 0 ? `${count(rulings, "card")} to rule on` : "", "warning");
  const header = (facts: WidgetSpan[]): WidgetRow => ({ id: waves.length === 0 ? null : HEADER_ROW, lead: "", open: null, mark: null, label: { text: "Factory", tone: "title" }, title: "", facts });
  if (waves.length === 0) return toRule.length === 0 ? [] : [header(toRule)];

  const rows: WidgetRow[] = [];
  const isOpen = (id: string, byDefault: boolean) => (depth === "all" ? true : depth === "none" ? false : byDefault) !== (toggled?.has(id) ?? false);
  const active = waves.filter((view) => !finished(view));
  const waiting = active.filter(needsYou).length;
  const busy = waves.reduce((sum, view) => sum + workers(view), 0);
  rows.push(
    header([
      ...fact(money(totalCost(waves)), "text"),
      ...fact(busy > 0 ? count(busy, "worker") : "", "accent"),
      ...fact(active.length > 0 ? `${active.length} active` : `${waves.length} finished`),
      ...fact(waiting > 0 ? `${waiting} ${waiting === 1 ? "needs" : "need"} you` : "", "warning"),
      ...toRule,
    ]),
  );

  const wave = (item: Item, view: WaveView, lead: string, below: string) => {
    const why = needsYou(view) ? oneLine(view.detail ?? view.reason ?? "") : "";
    const id = why === "" && view.tasks.length === 0 ? null : item.id;
    const open = id === null ? null : isOpen(id, !finished(view) && view.stage !== "queued");
    const mark = waveMark(view);
    const busyHere = workers(view);
    const rejections = view.reviews.filter((review) => review.verdict === "rejected").length;
    rows.push({
      id,
      lead,
      open,
      mark,
      label: { text: scrub(item.label), tone: "text" },
      title: oneLine(view.title),
      facts: [
        ...fact(`${view.counts.done}/${view.counts.total} tasks`),
        ...fact(state(view), stateTone(mark)),
        ...fact(view.stage === "queued" && view.after.length > 0 ? `after ${view.after.map((id) => scrub(waves.find((other) => other.id === id)?.tag ?? id.slice(0, 8))).join(", ")}` : ""),
        ...fact(view.waitingForSlot ? "waits for a test slot" : ""),
        ...fact(busyHere > 0 ? count(busyHere, "worker") : "", "accent"),
        ...fact(rejections > 0 ? count(rejections, "rejection") : ""),
        ...fact(elapsed(view, now)),
        ...fact(money(view.usage?.cost ?? null)),
      ],
    });
    if (open !== true) return;
    const lines: Omit<WidgetRow, "lead" | "id" | "open">[] = view.tasks.map((task) => {
      const taskState = taskMark(task.state);
      return {
        mark: taskState,
        label: { text: scrub(task.key), tone: taskState === "done" || taskState === "waiting" ? "muted" : "text" },
        title: oneLine(task.title),
        facts: [
          ...fact(task.state, stateTone(taskState)),
          ...fact(task.state === "pending" && task.after.length > 0 ? `after ${task.after.join(", ")}` : ""),
          ...fact(task.model === "small" ? "small" : ""),
          ...fact(money(task.usage?.cost ?? null)),
        ],
      };
    });
    if (why !== "") lines.unshift({ mark: null, label: { text: why, tone: "warning" }, title: "", facts: [] });
    lines.forEach((line, index) => rows.push({ ...line, id: null, open: null, lead: `${below}${index === lines.length - 1 ? "└─ " : "├─ "}` }));
  };

  /** `fold`: what is finished goes under one `<n> finished` row. */
  const level = (items: readonly Item[], indent: string, fold: boolean, path: string) => {
    const done = (item: Item) => wavesOf(item).every(finished);
    const urgent = (item: Item) => Number(wavesOf(item).some(needsYou));
    const shown = items.filter((item) => !fold || !done(item)).sort((a, b) => (fold ? urgent(b) - urgent(a) || oldest(a).localeCompare(oldest(b)) : newest(b).localeCompare(newest(a))));
    const rest = fold ? items.filter(done) : [];
    shown.forEach((item, index) => {
      const last = index === shown.length - 1 && rest.length === 0;
      const lead = `${indent}${last ? "└─ " : "├─ "}`;
      const below = `${indent}${last ? "   " : "│  "}`;
      if (item.view !== undefined) return wave(item, item.view, lead, below);
      const inside = wavesOf(item);
      const open = isOpen(item.id, true);
      const busyHere = inside.reduce((sum, view) => sum + workers(view), 0);
      const mark: WidgetMark = inside.some(needsYou) ? "attention" : inside.every(finished) ? "done" : inside.every((view) => finished(view) || view.stage === "queued") ? "waiting" : "working";
      rows.push({
        id: item.id,
        lead,
        open,
        mark,
        label: { text: scrub(item.label), tone: "title" },
        title: "",
        facts: [...fact(`${inside.filter(finished).length}/${inside.length} waves`), ...fact(busyHere > 0 ? count(busyHere, "worker") : "", "accent"), ...fact(money(totalCost(inside)))],
      });
      if (open) level(item.items, below, fold, `${item.id}/`);
    });
    if (rest.length === 0) return;
    const inside = rest.flatMap(wavesOf);
    const id = `finished:${path}`;
    const open = isOpen(id, false);
    rows.push({ id, lead: `${indent}└─ `, open, mark: null, label: { text: `${inside.length} finished`, tone: "muted" }, title: "", facts: fact(money(totalCost(inside))) });
    if (open) level(rest, `${indent}   `, false, `${id}/`);
  };
  level(tree(waves), "", true, "");
  return rows;
}

/** The marks; `working` is drawn as `SPINNER[frame]`. */
const MARKS: Record<Exclude<WidgetMark, "working">, string> = { done: "✓", cancelled: "✗", attention: "!", waiting: "○" };

/**
 * An arc that runs around one braille cell: three dots, then four (the head moves on), then three again (the tail
 * follows). Sixteen half steps a turn instead of a spinner's eight to ten whole ones.
 */
const SPINNER: readonly string[] = (() => {
  const ring = [0x01, 0x08, 0x10, 0x20, 0x80, 0x40, 0x04, 0x02];
  const arc = (from: number, length: number) => String.fromCodePoint(0x2800 + Array.from({ length }, (_, i) => ring[(from + i) % ring.length] ?? 0).reduce((bits, bit) => bits | bit, 0));
  return ring.flatMap((_, from) => [arc(from, 3), arc(from, 4)]);
})();
/** Milliseconds a frame of `SPINNER` stays. */
export const SPINNER_FRAME_MS = 60;

/** A row as a line no wider than `width` (counted per code point), its parts coloured by `paint`. */
export function rowLine(row: WidgetRow, width: number, paint: (tone: WidgetTone, text: string) => string = (_tone, text) => text, frame = 0): string {
  const twisty = row.open === null ? "" : row.open ? "▾ " : "▸ ";
  const mark = row.mark === null ? "" : `${row.mark === "working" ? SPINNER[frame % SPINNER.length] : MARKS[row.mark]} `;
  const facts = row.facts.map((span) => ` · ${span.text}`).join("");
  const fixed = columns(row.lead) + columns(twisty) + columns(mark);
  if (fixed >= width) return paint("dim", truncate(row.lead + twisty + mark, width));
  // Label and facts stay whole while they fit; then the facts go from the right, then the label.
  const label = truncate(row.label.text, width - fixed);
  const room = width - fixed - columns(label);
  const title = row.title === "" ? "" : truncate(row.title, room - 2 - columns(facts));
  let left = room - (title === "" ? 0 : 2 + columns(title));
  const shown: string[] = [];
  for (const span of row.facts) {
    const text = truncate(span.text, left - 3);
    if (text === "") break;
    shown.push(paint("dim", " · ") + paint(span.tone, text));
    left -= 3 + columns(text);
  }
  return [
    paint("dim", row.lead + twisty),
    row.mark === null ? "" : paint(MARK_TONE[row.mark], mark),
    paint(row.label.tone, label),
    title === "" ? "" : `  ${paint(row.mark === "done" || row.mark === "cancelled" || row.mark === "waiting" ? "dim" : "muted", title)}`,
    ...shown,
  ].join("");
}
