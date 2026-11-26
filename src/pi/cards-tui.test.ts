/**
 * Cards in Pi's TUI: every card kind renders to lines within a narrow and a wide width, the switch shows the agent's
 * text, an old notice without `details` keeps Pi's own rendering, the widget counts the cards to rule on.
 */
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { card, type CardKind, type FactoryCard } from "../cards.ts";
import { cardsToRule, sessionWidget } from "../session-widget.ts";
import { CardComponent, cardLines, factoryToolRenderers, FACTORY_ICON, registerCardRenderers, type CardTheme } from "./cards-tui.ts";

/** A theme that draws nothing: the lines are the plain text. */
const plain: CardTheme = { fg: (_color, text) => text, bold: (text) => text, italic: (text) => text, underline: (text) => text, strikethrough: (text) => text };
const hints = { keyHint: (_id: string, description: string) => `ctrl+o ${description}`, keyText: () => "ctrl+o" };

const full: Omit<FactoryCard, "v" | "kind" | "tone" | "title"> = {
  tag: "ui/2",
  id: "1a2b3c4d",
  state: "rejected",
  cost: 1234,
  progress: { done: 2, total: 3 },
  rows: [1, 2, 3, 4, 5].map((n) => ({ label: `row${n}`, text: `fact number ${n} about the wave` })),
  findings: [
    { severity: "minor", text: "a naming nit" },
    { severity: "blocker", file: "src/a.ts", line: 12, text: "the merge drops a line" },
    { severity: "major", file: "src/b.ts", text: "no test" },
  ],
  text: Array.from({ length: 10 }, (_, n) => `line ${n + 1} of the brief with \`code\``).join("\n"),
};

const KINDS: { kind: CardKind; title: string; draft: typeof full & { answers?: string } }[] = [
  { kind: "wave", title: "wave ui/2 was rejected", draft: full },
  { kind: "task", title: "a coder asks", draft: { id: "5e6f7a8b", tag: "ui/2", state: "waiting_answer", text: "Which **API** do I use?" } },
  { kind: "scout", title: "scout 9a8b7c6d reported", draft: { id: "9a8b7c6d", state: "done", text: "MISSING\n1. nothing" } },
  { kind: "proof", title: "gates fail on main", draft: { id: "abcdef12", state: "failing", rows: [{ label: "step", text: "bun test" }] } },
  { kind: "contract", title: "contract core changed", draft: { tag: "ui/2", rows: [{ label: "told", text: "2 tasks" }] } },
  { kind: "decision", title: "answered the coder", draft: { id: "5e6f7a8b", text: "Use the v2 API.", answers: "task:5e6f7a8b:waiting_answer:1@2026" } },
  { kind: "action", title: "no repositories registered", draft: {} },
];

describe("cardLines", () => {
  for (const { kind, title, draft } of KINDS) {
    for (const width of [24, 120]) {
      test(`a ${kind} card at ${width} columns: the icon and title first, no line wider`, () => {
        const one = card(kind, kind === "task" || kind === "proof" ? "attention" : "quiet", title, draft);
        for (const expanded of [false, true]) {
          const lines = cardLines(one, { expanded, hint: "ctrl+o to expand" }, plain, width);
          expect(lines[0].startsWith(`${FACTORY_ICON} `)).toBe(true);
          expect(lines.join(" ")).toContain(title.split(" ")[0]);
          for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        }
      });
    }
  }

  test("wide and collapsed: meta on one line, four rows, findings as counts, eight lines of text, the hint", () => {
    const lines = cardLines(card("wave", "attention", "wave ui/2 was rejected", full), { expanded: false, hint: "ctrl+o to expand" }, plain, 120);
    expect(lines[0]).toBe(`${FACTORY_ICON} wave ui/2 was rejected`);
    expect(lines[1]).toBe("  ui/2 · 1a2b3c4d · rejected · 2/3 · $12.34");
    expect(lines).toContain("  row4: fact number 4 about the wave");
    expect(lines).not.toContain("  row5: fact number 5 about the wave");
    expect(lines).toContain("  … 1 more");
    expect(lines).toContain("  findings: 1 blocker · 1 major · 1 minor");
    expect(lines.some((line) => line.includes("the merge drops a line"))).toBe(false);
    expect(lines.some((line) => line.includes("line 8 of the brief"))).toBe(true);
    expect(lines.some((line) => line.includes("line 9 of the brief"))).toBe(false);
    expect(lines.at(-1)).toBe("  (ctrl+o to expand)");
  });

  test("expanded: every row, findings grouped by severity with file:line, the whole text, no hint", () => {
    const lines = cardLines(card("wave", "attention", "wave ui/2 was rejected", full), { expanded: true, hint: "ctrl+o to expand" }, plain, 120);
    expect(lines).toContain("  row5: fact number 5 about the wave");
    const blocker = lines.indexOf("    blocker src/a.ts:12 the merge drops a line");
    const major = lines.indexOf("    major src/b.ts no test");
    const minor = lines.indexOf("    minor a naming nit");
    expect(blocker).toBeGreaterThan(0);
    expect(major).toBeGreaterThan(blocker);
    expect(minor).toBeGreaterThan(major);
    expect(lines.some((line) => line.includes("line 10 of the brief"))).toBe(true);
    expect(lines.some((line) => line.includes("ctrl+o"))).toBe(false);
  });

  test("a decision names what it answers; a card with nothing hidden has no hint", () => {
    const lines = cardLines(card("decision", "quiet", "answered the coder", { text: "Use v2.", answers: "task:x:waiting_answer:1@t" }), { expanded: false, hint: "h" }, plain, 80);
    expect(lines).toEqual([`${FACTORY_ICON} answered the coder`, "  Use v2.", "  answers task:x:waiting_answer:1@t"]);
  });

  test("narrow: the title wraps under itself", () => {
    const lines = cardLines(card("action", "quiet", "a title that is longer than the width"), { expanded: false }, plain, 16);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[1].startsWith("  ")).toBe(true);
  });
});

/** The renderers the extension registers, through a fake Pi. */
function registered() {
  let renderer: any;
  let shortcut: { key: string; handler: (ctx: unknown) => void } | undefined;
  const statuses: (string | undefined)[] = [];
  const pi = {
    registerMessageRenderer: (type: string, render: unknown) => type === "factory-notice" && (renderer = render),
    registerShortcut: (key: string, options: { handler: (ctx: unknown) => void }) => (shortcut = { key, handler: options.handler }),
  };
  const view = registerCardRenderers(pi as unknown as ExtensionAPI);
  const toggle = () => shortcut!.handler({ ui: { setStatus: (_key: string, text: string | undefined) => statuses.push(text) } });
  return { renderer, shortcut: shortcut!, toggle, statuses, view };
}

describe("the notice renderer and the switch", () => {
  const notice = {
    role: "custom",
    customType: "factory-notice",
    content: "factory: a coder asks\ntask 5e6f7a8b waiting_answer\nnext: tasks.message",
    display: true,
    details: { key: "task:5e6f7a8b:waiting_answer:1@t", card: card("task", "attention", "a coder asks", { id: "5e6f7a8b", text: "Which API?" }) },
  };

  test("a notice with a card renders the card; Alt+V shows the agent's text, again the card", () => {
    const { renderer, shortcut, toggle, statuses } = registered();
    expect(shortcut.key).toBe("alt+v");
    const component = renderer(notice, { expanded: false, outputPad: 1, ...hints }, plain);
    const readable = component.render(60);
    expect(readable[0]).toBe(` ${FACTORY_ICON} a coder asks`);
    expect(readable.join("\n")).not.toContain("next: tasks.message");
    toggle();
    const agent = component.render(60);
    expect(agent).toEqual([` ${FACTORY_ICON} agent's text`, "   factory: a coder asks", "   task 5e6f7a8b waiting_answer", "   next: tasks.message"]);
    toggle();
    expect(component.render(60)).toEqual(readable);
    expect(statuses).toEqual(["factory: agent's text (alt+v)", undefined]);
  });

  test("an old notice without details, or with details of no card, renders as before (Pi's own rendering)", () => {
    const { renderer } = registered();
    expect(renderer({ ...notice, details: undefined }, { expanded: false, outputPad: 1, ...hints }, plain)).toBeUndefined();
    expect(renderer({ ...notice, details: { key: "k" } }, { expanded: false, outputPad: 1, ...hints }, plain)).toBeUndefined();
  });
});

describe("the factory tool's renderers", () => {
  const theme = plain as never;
  const context = (isError = false) => ({ isError, ...hints });

  test("the call shows the icon, the action and its subject", () => {
    const { renderCall } = factoryToolRenderers({ agentText: false });
    expect(renderCall({ action: "waves.get", id: "1a2b3c4d" }, theme).render(80)[0].trimEnd()).toBe(`${FACTORY_ICON} factory waves.get 1a2b3c4d`);
  });

  test("a result with a card renders it, the switch shows its text; an error or a result without a card shows the text", () => {
    const view = { agentText: false };
    const { renderResult } = factoryToolRenderers(view);
    const result = { content: [{ type: "text", text: "no repositories registered\nnext: init" }], details: { result: { repos: [] }, card: card("action", "quiet", "no repositories registered") } };
    const component = renderResult(result, { expanded: false, isPartial: false }, theme, context());
    expect(component).toBeInstanceOf(CardComponent);
    expect(component.render(40)).toEqual([`${FACTORY_ICON} no repositories registered`]);
    view.agentText = true;
    expect(component.render(40)).toEqual([`${FACTORY_ICON} agent's text`, "  no repositories registered", "  next: init"]);
    const error = renderResult({ content: [{ type: "text", text: "error: unknown wave" }], details: undefined }, { expanded: false, isPartial: false }, theme, context(true));
    expect(error.render(40)[0].trimEnd()).toBe("error: unknown wave");
    const old = renderResult({ content: [{ type: "text", text: "ok" }], details: { repos: [] } }, { expanded: false, isPartial: false }, theme, context());
    expect(old.render(40)[0].trimEnd()).toBe("ok");
  });
});

describe("cardsToRule and the widget", () => {
  const noticeEntry = (key: string, tone: "attention" | "quiet") => ({ type: "custom_message", customType: "factory-notice", details: { key, card: card("task", tone, "t") } });
  const decisionEntry = (answers: string) => ({ type: "message", message: { role: "toolResult", toolName: "factory", details: { result: {}, card: card("decision", "quiet", "d", { answers }) } } });

  test("an attention notice waits until a decision answers it or a later notice of its subject replaces it", () => {
    const asks = noticeEntry("task:aaaa1111:waiting_answer:1@t1", "attention");
    const rejected = noticeEntry("wave:bbbb2222:rejected:3", "attention");
    expect(cardsToRule([asks, rejected, noticeEntry("scout:cc:report", "quiet")])).toBe(2);
    expect(cardsToRule([asks, rejected, decisionEntry("task:aaaa1111:waiting_answer:1@t1")])).toBe(1);
    expect(cardsToRule([asks, noticeEntry("task:aaaa1111:waiting_approve:2@t2", "quiet")])).toBe(0);
    expect(cardsToRule([{ type: "custom_message", customType: "factory-notice", content: "old" }])).toBe(0);
  });

  test("a quiet contract notice keeps an open rejection of its wave", () => {
    const rejected = noticeEntry("wave:bbbb2222:rejected:3", "attention");
    expect(cardsToRule([rejected, noticeEntry("wave:bbbb2222:contract:4", "quiet")])).toBe(1);
    expect(cardsToRule([rejected, noticeEntry("wave:bbbb2222:merged:5", "quiet")])).toBe(0);
  });

  test("the widget header adds the count; with no wave the count alone", () => {
    expect(sessionWidget([], { showFinished: false, width: 80, rulings: 2 })).toEqual(["Factory · 2 cards to rule on"]);
    expect(sessionWidget([], { showFinished: false, width: 80, rulings: 0 })).toEqual([]);
  });
});
