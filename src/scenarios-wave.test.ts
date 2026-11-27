/** Waves that land, end to end (`scenario-kit.ts`): real git, runners and `pi`; the model scripted. Outcome only. */
import { expect } from "bun:test";
import { events, scenario, verdict, writesNamed, type ToolCall } from "./scenario-kit.ts";

scenario(
  "S4 a wave of two chained tasks squashes onto the target, a parallel wave lands on top",
  writesNamed,
  async (c) => {
    await c.act("repos.add");
    const { wave: a } = await c.act("waves.start", {
      tag: "s4/a",
      title: "wave a",
      request: "review",
      overrides: { squash: true },
      tasks: [
        { key: "x", title: "feat: add b", request: "WRITE b.txt" },
        { key: "y", title: "feat: add c", request: "WRITE c.txt", after: ["x"] },
      ],
    });
    const { wave: b } = await c.act("waves.start", { tag: "s4/b", title: "wave b", request: "review", tasks: [{ key: "z", title: "feat: add d", request: "WRITE d.txt" }] });
    const waited = await c.act("tasks.wait", { tag: "s4", timeoutMs: 60_000 });
    expect([waited.timedOut, waited.attention]).toEqual([false, []]);
    const [doneA, doneB] = [(await c.act("waves.get", { id: a.id })).wave, (await c.act("waves.get", { id: b.id })).wave];
    expect([doneA.stage, doneB.stage]).toEqual(["merged", "merged"]);
    const x = doneA.tasks.find((task: { key: string }) => task.key === "x");
    const y = doneA.tasks.find((task: { key: string }) => task.key === "y");
    expect(Date.parse((await c.act("tasks.get", { id: y.taskId })).createdAt)).toBeGreaterThanOrEqual(Date.parse((await c.act("tasks.get", { id: x.taskId })).at));
    // A's squash is one commit on the target, its task commits kept under its ref; B is on the same line.
    expect(c.git("rev-list", "--count", `${doneA.merge.from}..${doneA.merge.to}`)).toBe("1");
    expect(c.git("rev-list", "--count", `${doneA.merge.from}..${doneA.merge.ref}`)).toBe("2");
    for (const file of ["b.txt", "c.txt", "d.txt"]) expect(c.git("show", `main:${file}`)).toBe(file);
    expect(c.git("rev-list", "--merges", "--count", "main")).toBe("0");
    // Exactly the two merges: no `interrupted` for a task or wave whose runner ended after its last state.
    expect(events(c.notices).sort()).toEqual([`wave:${a.id}:merged`, `wave:${b.id}:merged`].sort());
    expect(doneA.usage.cost).toBeGreaterThan(0);
  },
);

/** The fit pass's prompt; a task review's may name the fit too (a fix task's title). */
const FIT = "Review how the tasks of the wave";
const fixes = (...paths: string[]): ToolCall[] => paths.map((path) => ({ name: "start_fix", args: { title: `fix: add ${path}`, request: `WRITE ${path}` } }));

scenario(
  "S5 a rejecting fit review adds a fix task, the wave builds again and merges",
  (() => {
    let fits = 0;
    return (call) => {
      if (call.role === "reviewer") return call.prompt.includes(FIT) && ++fits === 1 ? verdict({ file: "b.txt", severity: "major", text: "FIT-MAJOR WRITE e.txt" }) : verdict();
      return writesNamed(call);
    };
  })(),
  async (c) => {
    await c.act("repos.add");
    const { wave } = await c.act("waves.start", { tag: "s5", title: "wave", request: "review", tasks: [{ key: "x", title: "feat: add b", request: "WRITE b.txt" }] });
    const waited = await c.act("tasks.wait", { wave: wave.id, timeoutMs: 60_000 });
    expect(waited.attention).toEqual([]);
    const merged = (await c.act("waves.get", { id: wave.id })).wave;
    expect([merged.stage, merged.tasks.length]).toEqual(["merged", 2]);
    for (const file of ["b.txt", "e.txt"]) expect(c.git("show", `main:${file}`)).toBe(file);
    expect(events(c.notices)).toEqual([`wave:${wave.id}:fix`, `wave:${wave.id}:merged`]);
  },
);

scenario(
  "S5 with its fix tasks used up a rejecting fit review rejects the wave to the supervisor, once",
  (() => {
    let reviews = 0;
    return (call) => {
      if (call.role === "coder") return writesNamed(call);
      if (call.prompt.includes(FIT)) return verdict({ file: "b.txt", severity: "major", text: "FIT-MAJOR WRITE e.txt" });
      return ++reviews === 1 ? [...fixes("f1.txt", "f2.txt"), ...(verdict() as ToolCall[])] : verdict();
    };
  })(),
  async (c) => {
    await c.act("repos.add");
    const { wave } = await c.act("waves.start", { tag: "s5", title: "wave", request: "review", tasks: [{ key: "x", title: "feat: add b", request: "WRITE b.txt" }] });
    const waited = await c.act("tasks.wait", { wave: wave.id, timeoutMs: 90_000 });
    expect(waited.attention).toEqual([wave.id]);
    const rejected = (await c.act("waves.get", { id: wave.id })).wave;
    expect([rejected.stage, rejected.tasks.length]).toEqual(["rejected", 4]);
    expect(c.git("rev-list", "--count", "main")).toBe("1");
    await c.until(() => events(c.notices).includes(`wave:${wave.id}:rejected`));
    expect(events(c.notices).sort()).toEqual([...Array(3).fill(`wave:${wave.id}:fix`), `wave:${wave.id}:rejected`]);
  },
  {},
  120_000,
);

scenario("S10 a wave queued after another starts once that one merged, cut at the new tip", writesNamed, async (c) => {
  await c.act("repos.add");
  const { wave: a } = await c.act("waves.start", { tag: "s10/a", title: "a", request: "review", tasks: [{ key: "x", title: "feat: add b", request: "WRITE b.txt" }] });
  const { wave: b } = await c.act("waves.start", { tag: "s10/b", title: "b", request: "review", after: [a.id], tasks: [{ key: "y", title: "feat: add c", request: "WRITE c.txt" }] });
  expect(b.stage).toBe("queued");
  await c.act("tasks.wait", { tag: "s10", timeoutMs: 60_000 });
  const [doneA, doneB] = [(await c.act("waves.get", { id: a.id })).wave, (await c.act("waves.get", { id: b.id })).wave];
  expect([doneA.stage, doneB.stage]).toEqual(["merged", "merged"]);
  expect(doneB.merge.from).toBe(doneA.merge.to);
  expect(c.git("rev-list", "--count", "main")).toBe("3");
});
