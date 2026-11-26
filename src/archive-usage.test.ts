/** Cost from the archive (contract archive-1): `archivedWaves`, `waves.list {archived}`, `waves.get` of a removed wave. */
import { describe, expect } from "bun:test";
import { mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { archiveWave, waveArchiveDir } from "./archive.ts";
import { callAction } from "./core.ts";
import { caseDir, expectError, fakeRecord, makeRepo, RUN, useCoreFixture, writeSession } from "./core-test-kit.ts";
import { archivedWaves, type ArchivedWaveView } from "./core-waves.ts";
import { callerKey, scoutsDir, type ScoutCaller } from "./scouts.ts";
import { caseDigits, caseSerial, caseTests } from "./test-case.ts";
import { writeTask } from "./tasks.ts";
import { appendWaveEvents, createWave, foldWave, readWave, type WaveView } from "./waves.ts";

useCoreFixture();

const test = caseTests();
const waveId = (n: number): string => `a7000000-${RUN}-4000-8000-${caseDigits(caseSerial() * 100 + n)}`;
const taskId = (n: number): string => `a8000000-${RUN}-4000-8000-${caseDigits(caseSerial() * 100 + n)}`;

const spec = (key: string) => ({ key, title: `Task ${key}`, request: `do ${key}`, after: [] });
const state = (name: string) => ({ type: "custom", customType: "factory-state", timestamp: "t", data: { state: name, round: 1, reason: "r" } });
const usage = (total: number, input = 1) => ({ type: "message", message: { role: "assistant", usage: { input, output: 2, cacheRead: 3, cost: { total } } } });

function writeScout(caller: ScoutCaller, id: string, cost: number): void {
  const dir = join(scoutsDir(), callerKey(caller), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "scout.json"), `${JSON.stringify({ id, caller, concern: "c" })}\n`);
  writeFileSync(join(dir, "events.jsonl"), `${JSON.stringify({ kind: "usage", usage: { input: 5, output: 6, cost } })}\n`);
}

/** A cancelled wave with two done tasks (sessions, scouts), a review and a scout of its own, archivable. */
async function costlyWave(id: string, repo: string, tag: string, opts: { plan?: string | null; origin?: string | null; createdAt?: string; first?: number } = {}): Promise<void> {
  const first = opts.first ?? 1;
  await createWave({ id, repo, tag, plan: opts.plan ?? null, title: `wave ${tag}`, request: "r", branch: `main-${tag}`, target: "main", base: "abc", origin: opts.origin ?? null, createdAt: opts.createdAt ?? "2026-01-01T00:00:00.000Z", overrides: {} });
  const a = { ...fakeRecord(taskId(first), repo), wave: id };
  const b = { ...fakeRecord(taskId(first + 1), repo), wave: id };
  for (const record of [a, b]) await writeTask(record);
  writeSession(a, [state("running"), usage(41.3753614, 10), state("done")]);
  writeSession(b, [state("running"), usage(0.004), usage(0.004), state("done")]);
  writeScout({ kind: "task", id: a.id }, "scout-a", 0.0031);
  writeScout({ kind: "wave", id }, "scout-w", 0.0042);
  await appendWaveEvents(id, [
    { kind: "tasks", tasks: [spec("a"), spec("b"), spec("c")] },
    { kind: "task", key: "a", taskId: a.id, sessionId: a.sessionId },
    { kind: "task", key: "b", taskId: b.id, sessionId: b.sessionId },
    { kind: "review", round: 1, sessionId: "rev", model: "a/b", verdict: "approved", status: "ok", findings: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 7, cost: 0.004 }, wallMs: 5 },
    { kind: "stage", stage: "cancelled", reason: null },
  ]);
}

const getWave = async (id: string) => ((await callAction("waves.get", { id })) as { wave: WaveView & { archived?: true; feedback?: unknown } }).wave;
const list = async (params: object, cwd?: string) => ((await callAction("waves.list", params, cwd === undefined ? {} : { cwd })) as { waves: (WaveView & { archived?: true })[] }).waves;

describe("cost from the archive", () => {
  test("a removed wave's cost from the archive equals its cost before removal, to the cent; waves.get answers it", async () => {
    const store = join(caseDir, "store");
    process.env.MEMORY_STORE_ROOT = store;
    mkdirSync(join(store, "team", "plan"), { recursive: true });
    const repo = makeRepo();
    const id = waveId(1);
    await costlyWave(id, repo, "arch/w1", { plan: "team/plan", origin: "session-x" });
    const before = await getWave(id);
    expect(before.usage?.cost).toBe(41.39);
    expect(await callAction("waves.remove", { id })).toEqual({ removed: id });
    const dir = waveArchiveDir({ id, tag: "arch/w1", plan: "team/plan" });
    expect(dir.startsWith(join(store, "team", "plan", "run", "sessions"))).toBe(true);
    expect(readdirSync(dir)).toContain("wave.jsonl");
    const after = await getWave(id.slice(0, 12));
    expect(after.archived).toBe(true);
    expect([after.running, after.interrupted, after.actions]).toEqual([false, false, []]);
    expect([after.usage, after.scoutingCost, after.tasks.map((task) => [task.key, task.state, task.usage]), after.counts, after.reviews, after.stage]).toEqual([
      before.usage,
      before.scoutingCost,
      before.tasks.map((task) => [task.key, task.state, task.usage]),
      before.counts,
      before.reviews,
      "cancelled",
    ]);
    await expectError(callAction("waves.get", { id: `a7000000-${RUN}-4000-8000-ffffffffffff` }), "not_found", "no wave");
  });

  test("waves.list {archived: true} adds the archived waves without live record, with the same filters; open and no param leave them out", async () => {
    process.env.MEMORY_STORE_ROOT = join(caseDir, "no-store");
    const repo = makeRepo();
    const other = makeRepo(true, "other");
    const [removed, kept, foreign] = [waveId(1), waveId(2), waveId(3)];
    await costlyWave(removed, repo, "arch/w1", { origin: "session-a", createdAt: "2026-01-01T00:00:01.000Z", first: 1 });
    await costlyWave(kept, repo, "arch/w2", { origin: "session-b", createdAt: "2026-01-01T00:00:02.000Z", first: 3 });
    await costlyWave(foreign, other, "else/w3", { origin: "session-a", createdAt: "2026-01-01T00:00:03.000Z", first: 5 });
    await callAction("waves.remove", { id: removed });
    await callAction("waves.remove", { id: foreign });
    // The live wave archived too (a merge archives it): listed once, live.
    const keptFile = await readWave(kept);
    await archiveWave(foldWave(keptFile.declaration, keptFile.events));
    const tags = (waves: { tag: string; archived?: true }[]) => waves.map((wave) => [wave.tag, wave.archived ?? false]);
    expect(tags(await list({}))).toEqual([["arch/w2", false]]);
    expect(tags(await list({ archived: true }))).toEqual([
      ["arch/w2", false],
      ["arch/w1", true],
      ["else/w3", true],
    ]);
    expect(tags(await list({ archived: true, open: true }))).toEqual([]);
    expect(tags(await list({ archived: true, tag: "arch" }))).toEqual([
      ["arch/w2", false],
      ["arch/w1", true],
    ]);
    expect(tags(await list({ archived: true, origin: "session-a" }))).toEqual([
      ["arch/w1", true],
      ["else/w3", true],
    ]);
    expect(tags(await list({ archived: true, repo: other }, repo))).toEqual([["else/w3", true]]);
    await expectError(list({ archived: "yes" }), "invalid", "archived");
  });

  test("50 archived waves listed twice read no session file the second time", async () => {
    process.env.MEMORY_STORE_ROOT = join(caseDir, "no-store");
    const repo = makeRepo();
    for (let n = 0; n < 50; n++) {
      const id = waveId(n);
      await costlyWave(id, repo, `many/w${n}`, { createdAt: `2026-01-01T00:00:${String(n).padStart(2, "0")}.000Z`, first: 2 * n });
      await callAction("waves.remove", { id });
    }
    const first = await archivedWaves({ tag: "many" });
    expect(first).toHaveLength(50);
    expect(first.every((wave: ArchivedWaveView) => wave.usage?.cost === 41.39 && wave.tasks[0]?.state === "done")).toBe(true);
    // Same size and mtime, other content: a read would see no state and no usage.
    for (const wave of first) {
      for (const key of ["a", "b"]) {
        const path = join(waveArchiveDir(wave), "tasks", `${key}.jsonl`);
        const { size, mtime } = statSync(path);
        writeFileSync(path, " ".repeat(size));
        utimesSync(path, mtime, mtime);
      }
    }
    expect(await archivedWaves({ tag: "many" })).toEqual(first);
  });
});
