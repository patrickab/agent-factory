/** A task end to end (`scenario-kit.ts`): real git, runners and `pi`; the model scripted. Outcome only. */
import { expect } from "bun:test";
import { events, scenario, verdict, write } from "./scenario-kit.ts";

scenario(
  "S1 a task: the coder writes, the reviewer approves, the target fast-forwards to one commit",
  ({ role }) => (role === "coder" ? [write("b.txt", "b\n")] : verdict()),
  async (c) => {
    const before = c.git("rev-parse", "main");
    const task = await c.act("tasks.start", { title: "feat: add b", request: "add b.txt", overrides: { review: true } });
    const waited = await c.act("tasks.wait", { ids: [task.id], timeoutMs: 30_000 });
    expect(waited.timedOut).toBe(false);
    const done = await c.act("tasks.get", { id: task.id });
    expect(done.state).toBe("done");
    expect(c.git("rev-parse", "main~1")).toBe(before);
    expect(c.git("show", "main:b.txt")).toBe("b");
    expect(c.calls.map((call) => call.role)).toEqual(["coder", "reviewer"]);
    expect(done.usage.cost).toBeGreaterThan(0);
  },
);

const GATE_NEEDS_C = 'gates:\n  - [sh, -c, "test -f c.txt || { echo NEED-C; exit 1; }"]\n';

scenario(
  "S2 a failing gate goes back to the coder; out of rounds the task blocks, a retry gets a fresh budget",
  (() => {
    let n = 0;
    return ({ role }) => (role === "coder" ? [write(++n < 3 ? "b.txt" : "c.txt", `${n}\n`)] : undefined);
  })(),
  async (c) => {
    const task = await c.act("tasks.start", { title: "feat: add c", request: "add c.txt", overrides: { maxRounds: 2 } });
    await c.act("tasks.wait", { ids: [task.id], timeoutMs: 30_000 });
    const blocked = await c.act("tasks.get", { id: task.id });
    expect([blocked.state, blocked.reason]).toEqual(["blocked", "max_rounds: gates"]);
    expect(c.calls[1].prompt).toContain("NEED-C");
    await c.until(() => c.notices.length > 0);
    expect(events(c.notices)).toEqual([`task:${task.id}:blocked`]);
    await c.act("tasks.retry", { id: task.id });
    await c.act("tasks.wait", { ids: [task.id], timeoutMs: 30_000 });
    expect((await c.act("tasks.get", { id: task.id })).state).toBe("done");
    expect(c.git("show", "main:c.txt")).toBe("3");
  },
  { factory: GATE_NEEDS_C },
);

scenario(
  "S7 a coder's question: waiting_answer, one notice to the origin, the answer continues the same round",
  ({ prompt }) => (prompt.includes("ANSWER-B") ? [write("b.txt", "b\n")] : [{ name: "factory_ask_supervisor", args: { question: "which file?" } }]),
  async (c) => {
    const task = await c.act("tasks.start", { title: "feat: add b", request: "add a file" });
    const waited = await c.act("tasks.wait", { ids: [task.id], timeoutMs: 30_000 });
    expect(waited.attention).toEqual([task.id]);
    const asking = await c.act("tasks.get", { id: task.id });
    expect([asking.state, asking.question]).toEqual(["waiting_answer", "which file?"]);
    await c.until(() => c.notices.length > 0);
    await c.act("tasks.message", { id: task.id, text: "ANSWER-B" });
    await c.act("tasks.wait", { ids: [task.id], timeoutMs: 30_000 });
    const done = await c.act("tasks.get", { id: task.id });
    expect([done.state, done.round]).toEqual(["done", 1]);
    expect(events(c.notices)).toEqual([`task:${task.id}:waiting_answer`]);
  },
);
