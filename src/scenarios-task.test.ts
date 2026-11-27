/** A task end to end (`scenario-kit.ts`): real git, runners and `pi`; the model scripted. Outcome only. */
import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { events, scenario, terminate, verdict, write } from "./scenario-kit.ts";

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
    expect(events(c.notices)).toEqual([`task:${task.id}:blocked`]);
    await c.act("tasks.retry", { id: task.id });
    await c.act("tasks.wait", { ids: [task.id], timeoutMs: 30_000 });
    expect((await c.act("tasks.get", { id: task.id })).state).toBe("done");
    expect(c.git("show", "main:c.txt")).toBe("3");
  },
  { factory: GATE_NEEDS_C },
);

scenario(
  "S3 a major finding starts a round with only the rejecting findings; a minor-only review merges",
  (() => {
    let reviews = 0;
    return ({ role }) =>
      role === "coder"
        ? [write("b.txt", "b\n")]
        : ++reviews === 1
          ? verdict({ file: "b.txt", severity: "major", text: "B-MAJOR" }, { file: "b.txt", severity: "minor", text: "B-MINOR-1" })
          : verdict({ file: "b.txt", severity: "minor", text: "B-MINOR-2" });
  })(),
  async (c) => {
    const task = await c.act("tasks.start", { title: "feat: add b", request: "add b.txt", overrides: { review: true } });
    await c.act("tasks.wait", { ids: [task.id], timeoutMs: 30_000 });
    const done = await c.act("tasks.get", { id: task.id });
    expect([done.state, done.round]).toEqual(["done", 2]);
    const feedback = c.calls.filter((call) => call.role === "coder")[1].prompt;
    expect(feedback).toContain("B-MAJOR");
    expect(feedback).not.toContain("B-MINOR");
    expect(done.minors.map((minor: { text: string }) => minor.text)).toEqual(["B-MINOR-1", "B-MINOR-2"]);
    expect(c.git("show", "main:b.txt")).toBe("b");
  },
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

{
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  scenario(
    "S9 a task runner stopped mid-round: blocked, one notice, attention; a retry lands it once",
    async ({ role }) => {
      await held;
      return role === "coder" ? [write("b.txt", "b.txt\n")] : undefined;
    },
    async (c) => {
      const before = c.git("rev-parse", "main");
      const task = await c.act("tasks.start", { title: "feat: add b", request: "WRITE b.txt" });
      await c.until(() => c.calls.length > 0);
      await terminate(task.id);
      const waited = await c.act("tasks.wait", { ids: [task.id], timeoutMs: 30_000 });
      expect(waited.attention).toEqual([task.id]);
      // The runner stops Pi, which ends the round: blocked, not interrupted (that is a runner that died).
      const stopped = await c.act("tasks.get", { id: task.id });
      expect([stopped.state, stopped.reason]).toEqual(["blocked", "stopped"]);
      release();
      await c.act("tasks.retry", { id: task.id });
      await c.act("tasks.wait", { ids: [task.id], timeoutMs: 30_000 });
      expect((await c.act("tasks.get", { id: task.id })).state).toBe("done");
      expect([c.git("rev-parse", "main~1"), c.git("show", "main:b.txt")]).toEqual([before, "b.txt"]);
      expect(events(c.notices)).toEqual([`task:${task.id}:blocked`]);
    },
  );
}

/** A merge gate that counts its runs and, on the first, moves the target (an empty commit in the primary checkout). */
const MOVES_TARGET = `merge_gates:
  - [sh, -c, 'd=$(git rev-parse --git-common-dir); echo run >> "$d/gate-runs"; [ -f "$d/moved" ] || { touch "$d/moved"; git -C "$d/.." commit -q --allow-empty -m moved; }']
`;

scenario(
  "S11 the target moves during the merge gates: the task is rebased and gated again, then lands on the new tip",
  ({ role }) => (role === "coder" ? [write("b.txt", "b\n")] : undefined),
  async (c) => {
    const task = await c.act("tasks.start", { title: "feat: add b", request: "add b" });
    await c.act("tasks.wait", { ids: [task.id], timeoutMs: 30_000 });
    expect((await c.act("tasks.get", { id: task.id })).state).toBe("done");
    expect(c.git("log", "-1", "--format=%s", "main~1")).toBe("moved");
    expect(c.git("show", "main:b.txt")).toBe("b");
    expect(readFileSync(join(c.repo, ".git", "gate-runs"), "utf8").trim().split("\n")).toHaveLength(2);
  },
  { factory: MOVES_TARGET },
);
