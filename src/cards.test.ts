/**
 * Cards (contract `cards`): one valid card per action and per notice kind; information is quiet, a ruling attention.
 * The agent's text of a card holds no path, timestamp, session id, request or patch.
 */
import { expect, test } from "bun:test";
import { present, type FactoryCard } from "./cards.ts";
import { ACTIONS, type TaskView } from "./core.ts";
import { actionView, hasView } from "./factory-tool.ts";
import type { ProofView } from "./gates-prove.ts";
import { pendingNotices, type Notice } from "./notify.ts";
import type { ScoutView } from "./scouts.ts";
import { FINDINGS, FIXTURES, proof, review, SCOUT, SESSION, task, wave, waveTask } from "./view-fixtures.ts";
import type { WaveView } from "./waves.ts";

const KINDS = ["wave", "task", "scout", "proof", "contract", "decision", "action"];
const FIELDS = ["v", "kind", "tone", "title", "tag", "id", "state", "cost", "progress", "rows", "findings", "text", "answers"];

/** A card as the contract gives it: known fields, none undefined or empty, a one-line title; the same after JSON. */
function valid(built: FactoryCard, name: string): void {
  expect(built.v, name).toBe(1);
  expect(KINDS, name).toContain(built.kind);
  expect(["attention", "quiet"], name).toContain(built.tone);
  expect(built.title.length, name).toBeGreaterThan(0);
  expect(built.title, name).not.toContain("\n");
  expect(built.title, name).not.toStartWith("factory:");
  for (const [key, value] of Object.entries(built)) {
    expect(FIELDS, `${name}: ${key}`).toContain(key);
    expect(value, `${name}: ${key}`).not.toBeUndefined();
    if (Array.isArray(value)) expect(value.length, `${name}: ${key}`).toBeGreaterThan(0);
  }
  expect(JSON.parse(JSON.stringify(built)), name).toStrictEqual(built);
}

const DECISIONS = ["tasks.update", "waves.update", "tasks.retry", "waves.retry", "tasks.cancel", "waves.cancel", "contracts.apply"];

const FORBIDDEN = [/\/home/, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, new RegExp(SESSION.slice(0, 13)), /SECRET-REQUEST/, /secret patch/];

test("every action but tasks.timeline has a valid card and a clean text from its fixture view; the settling ones are decisions", () => {
  expect(Object.keys(ACTIONS).filter((name) => !hasView(name))).toEqual(["tasks.timeline"]);
  for (const name of Object.keys(ACTIONS).filter(hasView)) {
    const fixture = FIXTURES[name];
    expect(fixture, `fixture for ${name}`).toBeDefined();
    const { card, text } = actionView(name, fixture.params, fixture.result);
    valid(card, name);
    expect(card.kind === "decision", name).toBe(DECISIONS.includes(name));
    expect(text.length, name).toBeGreaterThan(0);
    for (const pattern of FORBIDDEN) expect(text, name).not.toMatch(pattern);
  }
  // The one exception: the repository paths an agent passes back.
  expect(actionView("repos.list", {}, { repos: ["/srv/app"] }).text).toContain("/srv/app");
});

test("a card that cannot be built is a quiet one, never a failure", () => {
  const { card, text } = present(() => {
    throw new Error("unexpected shape");
  }, "models.set done; its answer could not be shown");
  valid(card, "fallback");
  expect([card.tone, text]).toEqual(["quiet", "models.set done; its answer could not be shown"]);
});

test("every notice has a valid card: a ruling is attention, information is quiet", () => {
  const origin = SESSION;
  const tasks = [waveTask("record", "done"), waveTask("docs", "pending", ["gone"])];
  const ofTask = (over: Partial<TaskView>) => pendingNotices([task({ origin, running: false, ...over })], [], new Set());
  const ofWave = (over: Partial<WaveView>, events: { kind: string; [key: string]: unknown }[] = [{ kind: "tasks" }, { kind: "stage" }]) =>
    pendingNotices([], [{ view: wave({ running: false, ...over }), events }], new Set());
  const scout = { ...SCOUT, caller: { kind: "session", id: origin } } as ScoutView;
  const cases: [Notice[], string, "attention" | "quiet"][] = [
    [ofTask({ state: "waiting_answer", question: "q" }), "task", "attention"],
    [ofTask({ state: "blocked", reason: "gates_failed", failure: "f" }), "task", "attention"],
    [ofTask({ state: "waiting_approve" }), "task", "attention"],
    [ofTask({ state: "running", interrupted: true }), "task", "attention"],
    [ofWave({ stage: "rejected", reviews: [review("rejected", FINDINGS)] }), "wave", "attention"],
    [ofWave({ stage: "blocked", reason: "gates" }), "wave", "attention"],
    [ofWave({ stage: "waiting_approve" }), "wave", "attention"],
    [ofWave({ stage: "merged", merge: { at: "x", from: "0ab12cd0ab", to: "2b8a2e5ff" } }), "wave", "quiet"],
    [ofWave({ stage: "reviewing", interrupted: true }), "wave", "attention"],
    [ofWave({ stage: "building", tasks, stuck: true }), "wave", "attention"],
    [ofWave({ stage: "queued", after: ["77b0c2e1-0000-4000-8000-000000000000"], tasks: [], stuck: true }), "wave", "attention"],
    [ofWave({ stage: "building" }, [{ kind: "tasks" }, { kind: "contract", name: "api", paths: ["run/contract/api/answer"], done: ["docs"] }]), "contract", "quiet"],
    [pendingNotices([], [], new Set(), { scouts: [scout] }), "scout", "quiet"],
    [pendingNotices([], [], new Set(), { gates: [proof()] }), "proof", "attention"],
    [pendingNotices([], [], new Set(), { gates: [proof({ state: "passed", failing: null }) as ProofView] }), "proof", "quiet"],
  ];
  for (const [notices, kind, tone] of cases) {
    expect(notices.length).toBe(1);
    valid(notices[0].card, notices[0].key);
    for (const pattern of FORBIDDEN) expect(notices[0].text, notices[0].key).not.toMatch(pattern);
    expect(notices[0].card, notices[0].key).toMatchObject({ kind, tone });
  }
});
