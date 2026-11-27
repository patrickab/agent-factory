/** Cards (contract `cards`): one valid card per action and per notice kind; information is quiet, a ruling attention. */
import { expect, test } from "bun:test";
import { hasAgentView } from "./agent-view.ts";
import { actionCard, type FactoryCard } from "./cards.ts";
import { ACTIONS, type TaskView } from "./core.ts";
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

test("every action has a valid card from its fixture view; the settling ones are decisions", () => {
  for (const name of Object.keys(ACTIONS).filter(hasAgentView)) {
    const fixture = FIXTURES[name];
    const built = actionCard(name, fixture.params, fixture.result);
    valid(built, name);
    expect(built.kind === "decision", name).toBe(DECISIONS.includes(name));
  }
});

test("every notice has a valid card: a ruling is attention, information is quiet", () => {
  const origin = SESSION;
  const tasks = [waveTask("record", "done"), waveTask("docs", "pending", ["gone"])];
  const ofTask = (over: Partial<TaskView>) => pendingNotices([task({ origin, running: false, ...over })], [], new Set());
  const ofWave = (over: Partial<WaveView>, stuck = false, events: { kind: string; [key: string]: unknown }[] = [{ kind: "tasks" }, { kind: "stage" }]) =>
    pendingNotices([], [{ view: wave({ running: false, ...over }), stuck, events }], new Set());
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
    [ofWave({ stage: "building", tasks }, true), "wave", "attention"],
    [ofWave({ stage: "queued", after: ["77b0c2e1-0000-4000-8000-000000000000"], tasks: [] }, true), "wave", "attention"],
    [ofWave({ stage: "building" }, false, [{ kind: "tasks" }, { kind: "contract", name: "api", paths: ["run/contract/api/answer"], done: ["docs"] }]), "contract", "quiet"],
    [pendingNotices([], [], new Set(), { scouts: [scout] }), "scout", "quiet"],
    [pendingNotices([], [], new Set(), { gates: [proof()] }), "proof", "attention"],
    [pendingNotices([], [], new Set(), { gates: [proof({ state: "passed", failing: null }) as ProofView] }), "proof", "quiet"],
  ];
  for (const [notices, kind, tone] of cases) {
    expect(notices.length).toBe(1);
    valid(notices[0].card, notices[0].key);
    expect(notices[0].card, notices[0].key).toMatchObject({ kind, tone });
  }
});
