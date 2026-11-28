/**
 * Cards in Pi's TUI: every card kind renders to lines within a narrow and a wide width, the switch shows the agent's
 * text, the cards to rule on are counted.
 */
import { describe, expect, test } from "bun:test";
import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { card, type CardKind, type FactoryCard } from "../cards.ts";
import { cardsToRule } from "../session-widget.ts";
import { cardLines, FACTORY_ICON, registerCardRenderers, type CardTheme } from "./cards-tui.ts";

/** A theme that draws nothing: the lines are the plain text; the card's markdown takes Pi's global theme, as in Pi. */
const plain: CardTheme = { fg: (_color, text) => text, bold: (text) => text };
initTheme();
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
});

/** The renderers the extension registers, through a fake Pi. */
function registered() {
  let renderer: any;
  let shortcut: { key: string; handler: (ctx: unknown) => void } | undefined;
  const pi = {
    registerMessageRenderer: (type: string, render: unknown) => type === "factory-notice" && (renderer = render),
    registerShortcut: (key: string, options: { handler: (ctx: unknown) => void }) => (shortcut = { key, handler: options.handler }),
  };
  registerCardRenderers(pi as unknown as ExtensionAPI);
  const toggle = () => shortcut!.handler({ ui: { setStatus: () => {} } });
  return { renderer, toggle };
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
    const { renderer, toggle } = registered();
    const component = renderer(notice, { expanded: false, outputPad: 1, ...hints }, plain);
    const readable = component.render(60);
    expect(readable.join("\n")).not.toContain("next: tasks.message");
    toggle();
    expect(component.render(60).join("\n")).toContain("next: tasks.message");
    toggle();
    expect(component.render(60)).toEqual(readable);
  });
});

describe("cardsToRule", () => {
  const noticeEntry = (key: string, tone: "attention" | "quiet") => ({ type: "custom_message", customType: "factory-notice", details: { key, card: card("task", tone, "t") } });
  const decisionEntry = (answers: string) => ({ type: "message", message: { role: "toolResult", toolName: "factory", details: { result: {}, card: card("decision", "quiet", "d", { answers }) } } });

  test("an attention notice waits until a decision answers it or a later notice of its subject replaces it", () => {
    const asks = noticeEntry("task:aaaa1111:waiting_answer:1@t1", "attention");
    const rejected = noticeEntry("wave:bbbb2222:rejected:3", "attention");
    expect(cardsToRule([asks, rejected, noticeEntry("scout:cc:report", "quiet")])).toBe(2);
    expect(cardsToRule([asks, rejected, decisionEntry("task:aaaa1111:waiting_answer:1@t1")])).toBe(1);
    expect(cardsToRule([asks, noticeEntry("task:aaaa1111:waiting_approve:2@t2", "quiet")])).toBe(0);
    for (const quiet of ["contract", "note", "fix"]) expect(cardsToRule([rejected, noticeEntry(`wave:bbbb2222:${quiet}:4`, "quiet")])).toBe(1);
    expect(cardsToRule([rejected, noticeEntry("wave:bbbb2222:merged:5", "quiet")])).toBe(0);
  });
});
