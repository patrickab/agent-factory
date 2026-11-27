/** Contracts (`contracts.ts`, `core-contracts.ts`): `waves.start` contracts, the launch prefix, `contracts.apply`, the runner's check, over a fake memory-store. */
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { contractCheck, contractsForLaunch, readContract, stampOf } from "./contracts.ts";
import { waveContracts } from "./core-contracts.ts";
import { callAction, noticeInputs } from "./core.ts";
import { caseDir, exitingRunner, expectError, fakeRecord, ID_1, ID_2, ID_3, makeRepo, RUN, scratch, testPath, until, useCoreFixture, writeSession } from "./core-test-kit.ts";
import { readStore, writeFakeMemoryStore, writeStore } from "./fake-memory-store.ts";
import { liveRunners, taskInboxPath } from "./launch.ts";
import { pendingNotices } from "./notify.ts";
import { listTasks, readTask, writeTask, type TaskRecord } from "./tasks.ts";
import { appendWaveEvent, createWave, readWave, type WaveView } from "./waves.ts";

useCoreFixture();

const STORE = "team/plan";
const ID_4 = `abc40000-${RUN}-4000-8000-000000000004`;
const WAVE_ID = `cafe0000-${RUN}-4000-8000-00000000000a`;
const OTHER_WAVE = `cafe0000-${RUN}-4000-8000-00000000000b`;
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

  test("refusals: no plan, a bad or unknown name, no memory-store on PATH; none leaves a wave", async () => {
    const repo = await registeredRepo();
    await expectError(start(repo, { contracts: ["api"] }), "refused", "contracts need plan");
    await expectError(start(repo, { plan: STORE, contracts: ["../x"] }), "invalid", "no contract name");
    await expectError(start(repo, { plan: STORE, contracts: ["api", "nope"] }), "refused", "has no contract nope");
    await expectError(start(repo, { plan: STORE, contracts: "api" }), "invalid", "contracts must be an array");
    process.env.PATH = testPath;
    await expectError(start(repo, { plan: STORE, contracts: ["api"] }), "refused", "memory-store is not on PATH");
    expect(((await callAction("waves.list", {})) as { waves: WaveView[] }).waves).toEqual([]);
  });

  test("core comes first; the coder's first message names each contract and its read command; the request and the log stay the supervisor's", async () => {
    const repo = await registeredRepo();
    process.env.FAKE_PI_HOLD = "1";
    const { wave } = (await start(repo, { plan: STORE, contracts: ["api"] })) as { wave: WaveView };
    expect((await readWave(wave.id)).declaration.contracts).toEqual(["core", "api"]);
    await until(() => sentMessages().length === 1, 20_000);
    const payload = JSON.parse(sentMessages()[0].slice("/factory start ".length)) as { request: string; prefix: string };
    expect(payload.request).toBe("do a");
    expect(payload.prefix).toContain(`- core: memory-store read ${STORE} run/contract/core.md`);
    expect(payload.prefix).toContain(`- api: memory-store read ${STORE} run/contract/api/answer run/contract/api/errors/codes`);
    const record = (await listTasks()).find((task) => task.wave === wave.id) as TaskRecord;
    expect(Object.keys(record.contracts ?? {})).toEqual(["core", "api"]);
    expect(record.contracts?.api).toEqual(stampOf(await readContract(STORE, "api")));
    const { events } = await readWave(wave.id);
    expect(JSON.stringify(events)).not.toContain("memory-store read");
  }, 30_000);

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
  /** A wave of `api` with a task running (live runner), one waiting for an answer, one done, one pending. */
  async function contractWave(repo: string): Promise<Record<string, TaskRecord>> {
    const stamp = stampOf(await readContract(STORE, "api"));
    const states: [string, string, string][] = [
      ["run", ID_1, "running"],
      ["ask", ID_2, "waiting_answer"],
      ["fin", ID_3, "done"],
    ];
    const records: Record<string, TaskRecord> = {};
    for (const [key, id, state] of states) {
      const record: TaskRecord = { ...fakeRecord(id, repo), plan: STORE, wave: WAVE_ID, contracts: { api: stamp } };
      mkdirSync(record.worktree, { recursive: true });
      record.sessionDir = join(caseDir, "sessions", key);
      await writeTask(record);
      writeSession(record, [
        { type: "session", version: 3, id: record.sessionId, cwd: record.worktree },
        { type: "custom", customType: "factory-task", data: { mainBranch: "main" } },
        { type: "custom", customType: "factory-state", data: { state, round: 1, reason: "start" } },
      ]);
      records[key] = record;
    }
    const declaration = { repo, tag: "team/w1", plan: STORE, title: "w", request: "r", branch: "main-team-w1", target: "main", base: "abc", origin: "session-0", createdAt: "2026-01-01T00:00:00.000Z", overrides: {} };
    await createWave({ ...declaration, id: WAVE_ID, contracts: ["core", "api"] });
    await createWave({ ...declaration, id: OTHER_WAVE, tag: "team/w2", branch: "main-team-w2", contracts: ["core"] });
    const spec = (key: string) => ({ key, title: `Task ${key}`, request: `do ${key}`, after: [], id: crypto.randomUUID() });
    await appendWaveEvent(WAVE_ID, { kind: "tasks", tasks: ["run", "ask", "fin", "later"].map(spec) });
    for (const key of ["run", "ask", "fin"]) await appendWaveEvent(WAVE_ID, { kind: "task", key, taskId: records[key].id, sessionId: records[key].sessionId });
    await appendWaveEvent(WAVE_ID, { kind: "stage", stage: "building", reason: null });
    return records;
  }

  test("reaches the running task and the waiting one, skips the pending one, lists and reports the done one", async () => {
    const repo = await registeredRepo();
    const records = await contractWave(repo);
    const runner = Bun.spawn(["bun", exitingRunner, records.run.worktree, records.run.sessionDir, records.run.sessionId, "x"], { env: { ...process.env, FAKE_INBOX: taskInboxPath(ID_1) } });
    await until(async () => (await liveRunners(records.run)).length === 1);

    const answer = (await callAction("contracts.apply", { store: STORE, name: "api", op: { op: "update", path: "answer", id: "f0", text: "{ok, removed}" } })) as {
      changed: string[];
      notified: { key: string }[];
      kept: { key: string }[];
      done: { key: string; task: string }[];
    };
    await runner.exited;
    expect(answer.changed).toEqual(["run/contract/api/answer"]);
    expect(answer.notified.map((task) => task.key)).toEqual(["run"]);
    expect(answer.kept.map((task) => task.key)).toEqual(["ask"]);
    expect(answer.done.map((task) => [task.key, task.task])).toEqual([["fin", ID_3]]);
    expect(readStore(storeRoot, STORE).memories["run/contract/api/answer"]).toEqual(["{ok, removed}"]);

    // Running: one follow-up through its inbox, with the old and the new text; its stamp is the store's now.
    const inbox = readFileSync(taskInboxPath(ID_1), "utf8").trim().split("\n").map((line) => (JSON.parse(line) as { text: string }).text);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toContain("Your contract api changed");
    expect(inbox[0]).toContain("- fact run/contract/api/answer\n  old: - {ok}\n  new: - {ok, removed}");
    const stamp = stampOf(await readContract(STORE, "api"));
    expect((await readTask(ID_1)).contracts?.api).toEqual(stamp);
    expect(await contractCheck(records.run.sessionId)).toBeNull();

    // Waiting for an answer: kept on its record, it goes with the answer.
    expect((await readTask(ID_2)).contractNotes).toEqual([inbox[0]]);
    await callAction("tasks.message", { id: ID_2, text: "the answer" });
    await until(() => sentMessages().some((message) => message.startsWith("the answer")), 20_000);
    expect(sentMessages().find((message) => message.startsWith("the answer"))).toBe(`the answer\n\n${inbox[0]}`);
    expect((await readTask(ID_2)).contractNotes).toBeUndefined();

    // Done: not told; reported once to the wave's origin. The pending task has no record to tell; the other wave does not list api.
    expect((await readTask(ID_3)).contractNotes).toBeUndefined();
    const { events } = await readWave(WAVE_ID);
    expect(events.filter((event) => event.kind === "contract")).toMatchObject([{ kind: "contract", name: "api", paths: ["run/contract/api/answer"], done: ["fin"] }]);
    expect((await readWave(OTHER_WAVE)).events.some((event) => event.kind === "contract")).toBe(false);
    const { tasks, waves } = await noticeInputs("session-0");
    const notices = pendingNotices(tasks, waves, new Set()).filter((notice) => notice.key.includes(":contract:"));
    expect(notices.map((notice) => notice.key)).toEqual([`wave:${WAVE_ID}:contract:${events.findIndex((event) => event.kind === "contract")}`]);
    expect(notices[0].text).toContain("factory: contract api changed (run/contract/api/answer): wave team/w1 has done tasks fin");
  }, 40_000);

  test("an op that changes nothing tells nobody", async () => {
    const repo = await registeredRepo();
    await contractWave(repo);
    const answer = (await callAction("contracts.apply", { store: STORE, name: "one", op: { op: "write_doc", text: "one document" } })) as { changed: string[]; done: unknown[] };
    expect(answer).toMatchObject({ changed: [], done: [] });
  });

  test("refusals", async () => {
    const apply = (params: Record<string, unknown>) => callAction("contracts.apply", { store: STORE, name: "api", ...params });
    await expectError(apply({ name: "../x", op: { op: "add", path: "a", text: "t" } }), "invalid", "contract name");
    await expectError(apply({ op: { op: "drop", path: "a" } }), "invalid", "op must be an object whose op is one of add, update, retire, write_doc");
    await expectError(apply({ name: "nope", op: { op: "add", path: "a", text: "t" } }), "not_found", "has no contract nope");
    await expectError(apply({ op: { op: "add", text: "t" } }), "invalid", "op.path names the fact");
    await expectError(apply({ op: { op: "add", path: "../core.md", text: "t" } }), "invalid", "no fact path inside the contract api");
    await expectError(apply({ name: "one", op: { op: "add", path: "a", text: "t" } }), "refused", "only write_doc changes it");
    await expectError(apply({ name: "one", op: { op: "write_doc", path: "core.md", text: "t" } }), "invalid", "is the one document run/contract/one.md");
    await expectError(apply({ op: { op: "update", path: "missing", id: "x", text: "t" } }), "failed", "memory-store apply");
    process.env.PATH = testPath;
    await expectError(apply({ op: { op: "add", path: "a", text: "t" } }), "refused", "memory-store is not on PATH");
    expect(readStore(storeRoot, STORE).memories["run/contract/api/a"]).toBeUndefined();
  });

  test("a full store path inside the contract is taken as given", async () => {
    const answer = (await callAction("contracts.apply", { store: STORE, name: "api", op: { op: "add", path: "run/contract/api/new", text: "added", description: "d" } })) as { changed: string[] };
    expect(answer.changed).toEqual(["run/contract/api/new"]);
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
    writeSession(await readTask(asked), [{ type: "custom", customType: "factory-state", data: { state: "waiting_answer", round: 1, reason: "start" } }]);

    const answer = (await callAction("contracts.apply", { store: STORE, name: "api", op: { op: "update", path: "answer", id: "f0", text: "{ok, raced}" } })) as { kept: { key: string }[] };
    expect(answer.kept.map((task) => task.key)).toEqual(["ask"]);
    expect((await readTask(asked)).contractNotes).toHaveLength(1);
    // No session yet: its stamp is the launch's; the check before its first coder turn says it, once.
    const note = await contractCheck((await readTask(starting)).sessionId);
    expect(note).toContain("- fact run/contract/api/answer\n  old: (not known: the store was edited directly)\n  new: - {ok, raced}");
    expect(await contractCheck((await readTask(starting)).sessionId)).toBeNull();
  });

  test("the facts of a contract are read in one memory-store call", async () => {
    process.env.FAKE_STORE_LOG = join(caseDir, "store-calls.log");
    try {
      expect((await readContract(STORE, "api")).size).toBe(2);
      const calls = readFileSync(process.env.FAKE_STORE_LOG, "utf8").trim().split("\n");
      expect(calls.filter((line) => line.startsWith("read"))).toEqual([`read --no-ids ${STORE} run/contract/api/answer run/contract/api/errors/codes`]);
    } finally {
      delete process.env.FAKE_STORE_LOG;
    }
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
      { type: "custom", customType: "factory-state", data: { state: "blocked", round: 1, reason: "gates" } },
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
