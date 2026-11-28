/** Waves that conflict, stop or are told, end to end (`scenario-kit.ts`): real git, runners and `pi`; the model scripted. Outcome only. */
import { expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bash, events, scenario, terminate, verdict, write, writesNamed, type Case, type Script } from "./scenario-kit.ts";

/**
 * Task x writes `a.txt`; the target gets a conflicting `a.txt` once the wave's branch is cut (`startConflicting`). The
 * conflict task's coder resolves the markers (`resolve`) or asks and waits (so the test can cancel it).
 */
const conflicting =
  (resolve: boolean): Script =>
  ({ role, prompt }) => {
    if (role === "reviewer") return verdict();
    if (prompt.includes("WRITE a.txt")) return [write("a.txt", "x\n")];
    if (prompt.includes("ANSWER")) return undefined;
    return resolve ? [bash("grep -q '^<<<<<<<' a.txt && printf 'resolved\\n' > a.txt")] : [{ name: "factory_ask_supervisor", args: { question: "which side?" } }];
  };

async function startConflicting(c: Case): Promise<{ id: string }> {
  await c.act("repos.add");
  const { wave } = await c.act("waves.start", { tag: "s6", title: "wave", request: "review", tasks: [{ key: "x", title: "feat: a is x", request: "WRITE a.txt" }] });
  writeFileSync(join(c.repo, "a.txt"), "main\n");
  c.git("commit", "--quiet", "-am", "main's a");
  return wave;
}

scenario("S6 a conflict with the target becomes a conflict task, whose resolution merges", conflicting(true), async (c) => {
  const wave = await startConflicting(c);
  await c.act("tasks.wait", { wave: wave.id, timeoutMs: 60_000 });
  const merged = (await c.act("waves.get", { id: wave.id })).wave;
  expect(merged.stage).toBe("merged");
  expect(merged.tasks.map((task: { key: string }) => task.key)).toEqual(["x", "conflict-1"]);
  expect(c.git("show", "main:a.txt")).toBe("resolved");
  expect(c.git("show", "main~1:a.txt")).toBe("main");
});

scenario("S6 a cancelled conflict task restores the wave's branch, the wave blocks, the target stays", conflicting(false), async (c) => {
  const wave = await startConflicting(c);
  await c.act("tasks.wait", { wave: wave.id, timeoutMs: 60_000 });
  const asking = (await c.act("waves.get", { id: wave.id })).wave.tasks.find((task: { key: string }) => task.key === "conflict-1");
  expect(asking.state).toBe("waiting_answer");
  const main = c.git("rev-parse", "main");
  await c.act("tasks.cancel", { id: asking.taskId });
  await c.act("tasks.wait", { wave: wave.id, timeoutMs: 60_000 });
  const blocked = (await c.act("waves.get", { id: wave.id })).wave;
  expect(blocked.stage).toBe("blocked");
  expect(c.git("rev-parse", "main")).toBe(main);
  expect(c.git("show", `${blocked.branch}:a.txt`)).toBe("x");
  expect(c.git("rev-list", "--count", `main..${blocked.branch}`)).toBe("1");
});

{
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  scenario(
    "S8 contracts.apply during a wave: the running task told once, the waiting one with its answer, the pending one at its start, the done one listed",
    async (call) => {
      if (call.role === "coder" && call.prompt.includes("WRITE r.txt")) await held;
      if (call.role === "coder" && call.prompt.includes("WRITE w.txt")) return [{ name: "factory_ask_supervisor", args: { question: "w?" } }];
      if (call.role === "coder" && call.prompt.includes("ANSWER-W")) return [write("w.txt", "w\n")];
      return writesNamed(call);
    },
    async (c) => {
      await c.act("repos.add");
      const { wave } = await c.act("waves.start", {
        tag: "s8",
        title: "wave",
        request: "review",
        plan: "plan",
        contracts: ["api"],
        tasks: ["d", "r", "w"].map((key) => ({ key, title: `feat: add ${key}`, request: `WRITE ${key}.txt` })).concat({ key: "p", title: "feat: add p", request: "WRITE p.txt", after: ["w"] } as never),
      });
      const state = async (key: string) => (await c.act("waves.get", { id: wave.id })).wave.tasks.find((task: { key: string }) => task.key === key);
      await c.until(async () => (await state("d")).state === "done" && (await state("w")).state === "waiting_answer" && (await state("r")).state === "running");
      const applied = await c.act("contracts.apply", { store: "plan", name: "api", op: { op: "update", path: "answer", id: "f0", text: "FACT-2" } });
      const keys = (tasks: { key: string }[]) => tasks.map((task) => task.key);
      expect([keys(applied.notified), keys(applied.kept), keys(applied.done)]).toEqual([["r"], ["w"], ["d"]]);
      release();
      await c.act("tasks.message", { id: (await state("w")).taskId, text: "ANSWER-W" });
      await c.act("tasks.wait", { wave: wave.id, timeoutMs: 60_000 });
      expect((await c.act("waves.get", { id: wave.id })).wave.stage).toBe("merged");
      const told = c.calls.filter((call) => call.role === "coder" && call.prompt.includes("FACT-2"));
      // The running one as a follow-up, the waiting one with its answer; the pending one reads the store at its start.
      expect(told.map((call) => call.prompt.includes("ANSWER-W"))).toEqual([false, true]);
      expect(c.calls.some((call) => call.prompt.includes("WRITE p.txt") && call.prompt.includes("run/contract/api"))).toBe(true);
      expect(events(c.notices).sort()).toEqual([`task:${(await state("w")).taskId}:waiting_answer`, `wave:${wave.id}:contract`, `wave:${wave.id}:merged`].sort());
    },
    { store: { memories: { "run/contract/api/answer": ["{ok}"] }, docs: {} } },
  );
}

{
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const results: string[] = [];
  scenario(
    "S9 a wave runner stopped mid-review: interrupted, one notice, attention; waves.retry lands it once; no resumed review sees an earlier review's tool output",
    ({ role, prompt }) => (role === "reviewer" ? [{ name: "read_diff", args: {} }] : prompt.includes("WRITE b.txt") ? [write("b.txt", "DIFF-SECRET\n")] : undefined),
    async (c) => {
      await c.act("repos.add");
      const before = c.git("rev-parse", "main");
      const { wave } = await c.act("waves.start", { tag: "s9", title: "wave", request: "review", tasks: [{ key: "x", title: "feat: add b", request: "WRITE b.txt" }] });
      await c.until(() => results.length > 0);
      await terminate(wave.id);
      const waited = await c.act("tasks.wait", { wave: wave.id, timeoutMs: 30_000 });
      expect(waited.attention).toEqual([wave.id]);
      release();
      await c.act("waves.retry", { id: wave.id });
      await c.act("tasks.wait", { wave: wave.id, timeoutMs: 60_000 });
      expect((await c.act("waves.get", { id: wave.id })).wave.stage).toBe("merged");
      expect([c.git("rev-parse", "main~1"), c.git("show", "main:b.txt")]).toEqual([before, "DIFF-SECRET"]);
      expect(events(c.notices)).toEqual([`wave:${wave.id}:interrupted`, `wave:${wave.id}:merged`]);
      // The review cut short, its retry, the fit pass: each resumes the session with the earlier tool results (read_diff;
      // read_diff and submit_verdict), never their text.
      expect(results.every((result) => result.includes("DIFF-SECRET"))).toBe(true);
      const reviews = c.calls.filter((call) => call.role === "reviewer").map((call) => (JSON.parse(call.request) as { messages: { role: string }[] }).messages);
      expect(reviews.map((messages) => messages.filter((message) => message.role === "tool").length)).toEqual([0, 1, 3]);
      for (const messages of reviews) expect(JSON.stringify(messages)).not.toContain("DIFF-SECRET");
    },
    {
      afterTool: async ({ role, prompt }) => {
        if (role !== "reviewer") return undefined;
        results.push(prompt);
        if (results.length > 1) return verdict();
        await held;
        return undefined;
      },
    },
  );
}

{
  const never = new Promise<undefined>(() => {});
  scenario(
    "S10 a wave queued after a cancelled one can never start: attention, one notice",
    () => never,
    async (c) => {
      await c.act("repos.add");
      const { wave: a } = await c.act("waves.start", { tag: "s10/a", title: "a", request: "review", tasks: [{ key: "x", title: "feat: add b", request: "WRITE b.txt" }] });
      const { wave: b } = await c.act("waves.start", { tag: "s10/b", title: "b", request: "review", after: [a.id], tasks: [{ key: "y", title: "feat: add c", request: "WRITE c.txt" }] });
      await c.act("waves.cancel", { id: a.id });
      const waited = await c.act("tasks.wait", { wave: b.id, timeoutMs: 30_000 });
      expect(waited.attention).toEqual([b.id]);
      expect((await c.act("waves.get", { id: b.id })).wave.stage).toBe("queued");
      await c.until(() => c.notices.length > 0);
      expect(events(c.notices)).toEqual([`wave:${b.id}:never`]);
      expect(c.git("rev-list", "--count", "main")).toBe("1");
    },
  );
}

scenario(
  "S11 a wave's merge gate that changes a tracked file blocks the wave, the target stays",
  writesNamed,
  async (c) => {
    await c.act("repos.add");
    const main = c.git("rev-parse", "main");
    const { wave } = await c.act("waves.start", { tag: "s11", title: "wave", request: "review", tasks: [{ key: "x", title: "feat: add b", request: "WRITE b.txt" }] });
    const waited = await c.act("tasks.wait", { wave: wave.id, timeoutMs: 60_000 });
    expect(waited.attention).toEqual([wave.id]);
    expect((await c.act("waves.get", { id: wave.id })).wave.stage).toBe("blocked");
    expect(c.git("rev-parse", "main")).toBe(main);
  },
  { factory: "merge_gates:\n  - [sh, -c, 'echo dirty >> a.txt']\n" },
);
