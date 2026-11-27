import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactoryError } from "./core.ts";
import { allCancelled, appendWaveEvent, createWave, foldWave, readWave, readyForReview, startableKeys, stuckKeys, unreachableKeys, validateTaskSpecs, waveCounts, waveTaskState, type WaveDeclaration, type WaveEvent, type WaveFold } from "./waves.ts";
import { wavePath } from "./wave-poke.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "factory-waves-test-")));
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");

afterAll(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(join(scratch, "agent"), { recursive: true, force: true });
});

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}
const ONE = uuid(1);

function declaration(id: string, overrides: Partial<WaveDeclaration> = {}): WaveDeclaration {
  return {
    id,
    repo: "/repo/a",
    tag: "factory/w1",
    plan: "plan/w1.md",
    title: "Wave one",
    request: "Review the wave",
    branch: "main-factory-w1",
    target: "main",
    base: "abc123",
    origin: "session-0",
    createdAt: "2026-01-01T00:00:00.000Z",
    overrides: {},
    ...overrides,
  };
}

const spec = (key: string, after: string[] = []) => ({ key, title: `Task ${key}`, request: `do ${key}`, after, id: `id-${key}` });
const states = (entries: Record<string, string | null>) => new Map(Object.entries(entries));

function folded(tasks: ReturnType<typeof spec>[], started: string[] = []): WaveFold {
  const events: WaveEvent[] = [{ at: "t1", kind: "tasks", tasks }];
  for (const key of started) events.push({ at: "t2", kind: "task", key, taskId: `id-${key}`, sessionId: `s-${key}` });
  return foldWave(declaration(ONE), events);
}

describe("wave records", () => {

  test("events append one per line and read back in order; at defaults to now", async () => {
    await createWave(declaration(ONE));
    await appendWaveEvent(ONE, { at: "t1", kind: "tasks", tasks: [spec("a")] });
    const stage = await appendWaveEvent(ONE, { kind: "stage", stage: "reviewing", reason: null });
    expect(stage.at).toMatch(/^\d{4}-\d\d-\d\dT/);
    const lines = readFileSync(wavePath(ONE), "utf8").split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe("");
    expect((await readWave(ONE)).events).toEqual([{ at: "t1", kind: "tasks", tasks: [spec("a")] }, stage]);
  });

  test("a torn line is skipped and the next append starts a line of its own", async () => {
    await createWave(declaration(ONE));
    appendFileSync(wavePath(ONE), '{"at":"t1","kind":"sta');
    expect((await readWave(ONE)).events).toEqual([]);
    await appendWaveEvent(ONE, { at: "t2", kind: "stage", stage: "blocked", reason: "infra" });
    expect((await readWave(ONE)).events).toEqual([{ at: "t2", kind: "stage", stage: "blocked", reason: "infra" }]);
  });

});

describe("foldWave", () => {

  test("tasks and task: specs in order, ids once started; unknown keys and repeated keys change nothing", () => {
    const fold = foldWave(declaration(ONE), [
      { at: "t1", kind: "tasks", tasks: [spec("a"), spec("b", ["a"])] },
      { at: "t2", kind: "task", key: "a", taskId: "id-a", sessionId: "s-a" },
      { at: "t3", kind: "task", key: "zz", taskId: "id-z", sessionId: "s-z" },
      { at: "t4", kind: "tasks", tasks: [spec("c", ["a", "b"]), { ...spec("a"), title: "dup" }] },
    ]);
    expect(fold.tasks).toEqual([
      { ...spec("a"), model: "big", taskId: "id-a", sessionId: "s-a" },
      { ...spec("b", ["a"]), model: "big", taskId: null, sessionId: null },
      { ...spec("c", ["a", "b"]), model: "big", taskId: null, sessionId: null },
    ]);
  });

  test("stage: the last one wins, the reason only while blocked", () => {
    const blocked = foldWave(declaration(ONE), [
      { at: "t1", kind: "stage", stage: "reviewing", reason: null },
      { at: "t2", kind: "stage", stage: "blocked", reason: "conflict" },
    ]);
    expect([blocked.stage, blocked.reason]).toEqual(["blocked", "conflict"]);
    const rejected = foldWave(declaration(ONE), [{ at: "t1", kind: "stage", stage: "rejected", reason: "gates" }]);
    expect([rejected.stage, rejected.reason]).toEqual(["rejected", null]);
  });

  test("gate, review and merge collect in order; merge keeps the last", () => {
    const review = {
      round: 1,
      sessionId: "r-1",
      model: "anthropic/claude",
      verdict: "rejected" as const,
      status: "ok",
      findings: [{ severity: "major" as const, file: "src/a.ts", line: 3, text: "wrong" }],
      usage: { input: 10, output: 5, cacheRead: 40, cacheWrite: 2, cost: 0.1 },
      wallMs: 900,
    };
    const fold = foldWave(declaration(ONE), [
      { at: "t1", kind: "gate", phase: "review", passed: true, wallMs: 100, log: "/logs/g1" },
      { at: "t2", kind: "review", ...review },
      { at: "t3", kind: "gate", phase: "merge", passed: false, wallMs: 50, log: null },
      { at: "t4", kind: "merge", from: "abc", to: "def" },
      { at: "t5", kind: "merge", from: "def", to: "fed" },
    ]);
    expect(fold.gates).toEqual([
      { at: "t1", phase: "review", passed: true, wallMs: 100, log: "/logs/g1" },
      { at: "t3", phase: "merge", passed: false, wallMs: 50, log: null },
    ]);
    expect(fold.reviews).toEqual([{ at: "t2", ...review }]);
    expect(fold.merge).toEqual({ at: "t5", from: "def", to: "fed" });
  });

});

describe("scheduling", () => {
  const fold = () => folded([spec("a"), spec("b"), spec("c", ["a", "b"]), spec("d", ["c"])], ["a", "b"]);

  test("waveTaskState: pending before start, running before the first state", () => {
    const f = fold();
    expect(f.tasks.map((task) => waveTaskState(task, states({ a: "blocked", d: "done" })))).toEqual(["blocked", "running", "pending", "pending"]);
  });

  test("startableKeys: unstarted tasks whose after tasks are all done", () => {
    expect(startableKeys(fold(), states({ a: "done", b: "running" }))).toEqual([]);
    expect(startableKeys(fold(), states({ a: "done", b: "done" }))).toEqual(["c"]);
    expect(startableKeys(folded([spec("a"), spec("b", ["a"]), spec("c")]), states({}))).toEqual(["a", "c"]);
  });

  test("unreachableKeys: unstarted tasks behind a cancelled one, directly or not", () => {
    expect(unreachableKeys(fold(), states({ a: "done", b: "running" }))).toEqual([]);
    expect(unreachableKeys(fold(), states({ a: "cancelled", b: "done" }))).toEqual(["c", "d"]);
  });

  test("stuckKeys: unreachable tasks once nothing can start and no started task is active", () => {
    // c and d wait behind the cancelled a; b still runs (or has no state yet): it may poke the wave, nothing is stuck yet.
    expect(stuckKeys(fold(), states({ a: "cancelled", b: "running" }))).toEqual([]);
    expect(stuckKeys(fold(), states({ a: "cancelled" }))).toEqual([]);
    expect(stuckKeys(fold(), states({ a: "cancelled", b: null }))).toEqual([]);
    // Every started task rests: nothing will ever move the wave without the supervisor.
    expect(stuckKeys(fold(), states({ a: "cancelled", b: "done" }))).toEqual(["c", "d"]);
    expect(stuckKeys(fold(), states({ a: "cancelled", b: "blocked" }))).toEqual(["c", "d"]);
    // A task that can still start is no stuck wave: the runner starts it.
    const startable = folded([spec("a"), spec("b", ["a"]), spec("c")], ["a"]);
    expect(stuckKeys(startable, states({ a: "cancelled" }))).toEqual([]);
    expect(stuckKeys(fold(), states({ a: "done", b: "done" }))).toEqual([]);
  });

  test("a tasks event's dropped keys: pending tasks that count as cancelled from then on; started ones stay", () => {
    const events: WaveEvent[] = [
      { at: "t1", kind: "tasks", tasks: [spec("a"), spec("b", ["a"]), spec("c", ["b"])] },
      { at: "t2", kind: "task", key: "a", taskId: "id-a", sessionId: "s-a" },
      { at: "t3", kind: "tasks", tasks: [spec("d", ["a"])], dropped: ["a", "b", "c", "nope"] },
    ];
    const f = foldWave(declaration(ONE), events);
    const done = states({ a: "cancelled" });
    expect(f.tasks.map((task) => [task.key, waveTaskState(task, done)])).toEqual([
      ["a", "cancelled"],
      ["b", "cancelled"],
      ["c", "cancelled"],
      ["d", "pending"],
    ]);
    expect([unreachableKeys(f, done), startableKeys(f, states({ a: "done" })), waveCounts(f, done)]).toEqual([["d"], ["d"], { total: 1, done: 0 }]);
    expect(f.tasks[0]?.dropped).toBeUndefined();
  });

  test("readyForReview: every task done or cancelled, at least one done", () => {
    const all = folded([spec("a"), spec("b"), spec("c", ["a"])], ["a", "b", "c"]);
    expect(readyForReview(all, states({ a: "done", b: "cancelled", c: "done" }))).toBe(true);
    expect(readyForReview(all, states({ a: "done", b: "blocked", c: "done" }))).toBe(false);
    expect(readyForReview(all, states({ a: "cancelled", b: "cancelled", c: "cancelled" }))).toBe(false);
    expect(readyForReview(fold(), states({ a: "done", b: "done" }))).toBe(false);
    expect(readyForReview(folded([]), states({}))).toBe(false);
  });

  test("allCancelled: tasks, all cancelled", () => {
    const all = folded([spec("a"), spec("b")], ["a", "b"]);
    expect(allCancelled(all, states({ a: "cancelled", b: "cancelled" }))).toBe(true);
    expect(allCancelled(all, states({ a: "cancelled", b: "done" }))).toBe(false);
    expect(allCancelled(folded([spec("a"), spec("b")], ["a"]), states({ a: "cancelled" }))).toBe(false);
    expect(allCancelled(folded([]), states({}))).toBe(false);
  });

  test("waveCounts: cancelled tasks are in neither", () => {
    expect(waveCounts(fold(), states({ a: "done", b: "cancelled" }))).toEqual({ total: 3, done: 1 });
    expect(waveCounts(fold(), states({}))).toEqual({ total: 4, done: 0 });
  });
});

describe("validateTaskSpecs", () => {
  const invalid = (raw: unknown, existing: { key: string }[], message: string) => {
    try {
      validateTaskSpecs(raw, existing);
    } catch (error) {
      expect(error).toBeInstanceOf(FactoryError);
      expect((error as FactoryError).code).toBe("invalid");
      expect((error as Error).message).toContain(message);
      return;
    }
    throw new Error("validateTaskSpecs accepted the specs");
  };

  test("refuses a repeated key, an unknown or own after, and a cycle", () => {
    invalid([spec("a"), spec("a")], [], "task key a is not unique");
    invalid([spec("a")], [{ key: "a" }], "task key a is not unique");
    invalid([spec("a", ["x"])], [{ key: "b" }], "task a waits for x, no task of the wave");
    invalid([spec("a", ["a"])], [], "task a waits for itself");
    invalid([spec("a", ["c"]), spec("b", ["a"]), spec("c", ["b"])], [], "cycle: a -> c -> b -> a");
  });
});
