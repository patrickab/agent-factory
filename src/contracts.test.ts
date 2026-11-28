/** Contracts (`contracts.ts`, `core-contracts.ts`): `waves.start` contracts, the launch prefix, `contracts.apply`, the runner's check, over a fake memory-store. */
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { contractCheck, contractsForLaunch, readContract, stampOf } from "./contracts.ts";
import { waveContracts } from "./core-contracts.ts";
import { callAction } from "./core.ts";
import { caseDir, expectError, fakeRecord, makeRepo, RUN, scratch, testPath, until, TASK_ENTRY, useCoreFixture, writeSession } from "./core-test-kit.ts";
import { readStore, writeFakeMemoryStore, writeStore } from "./fake-memory-store.ts";
import { readTask, writeTask, type TaskRecord } from "./tasks.ts";
import { appendWaveEvent, createWave, readWave, type WaveView } from "./waves.ts";

useCoreFixture();

const STORE = "team/plan";
const ID_4 = `abc40000-${RUN}-4000-8000-000000000004`;
let storeRoot: string;
let messages: string;

const sentMessages = (): string[] => (existsSync(messages) ? readFileSync(messages, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string) : []);

beforeEach(() => {
  const bin = join(scratch, "store-bin");
  if (!existsSync(join(bin, "memory-store"))) writeFakeMemoryStore(bin);
  storeRoot = join(caseDir, "stores");
  messages = join(caseDir, "messages.log");
  Object.assign(process.env, { PATH: `${bin}:${testPath}`, FAKE_STORE_ROOT: storeRoot, FAKE_PI_MESSAGE_LOG: messages });
  writeStore(storeRoot, STORE, {
    memories: { "run/contract/api/answer": ["{ok}"], "run/contract/api/errors/codes": ["400 and 404"], "map/other": ["not a contract"] },
    docs: { "run/contract/core.md": "core rules", "run/contract/one.md": "one document" },
  });
});

async function registeredRepo(): Promise<string> {
  const repo = makeRepo();
  await callAction("repos.add", {}, { cwd: repo });
  return repo;
}

describe("reading contracts", () => {
  test("a directory with its subdirectories, a document, the stamp of each", async () => {
    expect([...(await readContract(STORE, "api")).entries()]).toEqual([
      ["run/contract/api/answer", "- {ok}"],
      ["run/contract/api/errors/codes", "- 400 and 404"],
    ]);
    expect([...(await readContract(STORE, "one")).entries()]).toEqual([["run/contract/one.md", "one document"]]);
    expect((await readContract(STORE, "nope")).size).toBe(0);
    const stamp = stampOf(await readContract(STORE, "api"));
    expect(Object.keys(stamp.facts)).toEqual(["run/contract/api/answer", "run/contract/api/errors/codes"]);
    expect(stampOf(await readContract(STORE, "api"))).toEqual(stamp);
  });
});

describe("waves.start contracts", () => {
  const start = (repo: string, extra: Record<string, unknown>) =>
    callAction("waves.start", { tag: "team/w1", title: "Wave", request: "review it", tasks: [{ key: "a", title: "Task a", request: "do a" }], ...extra }, { cwd: repo, origin: "session-0" });

  test("a wave without contracts reads no store and stores none", async () => {
    const repo = await registeredRepo();
    process.env.PATH = testPath;
    const { wave } = (await start(repo, { plan: STORE })) as { wave: WaveView };
    expect("contracts" in wave).toBe(false);
  });

  test("a contract listed twice is listed once, core first even when named after another", async () => {
    expect(await waveContracts(STORE, ["api", "core", "api"])).toEqual(["core", "api"]);
    expect(await waveContracts(STORE, ["one", "one"])).toEqual(["core", "one"]);
    const { prefix } = await contractsForLaunch(STORE, ["core", "api"]);
    expect(prefix.split("\n").filter((line) => line.startsWith("- api:"))).toHaveLength(1);
  });
});

describe("contracts.apply", () => {
  test("an op that changes nothing tells nobody", async () => {
    const answer = (await callAction("contracts.apply", { store: STORE, name: "one", op: { op: "write_doc", text: "one document" } })) as { changed: string[]; done: unknown[] };
    expect(answer).toMatchObject({ changed: [], done: [] });
  });

  test("refusals leave no wave and no fact", async () => {
    const repo = await registeredRepo();
    const start = (extra: Record<string, unknown>) =>
      callAction("waves.start", { tag: "team/w1", title: "Wave", request: "r", tasks: [{ key: "a", title: "Task a", request: "do a" }], ...extra }, { cwd: repo, origin: "session-0" });
    await expectError(start({ contracts: ["api"] }), "refused", "contracts need plan");
    await expectError(start({ plan: STORE, contracts: ["../x"] }), "invalid", "no contract name");
    await expectError(start({ plan: STORE, contracts: ["api", "nope"] }), "refused", "has no contract nope");
    const apply = (params: Record<string, unknown>) => callAction("contracts.apply", { store: STORE, name: "api", ...params });
    await expectError(apply({ name: "../x", op: { op: "add", path: "a", text: "t" } }), "invalid", "contract name");
    await expectError(apply({ op: { op: "drop", path: "a" } }), "invalid", "op must be an object whose op is one of add, update, retire, write_doc");
    await expectError(apply({ name: "nope", op: { op: "add", path: "a", text: "t" } }), "not_found", "has no contract nope");
    await expectError(apply({ op: { op: "add", path: "../core.md", text: "t" } }), "invalid", "no fact path inside the contract api");
    await expectError(apply({ name: "one", op: { op: "add", path: "a", text: "t" } }), "refused", "only write_doc changes it");
    await expectError(apply({ op: { op: "update", path: "missing", id: "x", text: "t" } }), "failed", "memory-store apply");
    process.env.PATH = testPath;
    await expectError(apply({ op: { op: "add", path: "a", text: "t" } }), "refused", "memory-store is not on PATH");
    await expectError(start({ plan: STORE, contracts: ["api"] }), "refused", "memory-store is not on PATH");
    expect(readStore(storeRoot, STORE).memories["run/contract/api/a"]).toBeUndefined();
    expect(((await callAction("waves.list", {})) as { waves: WaveView[] }).waves).toEqual([]);
  });

  test("an apply racing a launch: a launched task without its task event yet is told by the apply, or by its check when its session has not started", async () => {
    const repo = await registeredRepo();
    const wave = `cafe0000-${RUN}-4000-8000-00000000000c`;
    const asked = `abc50000-${RUN}-4000-8000-000000000005`;
    const starting = `abc60000-${RUN}-4000-8000-000000000006`;
    const stamp = stampOf(await readContract(STORE, "api"));
    const declaration = { id: wave, repo, tag: "team/w3", plan: STORE, title: "w", request: "r", branch: "main-team-w3", target: "main", base: "abc", origin: "session-0", createdAt: "2026-01-01T00:00:00.000Z", overrides: {}, contracts: ["core", "api"] };
    await createWave(declaration);
    await appendWaveEvent(wave, { kind: "tasks", tasks: [{ key: "ask", title: "Task ask", request: "do ask", after: [], id: asked }, { key: "new", title: "Task new", request: "do new", after: [], id: starting }] });
    await appendWaveEvent(wave, { kind: "stage", stage: "building", reason: null });
    for (const [key, id] of [["ask", asked], ["new", starting]]) {
      // Launched with the contract as it was: the record is written, its `task` event is not.
      await appendWaveEvent(wave, { kind: "launch", key });
      const record: TaskRecord = { ...fakeRecord(id, repo), plan: STORE, wave, contracts: { api: stamp } };
      record.sessionDir = join(caseDir, "sessions", key);
      await writeTask(record);
    }
    writeSession(await readTask(asked), [TASK_ENTRY, { type: "custom", customType: "factory-state", timestamp: "2026-01-01T00:00:00.000Z", data: { state: "waiting_answer", round: 1, reason: "start" } }]);

    const answer = (await callAction("contracts.apply", { store: STORE, name: "api", op: { op: "update", path: "answer", id: "f0", text: "{ok, raced}" } })) as { kept: { key: string }[] };
    expect(answer.kept.map((task) => task.key)).toEqual(["ask"]);
    expect((await readTask(asked)).contractNotes).toHaveLength(1);
    // No session yet: its stamp is the launch's; the check before its first coder turn says it, once.
    const note = await contractCheck((await readTask(starting)).sessionId);
    expect(note).toContain("- fact run/contract/api/answer\n  old: (not known: the store was edited directly)\n  new: - {ok, raced}");
    expect(await contractCheck((await readTask(starting)).sessionId)).toBeNull();
  });

  test("a merged wave listing the contract is neither listed nor given an event", async () => {
    const repo = await registeredRepo();
    const wave = `cafe0000-${RUN}-4000-8000-00000000000d`;
    const id = `abc70000-${RUN}-4000-8000-000000000007`;
    await createWave({ id: wave, repo, tag: "team/old", plan: STORE, title: "w", request: "r", branch: "main-team-old", target: "main", base: "abc", origin: "session-0", createdAt: "2026-01-01T00:00:00.000Z", overrides: {}, contracts: ["api"] });
    await appendWaveEvent(wave, { kind: "tasks", tasks: [{ key: "a", title: "Task a", request: "do a", after: [], id }] });
    await appendWaveEvent(wave, { kind: "task", key: "a", taskId: id, sessionId: `session-${id}` });
    const record: TaskRecord = { ...fakeRecord(id, repo), plan: STORE, wave };
    await writeTask(record);
    writeSession(record, [TASK_ENTRY, { type: "custom", customType: "factory-state", timestamp: "2026-01-01T00:00:00.000Z", data: { state: "done", round: 1, reason: "r" } }]);
    await appendWaveEvent(wave, { kind: "stage", stage: "merged", reason: null });
    const answer = (await callAction("contracts.apply", { store: STORE, name: "api", op: { op: "update", path: "answer", id: "f0", text: "{changed}" } })) as { done: unknown[] };
    expect(answer.done).toEqual([]);
    expect((await readWave(wave)).events.some((event) => event.kind === "contract")).toBe(false);
  });
});

describe("the runner's check", () => {
  async function blockedTask(repo: string): Promise<TaskRecord> {
    const record: TaskRecord = { ...fakeRecord(ID_4, repo), plan: STORE, contracts: { api: stampOf(await readContract(STORE, "api")) } };
    mkdirSync(record.worktree, { recursive: true });
    await writeTask(record);
    writeSession(record, [
      { type: "session", version: 3, id: record.sessionId, cwd: record.worktree },
      { type: "custom", customType: "factory-task", data: { mainBranch: "main" } },
      { type: "custom", customType: "factory-state", timestamp: "2026-01-01T00:00:00.000Z", data: { state: "blocked", round: 1, reason: "gates" } },
    ]);
    return record;
  }

  test("a direct edit of the store is caught before the next coder turn: the facts that differ, said once", async () => {
    const repo = makeRepo();
    const record = await blockedTask(repo);
    expect(await contractCheck(record.sessionId)).toBeNull();
    const data = readStore(storeRoot, STORE);
    data.memories["run/contract/api/answer"] = ["{ok, edited}"];
    delete data.memories["run/contract/api/errors/codes"];
    writeStore(storeRoot, STORE, data);

    await callAction("tasks.message", { id: ID_4, text: "go on" });
    await until(() => sentMessages().some((message) => message.startsWith("go on")), 20_000);
    const sent = sentMessages().find((message) => message.startsWith("go on")) as string;
    expect(sent).toContain("Your contract api changed");
    expect(sent).toContain("- fact run/contract/api/answer\n  old: (not known: the store was edited directly)\n  new: - {ok, edited}");
    expect(sent).toContain("- fact run/contract/api/errors/codes\n  old: (not known: the store was edited directly)\n  new: (retired)");
    expect((await readTask(ID_4)).contracts?.api).toEqual(stampOf(await readContract(STORE, "api")));
    expect(await contractCheck(record.sessionId)).toBeNull();
  }, 30_000);

  test("a task without contracts reads no store", async () => {
    const record = fakeRecord(ID_4, makeRepo());
    await writeTask(record);
    process.env.PATH = testPath;
    expect(await contractCheck(record.sessionId)).toBeNull();
  });
});
