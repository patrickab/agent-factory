import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactoryError } from "./core.ts";
import { factoryHome } from "./settings.ts";
import { tasksDir } from "./tasks.ts";
import {
  allCancelled,
  appendWaveEvent,
  createWave,
  foldWave,
  listWaves,
  readWave,
  readyForReview,
  removeWave,
  startableKeys,
  unreachableKeys,
  validateTaskSpecs,
  waveCounts,
  waveLockPath,
  waveLogPath,
  wavePath,
  wavesDir,
  waveTaskState,
  type WaveDeclaration,
  type WaveEvent,
  type WaveFold,
} from "./waves.ts";

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
    ...overrides,
  };
}

const spec = (key: string, after: string[] = []) => ({ key, title: `Task ${key}`, request: `do ${key}`, after });
const states = (entries: Record<string, string | null>) => new Map(Object.entries(entries));

function folded(tasks: ReturnType<typeof spec>[], started: string[] = []): WaveFold {
  const events: WaveEvent[] = [{ at: "t1", kind: "tasks", tasks }];
  for (const key of started) events.push({ at: "t2", kind: "task", key, taskId: `id-${key}`, sessionId: `s-${key}` });
  return foldWave(declaration(ONE), events);
}

describe("wave records", () => {
  test("live in <factoryHome>/waves/<id>.jsonl next to the tasks, with lock and log", async () => {
    await createWave(declaration(ONE));
    expect(wavesDir()).toBe(join(factoryHome(), "waves"));
    expect(join(tasksDir(), "..")).toBe(join(wavesDir(), ".."));
    expect(wavePath(ONE)).toBe(join(wavesDir(), `${ONE}.jsonl`));
    expect(waveLockPath(ONE)).toBe(join(wavesDir(), `${ONE}.lock`));
    expect(waveLogPath(ONE)).toBe(join(wavesDir(), `${ONE}.log`));
    expect(readdirSync(wavesDir())).toEqual([`${ONE}.jsonl`]);
    expect(await readWave(ONE)).toEqual({ declaration: declaration(ONE), events: [] });
  });

  test("create refuses an existing wave and an id that is no wave id", async () => {
    await createWave(declaration(ONE));
    await expect(createWave(declaration(ONE, { title: "again" }))).rejects.toThrow();
    await expect(createWave(declaration("../x"))).rejects.toThrow("not a wave id");
    expect((await readWave(ONE)).declaration.title).toBe("Wave one");
    expect(readdirSync(wavesDir())).toEqual([`${ONE}.jsonl`]);
  });

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

  test("append refuses an unknown wave and an invalid event, and writes nothing then", async () => {
    await expect(appendWaveEvent(ONE, { kind: "stage", stage: "merged", reason: null })).rejects.toMatchObject({ code: "not_found" });
    await createWave(declaration(ONE));
    await expect(appendWaveEvent(ONE, { kind: "stage", stage: "done" as "merged", reason: null })).rejects.toThrow("stage must be one of");
    expect((await readWave(ONE)).events).toEqual([]);
  });

  test("a torn line is skipped and the next append starts a line of its own", async () => {
    await createWave(declaration(ONE));
    appendFileSync(wavePath(ONE), '{"at":"t1","kind":"sta');
    expect((await readWave(ONE)).events).toEqual([]);
    await appendWaveEvent(ONE, { at: "t2", kind: "stage", stage: "blocked", reason: "infra" });
    expect((await readWave(ONE)).events).toEqual([{ at: "t2", kind: "stage", stage: "blocked", reason: "infra" }]);
  });

  test("readWave: not_found for a missing wave or a bad id, an error naming the file when invalid", async () => {
    await expect(readWave(ONE)).rejects.toBeInstanceOf(FactoryError);
    await expect(readWave("../../etc/passwd")).rejects.toMatchObject({ code: "not_found" });
    await createWave(declaration(ONE));
    appendFileSync(wavePath(ONE), `${JSON.stringify({ at: "t", kind: "nope" })}\n`);
    await expect(readWave(ONE)).rejects.toThrow(`${wavePath(ONE)}: line 2: kind "nope" is no wave event`);
  });

  test("listWaves: oldest first, filtered by repo, skips invalid and temp files", async () => {
    expect(await listWaves()).toEqual([]);
    await createWave(declaration(uuid(2), { createdAt: "2026-03-01T00:00:00.000Z" }));
    await createWave(declaration(uuid(3), { createdAt: "2026-02-01T00:00:00.000Z" }));
    await createWave(declaration(uuid(4), { repo: "/repo/b" }));
    writeFileSync(wavePath(uuid(5)), "{\n");
    writeFileSync(wavePath(uuid(6)), `${JSON.stringify(declaration(uuid(7)))}\n`);
    writeFileSync(wavePath(uuid(8)), `${JSON.stringify({ ...declaration(uuid(8)), tag: 3 })}\n`);
    writeFileSync(wavePath(uuid(9)), "");
    writeFileSync(join(wavesDir(), "x.jsonl.1.tmp"), "{}");
    writeFileSync(join(wavesDir(), "not-an-id.jsonl"), `${JSON.stringify(declaration("not-an-id"))}\n`);
    expect((await listWaves()).map((wave) => wave.declaration.id)).toEqual([uuid(4), uuid(3), uuid(2)]);
    expect((await listWaves("/repo/a")).map((wave) => wave.declaration.id)).toEqual([uuid(3), uuid(2)]);
  });

  test("removeWave removes the file, log and lock", async () => {
    await createWave(declaration(ONE));
    writeFileSync(waveLogPath(ONE), "log");
    writeFileSync(waveLockPath(ONE), "1 1");
    await removeWave(ONE);
    expect(readdirSync(wavesDir())).toEqual([]);
    await removeWave("../x");
    expect(existsSync(wavesDir())).toBe(true);
  });
});

describe("foldWave", () => {
  test("a declared wave is building with nothing else", () => {
    expect(foldWave(declaration(ONE), [])).toEqual({ ...declaration(ONE), stage: "building", reason: null, tasks: [], reviews: [], gates: [], merge: null, remote: null });
  });

  test("tasks and task: specs in order, ids once started; unknown keys and repeated keys change nothing", () => {
    const fold = foldWave(declaration(ONE), [
      { at: "t1", kind: "tasks", tasks: [spec("a"), spec("b", ["a"])] },
      { at: "t2", kind: "task", key: "a", taskId: "id-a", sessionId: "s-a" },
      { at: "t3", kind: "task", key: "zz", taskId: "id-z", sessionId: "s-z" },
      { at: "t4", kind: "tasks", tasks: [spec("c", ["a", "b"]), { ...spec("a"), title: "dup" }] },
    ]);
    expect(fold.tasks).toEqual([
      { ...spec("a"), taskId: "id-a", sessionId: "s-a" },
      { ...spec("b", ["a"]), taskId: null, sessionId: null },
      { ...spec("c", ["a", "b"]), taskId: null, sessionId: null },
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
      usage: { input: 10, output: 5, cost: 0.1 },
      wallMs: 900,
    };
    const fold = foldWave(declaration(ONE), [
      { at: "t1", kind: "gate", phase: "review", passed: true, wallMs: 100, log: "/logs/g1" },
      { at: "t2", kind: "review", ...review },
      { at: "t3", kind: "gate", phase: "merge", passed: false, wallMs: 50, log: null },
      { at: "t4", kind: "merge", from: "abc", to: "def", queueMs: 7 },
      { at: "t5", kind: "merge", from: "def", to: "fed", queueMs: 8 },
    ]);
    expect(fold.gates).toEqual([
      { at: "t1", phase: "review", passed: true, wallMs: 100, log: "/logs/g1" },
      { at: "t3", phase: "merge", passed: false, wallMs: 50, log: null },
    ]);
    expect(fold.reviews).toEqual([{ at: "t2", ...review }]);
    expect(fold.merge).toEqual({ at: "t5", from: "def", to: "fed", queueMs: 8 });
  });

  test("remote: each event sets the fields it carries", () => {
    const fold = foldWave(declaration(ONE), [
      { at: "t1", kind: "remote", number: 12, url: "https://forge/pr/12" },
      { at: "t2", kind: "remote", pushed: "abc" },
      { at: "t3", kind: "remote", error: "push refused" },
    ]);
    expect(fold.remote).toEqual({ number: 12, url: "https://forge/pr/12", pushed: "abc", error: "push refused" });
  });

  test("replays a file written by appendWaveEvent", async () => {
    await createWave(declaration(ONE));
    await appendWaveEvent(ONE, { at: "t1", kind: "tasks", tasks: [spec("a")] });
    await appendWaveEvent(ONE, { at: "t2", kind: "task", key: "a", taskId: "id-a", sessionId: "s-a" });
    await appendWaveEvent(ONE, { at: "t3", kind: "stage", stage: "merged", reason: null });
    const { declaration: declared, events } = await readWave(ONE);
    const fold = foldWave(declared, events);
    expect(fold.stage).toBe("merged");
    expect(fold.tasks[0]?.taskId).toBe("id-a");
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

  test("returns the specs with after defaulted and deduplicated; after may name existing keys", () => {
    expect(validateTaskSpecs([{ key: "a.1_x-y", title: "A", request: "do a" }, { key: "b", title: "B", request: "do b", after: ["a.1_x-y", "old", "old"] }], [{ key: "old" }])).toEqual([
      { key: "a.1_x-y", title: "A", request: "do a", after: [] },
      { key: "b", title: "B", request: "do b", after: ["a.1_x-y", "old"] },
    ]);
  });

  test("refuses bad shapes", () => {
    invalid([], [], "non-empty array");
    invalid("a", [], "non-empty array");
    invalid([3], [], "tasks[0] must be an object");
    invalid([{ key: "a/b", title: "A", request: "r" }], [], "tasks[0].key");
    invalid([{ key: "", title: "A", request: "r" }], [], "tasks[0].key");
    invalid([{ key: "a", title: " ", request: "r" }], [], "tasks[0].title");
    invalid([{ key: "a", title: "A" }], [], "tasks[0].request");
    invalid([{ key: "a", title: "A", request: "r", after: "b" }], [], "tasks[0].after");
  });

  test("refuses a repeated key, an unknown or own after, and a cycle", () => {
    invalid([spec("a"), spec("a")], [], "task key a is not unique");
    invalid([spec("a")], [{ key: "a" }], "task key a is not unique");
    invalid([spec("a", ["x"])], [{ key: "b" }], "task a waits for x, no task of the wave");
    invalid([spec("a", ["a"])], [], "task a waits for itself");
    invalid([spec("a", ["c"]), spec("b", ["a"]), spec("c", ["b"])], [], "cycle: a -> c -> b -> a");
  });
});
