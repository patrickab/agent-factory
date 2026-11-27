/**
 * Cards (contract `cards`): one card per notice kind and per action, built from fixture views; the agent's text next to
 * it is what it was before; every card survives a JSON round trip unchanged.
 */
import { describe, expect, test } from "bun:test";
import { hasAgentView, proofBlock, taskBlock, waveBlock } from "./agent-view.ts";
import { actionCard, card, safeCard, type FactoryCard } from "./cards.ts";
import { ACTIONS, type TaskView } from "./core.ts";
import { callFactoryTool, factoryCard } from "./factory-tool.ts";
import type { ProofView } from "./gates-prove.ts";
import { pendingNotices, type Notice } from "./notify.ts";
import { scoutBlock } from "./scout-view.ts";
import type { ScoutView } from "./scouts.ts";
import { FINDINGS, FIXTURES, proof, review, SCOUT, SESSION, task, TASK_ID, wave, WAVE_ID, waveTask } from "./view-fixtures.ts";
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

describe("actionCard", () => {
  test("every action has a card from its fixture view; the settling ones are decisions", () => {
    for (const name of Object.keys(ACTIONS).filter(hasAgentView)) {
      const fixture = FIXTURES[name];
      const built = actionCard(name, fixture.params, fixture.result);
      valid(built, name);
      expect(built.kind, name).toBe(DECISIONS.includes(name) ? "decision" : built.kind === "decision" ? "action" : built.kind);
      expect(built.answers, name).toBeUndefined();
    }
  });

  test("a task's result: id, tag, state, cost in cents, its title and round", () => {
    expect(actionCard("tasks.get", { id: "4ae7" }, task())).toEqual({
      v: 1,
      kind: "task",
      tone: "quiet",
      title: "task 4ae7325b",
      tag: "factory/w1",
      id: "4ae7325b",
      state: "running",
      cost: 210,
      rows: [
        { label: "task", text: "feat(waves): declare a wave" },
        { label: "round", text: "1" },
      ],
    });
    const asks = actionCard("tasks.get", {}, task({ state: "waiting_answer", question: "Which `id`?" }));
    expect(asks.text).toBe("Which `id`?");
    const blocked = actionCard("tasks.get", {}, task({ state: "blocked", reason: "gates_failed", failure: "bun test (exit 1)\n1 fail" }));
    expect(blocked.text).toBe("```\nbun test (exit 1)\n1 fail\n```");
    expect(blocked.rows).toContainEqual({ label: "why", text: "gates_failed" });
  });

  test("a wave's result: tag, stage, progress, cost; the findings of a review that did not approve", () => {
    const built = actionCard("waves.get", {}, { wave: wave({ stage: "rejected", reviews: [review("rejected", FINDINGS)] }) });
    expect(built).toMatchObject({ kind: "wave", tone: "quiet", title: "wave factory/w1", tag: "factory/w1", id: "3f2a91c0", state: "rejected", cost: 1840, progress: { done: 1, total: 3 } });
    expect(built.findings).toEqual([
      { severity: "major", file: "src/wave-runner.ts", line: 309, text: FINDINGS[0].text },
      { severity: "minor", file: "src/tasks.ts", text: FINDINGS[1].text },
    ]);
    expect(actionCard("waves.get", {}, { wave: wave({ reviews: [review("approved", FINDINGS)] }) }).findings).toBeUndefined();
    expect(actionCard("waves.start", {}, { wave: wave({ stage: "queued", after: [WAVE_ID] }) }).title).toBe("declared wave factory/w1");
  });

  test("a decision names what was sent or changed; with the key it answers it is one", () => {
    const sent = actionCard("tasks.message", { id: "4ae7", text: "use the **old** id" }, task());
    expect(sent).toMatchObject({ kind: "action", title: "sent to task 4ae7325b", text: "use the **old** id", tag: "factory/w1", id: "4ae7325b" });
    const key = `task:${TASK_ID}:waiting_answer:1@2025-01-02T10:09:00.000Z`;
    const answer = actionCard("tasks.message", { id: "4ae7", text: "use the old id" }, task(), { answers: key });
    expect(answer).toMatchObject({ kind: "decision", answers: key, text: "use the old id" });
    valid(answer, "tasks.message answers");
    const updated = actionCard("tasks.update", FIXTURES["tasks.update"].params, FIXTURES["tasks.update"].result);
    expect(updated).toMatchObject({ kind: "decision", title: "updated task docs of wave factory/w1", text: "the new request", tag: "factory/w1", rows: [{ label: "delivery", text: "starts with it" }] });
    const applied = actionCard("contracts.apply", FIXTURES["contracts.apply"].params, FIXTURES["contracts.apply"].result);
    expect(applied).toMatchObject({ kind: "decision", title: "contract api: 1 fact changed", text: "t" });
    expect(applied.rows).toContainEqual({ label: "update", text: "answer" });
    const added = actionCard("waves.add", FIXTURES["waves.add"].params, FIXTURES["waves.add"].result, { answers: `wave:${WAVE_ID}:rejected:3` });
    expect(added).toMatchObject({ kind: "decision", title: "added 1 task to wave factory/w1", text: "- **fix**: fix", answers: `wave:${WAVE_ID}:rejected:3` });
    expect(actionCard("tasks.cancel", {}, task({ state: "cancelled", review: { round: 1, status: "ok", approved: false, findings: [] } })).findings).toBeUndefined();
  });

  test("tasks.wait that ends on attention needs a ruling; one that ends at rest is quiet", () => {
    const quiet = actionCard("tasks.wait", FIXTURES["tasks.wait"].params, FIXTURES["tasks.wait"].result);
    expect(quiet).toMatchObject({ tone: "quiet", title: "everything rests" });
    const asked = task({ state: "waiting_answer", running: false, question: "q" });
    expect(actionCard("tasks.wait", {}, { tasks: [asked], waves: [], attention: [TASK_ID], timedOut: false })).toMatchObject({
      tone: "attention",
      title: "1 needs a ruling",
      rows: [
        { label: "task 4ae7325b", text: "waiting_answer" },
        { label: "watched", text: "0 waves, 1 task" },
      ],
    });
  });

  test("a card that cannot be built is the action's name; the agent's text is still the agent view", async () => {
    expect(factoryCard("tasks.get", {}, null)).toEqual({ v: 1, kind: "action", tone: "quiet", title: "tasks.get" });
    expect(actionCard("nope.nothing", {}, {})).toEqual(card("action", "quiet", "nope.nothing"));
    expect(safeCard("task", "t", () => {
      throw new Error("x");
    })).toEqual({ v: 1, kind: "task", tone: "quiet", title: "t" });
    const answer = await callFactoryTool({ action: "repos.list" }, false, { cwd: "." }, () => "the text");
    expect(answer.text).toBe("the text");
    expect(answer.card.v).toBe(1);
  });
});

describe("notice cards", () => {
  const origin = SESSION;
  const one = (notices: Notice[]): Notice => {
    expect(notices.length).toBe(1);
    valid(notices[0].card, notices[0].key);
    return notices[0];
  };
  const ofTask = (over: Partial<TaskView>) => one(pendingNotices([task({ origin, running: false, ...over })], [], new Set()));
  const ofWave = (over: Partial<WaveView>, stuck = false) => one(pendingNotices([], [{ view: wave({ running: false, ...over }), stuck, events: [{ kind: "tasks" }, { kind: "stage" }] }], new Set()));

  test("task events: the text is the agent's as before, the card titled by what happened; each needs a ruling", () => {
    const cases: [Partial<TaskView>, string][] = [
      [{ state: "waiting_answer", question: "Which `id` wins?" }, "a coder asks"],
      [{ state: "blocked", reason: "gates_failed", failure: "bun test (exit 1)" }, "task 4ae7325b is blocked"],
      [{ state: "waiting_approve" }, "task 4ae7325b waits for tasks.approve"],
      [{ state: "running", interrupted: true }, "task 4ae7325b was interrupted"],
    ];
    for (const [over, title] of cases) {
      const notice = ofTask(over);
      const view = task({ origin, running: false, ...over });
      expect(notice.text).toBe(`factory: ${title}\n${taskBlock(view)}`);
      expect(notice.card).toMatchObject({ kind: "task", tone: "attention", title, tag: "factory/w1", id: "4ae7325b", cost: 210 });
    }
    expect(ofTask({ state: "waiting_answer", question: "Which `id` wins?" }).card.text).toBe("Which `id` wins?");
  });

  test("wave events: merged is quiet, the others need a ruling; a rejection carries its findings, a merge its range", () => {
    const tasks = [waveTask("record", "done"), waveTask("docs", "pending", ["gone"])];
    const cases: [Partial<WaveView>, boolean, string, "attention" | "quiet"][] = [
      [{ stage: "rejected", reviews: [review("rejected", FINDINGS)] }, false, "wave factory/w1 was rejected", "attention"],
      [{ stage: "blocked", reason: "gates" }, false, "wave factory/w1 is blocked", "attention"],
      [{ stage: "waiting_approve" }, false, "wave factory/w1 waits for waves.approve", "attention"],
      [{ stage: "merged", merge: { at: "x", from: "0ab12cd0ab", to: "2b8a2e5ff" } }, false, "wave factory/w1 was merged", "quiet"],
      [{ stage: "reviewing", interrupted: true }, false, "wave factory/w1 was interrupted", "attention"],
      [{ stage: "building", tasks }, true, "wave factory/w1 has tasks that can never start", "attention"],
      [{ stage: "queued", after: ["77b0c2e1-0000-4000-8000-000000000000"], tasks: [] }, true, "wave factory/w1 can never start", "attention"],
    ];
    for (const [over, stuck, title, tone] of cases) {
      const notice = ofWave(over, stuck);
      expect(notice.text).toBe(`factory: ${title}\n${waveBlock(wave({ running: false, ...over }))}`);
      expect(notice.card).toMatchObject({ kind: "wave", tone, title, tag: "factory/w1", id: "3f2a91c0" });
    }
    expect(ofWave(cases[0][0]).card.findings?.length).toBe(2);
    expect(ofWave(cases[3][0]).card.rows).toContainEqual({ label: "merged", text: "0ab12cd..2b8a2e5 into master" });
    expect(ofWave({ stage: "building", tasks }, true).card.rows).toContainEqual({ label: "can never start", text: "docs" });
  });

  test("a contract change: quiet, the wave's tag, the paths and the done tasks", () => {
    const events = [{ kind: "tasks" }, { kind: "contract", name: "api", paths: ["run/contract/api/answer"], done: ["docs"] }];
    const notice = one(pendingNotices([], [{ view: wave({ stage: "building", running: false }), stuck: false, events }], new Set()));
    expect(notice.text).toBe("factory: contract api changed (run/contract/api/answer): wave factory/w1 has done tasks docs, which may need a follow-up task");
    expect(notice.card).toMatchObject({ kind: "contract", tone: "quiet", title: "contract api changed", tag: "factory/w1", rows: [{ label: "changed", text: "run/contract/api/answer" }, { label: "done tasks", text: "docs" }, { label: "next", text: "the done tasks may need a follow-up task" }] });
  });

  test("a scout's report: the report as text, quiet", () => {
    const scout = { ...SCOUT, caller: { kind: "session", id: origin } } as ScoutView;
    const notice = one(pendingNotices([], [], new Set(), { scouts: [scout] }));
    expect(notice.text).toBe(`factory: scout 5c0a1234 reported\n${scoutBlock(scout)}\nreport: ${scout.reportPath}`);
    expect(notice.card).toMatchObject({ kind: "scout", tone: "quiet", title: "scout 5c0a1234 reported", id: "5c0a1234", state: "done", cost: 25, text: scout.report });
  });

  test("a gate proof: failing needs a ruling with the tail as code, passed is quiet", () => {
    const failing = one(pendingNotices([], [], new Set(), { gates: [proof()] }));
    expect(failing.text).toBe(`factory: the gates of master fail\n${proofBlock(proof())}`);
    expect(failing.card).toMatchObject({ kind: "proof", tone: "attention", title: "the gates of master fail", id: "9c1d2e3f", state: "failing", text: "```\n(fail) the wave merges\n1 fail\n```" });
    const passed = one(pendingNotices([], [], new Set(), { gates: [proof({ state: "passed", failing: null }) as ProofView] }));
    expect(passed.card).toMatchObject({ tone: "quiet", title: "the gates of master pass" });
  });
});
