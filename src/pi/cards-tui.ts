/**
 * Factory cards in Pi's TUI: the readable form of every factory notice and `factory` tool result. The only module
 * that draws a card; the card itself comes from `../cards.ts`, never from the agent's text.
 * - Collapsed: at most `ROWS` rows, findings as counts, `TEXT_LINES` lines of text; Pi's expand key shows all
 * - The switch (Alt+V) shows every card as the agent's text, read at render time, so a toggle redraws the cards shown
 * - No line is wider than the width it renders at
 */
import { getMarkdownTheme, type ExtensionAPI, type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Markdown, Text, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { CardFinding, FactoryCard } from "../cards.ts";
import { dollars } from "../util.ts";

/** The factory's icon, on every card and every `factory` tool call. */
export const FACTORY_ICON = "◆";
/** The key that toggles every card between readable and the agent's text. */
export const CARD_SWITCH_KEY = "alt+v";
const STATUS_KEY = "factory-cards";
const ROWS = 4;
const TEXT_LINES = 8;
const SEVERITIES: readonly CardFinding["severity"][] = ["blocker", "major", "minor"];

export type CardTheme = Pick<Theme, "fg" | "bold">;

/** The session's switch: `agentText` shows the agent's text in place of every card. */
export interface CardSwitch {
  agentText: boolean;
}

export interface CardRenderOptions {
  expanded: boolean;
  /** Shown when a collapsed card hides something: the expand key's hint. */
  hint?: string;
}

/** A `FactoryCard` of version 1 in `value`, else undefined: a renderer ignores what it does not know. */
export function asCard(value: unknown): FactoryCard | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const card = value as Partial<FactoryCard>;
  return card.v === 1 && typeof card.title === "string" && typeof card.kind === "string" ? (card as FactoryCard) : undefined;
}

/** The card of a message's or tool result's `details` (`{key, card}` or `{result, card}`). */
export function detailsCard(details: unknown): FactoryCard | undefined {
  return typeof details === "object" && details !== null ? asCard((details as { card?: unknown }).card) : undefined;
}

/** The text of a message's or tool result's content. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => typeof part === "object" && part !== null && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/** `text` wrapped to `width` with `indent` before every line. */
function indented(text: string, width: number, indent = "  "): string[] {
  const room = Math.max(1, width - indent.length);
  return text.split("\n").flatMap((line) => wrapTextWithAnsi(line, room).map((part) => indent + part));
}

function findingPlace(finding: CardFinding): string {
  if (finding.file === undefined) return "";
  return finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
}

const SEVERITY_COLOR = { blocker: "error", major: "warning", minor: "muted" } as const;

/** The readable card as lines, none wider than `width`. */
export function cardLines(card: FactoryCard, options: CardRenderOptions, theme: CardTheme, width: number): string[] {
  const attention = card.tone === "attention";
  const lines: string[] = [];
  let hidden = false;
  const icon = theme.fg(attention ? "warning" : "accent", FACTORY_ICON);
  const title = attention ? theme.fg("warning", theme.bold(card.title)) : theme.bold(card.title);
  const titleLines = wrapTextWithAnsi(title, Math.max(1, width - 2));
  lines.push(`${icon} ${titleLines[0] ?? ""}`, ...titleLines.slice(1).map((line) => `  ${line}`));

  const meta = [
    card.tag,
    card.id,
    card.state,
    card.progress ? `${card.progress.done}/${card.progress.total}` : undefined,
    card.cost === undefined ? undefined : dollars(card.cost / 100),
  ].filter((part): part is string => part !== undefined && part !== "");
  if (meta.length > 0) lines.push(...indented(theme.fg("dim", meta.join(" · ")), width));

  const rows = card.rows ?? [];
  const shownRows = options.expanded ? rows : rows.slice(0, ROWS);
  for (const row of shownRows) lines.push(...indented(`${theme.fg("muted", `${row.label}:`)} ${row.text}`, width));
  if (shownRows.length < rows.length) {
    hidden = true;
    lines.push(...indented(theme.fg("dim", `… ${rows.length - shownRows.length} more`), width));
  }

  const findings = card.findings ?? [];
  if (findings.length > 0) {
    const counts = SEVERITIES.flatMap((severity) => {
      const count = findings.filter((finding) => finding.severity === severity).length;
      return count === 0 ? [] : [theme.fg(SEVERITY_COLOR[severity], `${count} ${severity}`)];
    });
    lines.push(...indented(`${theme.fg("muted", "findings:")} ${counts.join(theme.fg("dim", " · "))}`, width));
    if (options.expanded) {
      for (const severity of SEVERITIES) {
        for (const finding of findings.filter((each) => each.severity === severity)) {
          const place = findingPlace(finding);
          const head = theme.fg(SEVERITY_COLOR[severity], severity);
          lines.push(...indented(`${head} ${place === "" ? "" : `${theme.fg("mdLink", place)} `}${finding.text}`, width, "    "));
        }
      }
    } else hidden = true;
  }

  if (card.text !== undefined && card.text.trim() !== "") {
    const source = card.text.split("\n");
    const shown = options.expanded ? source : source.slice(0, TEXT_LINES);
    if (shown.length < source.length) hidden = true;
    const markdown = new Markdown(shown.join("\n"), 0, 0, getMarkdownTheme());
    lines.push(...markdown.render(Math.max(1, width - 2)).map((line) => `  ${line}`.trimEnd()));
    if (shown.length < source.length) lines.push(...indented(theme.fg("dim", `… ${source.length - shown.length} more lines`), width));
  }

  if (card.answers !== undefined) lines.push(...indented(theme.fg("dim", `answers ${card.answers}`), width));
  if (hidden && options.hint !== undefined) lines.push(...indented(theme.fg("dim", `(${options.hint})`), width));
  return lines.map((line) => truncateToWidth(line, width));
}

/** The agent's text of a card, as the agent has it in context. */
export function agentTextLines(text: string, theme: CardTheme, width: number): string[] {
  const lines = [`${theme.fg("accent", FACTORY_ICON)} ${theme.fg("dim", "agent's text")}`, ...indented(text.replace(/\s+$/, ""), width)];
  return lines.map((line) => truncateToWidth(line, width));
}

/** One card, readable or the agent's text as the switch says at render time; `pad` columns on both sides. */
export class CardComponent implements Component {
  private cache: { width: number; agentText: boolean; lines: string[] } | undefined;

  constructor(
    private readonly card: FactoryCard,
    private readonly text: string,
    private readonly options: CardRenderOptions,
    private readonly theme: CardTheme,
    private readonly view: CardSwitch,
    private readonly pad = 0,
  ) {}

  render(width: number): string[] {
    const agentText = this.view.agentText;
    if (this.cache?.width === width && this.cache.agentText === agentText) return this.cache.lines;
    const inner = Math.max(1, width - 2 * this.pad);
    const lines = agentText ? agentTextLines(this.text, this.theme, inner) : cardLines(this.card, this.options, this.theme, inner);
    const margin = " ".repeat(this.pad);
    const out = this.pad === 0 ? lines : lines.map((line) => truncateToWidth(margin + line, width));
    this.cache = { width, agentText, lines: out };
    return out;
  }

  invalidate(): void {
    this.cache = undefined;
  }
}

/** The `factory` tool's `renderCall` and `renderResult`. */
export function factoryToolRenderers(view: CardSwitch) {
  return {
    renderCall(args: unknown, theme: Theme): Component {
      const params = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
      const subject = ["id", "tag", "wave", "title"].map((key) => params[key]).find((value) => typeof value === "string" && value !== "");
      const action = typeof params.action === "string" ? params.action : "";
      let line = `${theme.fg("accent", FACTORY_ICON)} ${theme.fg("toolTitle", theme.bold("factory"))} ${theme.fg("muted", action)}`;
      if (typeof subject === "string") line += ` ${theme.fg("dim", subject)}`;
      return new Text(line, 0, 0);
    },
    renderResult(result: { content: unknown; details?: unknown }, options: ToolRenderResultOptions, theme: Theme, context: { isError: boolean; keyHint(id: string, description: string): string }): Component {
      const text = contentText(result.content);
      const card = context.isError ? undefined : detailsCard(result.details);
      if (options.isPartial) return new Text(theme.fg("dim", "…"), 0, 0);
      if (card === undefined) return new Text(context.isError ? theme.fg("error", text) : text, 0, 0);
      return new CardComponent(card, text, { expanded: options.expanded, hint: context.keyHint("app.tools.expand", "to expand") }, theme, view);
    },
  };
}

/** The `factory-notice` renderer and the Alt+V switch; answers the switch the `factory` tool's renderers share. */
export function registerCardRenderers(pi: ExtensionAPI, view: CardSwitch = { agentText: false }): CardSwitch {
  pi.registerMessageRenderer("factory-notice", (message, options, theme) => {
    const card = detailsCard(message.details);
    // An old notice, from before cards: Pi's own rendering, as before.
    if (card === undefined) return undefined;
    return new CardComponent(card, contentText(message.content), { expanded: options.expanded, hint: options.keyHint("app.tools.expand", "to expand") }, theme, view, options.outputPad);
  });
  pi.registerShortcut(CARD_SWITCH_KEY, {
    description: "Factory cards: readable or the agent's text",
    handler: (ctx) => {
      view.agentText = !view.agentText;
      // The status redraws the screen, and says why the cards look as they do.
      ctx.ui.setStatus(STATUS_KEY, view.agentText ? `factory: agent's text (${CARD_SWITCH_KEY})` : undefined);
    },
  });
  return view;
}
