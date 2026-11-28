import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { callAction, type TaskView } from "./core.ts";
import { caseDir, expectError, fakeRecord, git, ID_1, makeRepo, noted, until, useCoreFixture, writeSession } from "./core-test-kit.ts";
import { cancelScout, cancelScouts, readScout, scoutDirs, scoutLockPath, scoutView, type ScoutView } from "./scouts.ts";
import { readStore, writeFakeMemoryStore, writeStore } from "./fake-memory-store.ts";
import { signalRunner } from "./spawn.ts";
import { writeTask } from "./tasks.ts";

// Registered before the fixture's hooks, so it runs while the case's agent dir is still set: every scout of the case ends.
afterEach(async () => {
  for (const dir of await scoutDirs()) await cancelScout(dir);
});
useCoreFixture();

const STORE = "team/plan";
const storeRoot = () => join(caseDir, "stores");
const createStore = () => writeStore(storeRoot(), STORE, { memories: {}, docs: {}, dirs: ["plan"] });

const scoutPlan = (plan: object) => (process.env.FAKE_SCOUT = JSON.stringify(plan));

async function scouts(): Promise<ScoutView[]> {
  return Promise.all((await scoutDirs()).map((dir) => scoutView(dir)));
}

beforeEach(() => {
  writeFakeMemoryStore(join(caseDir, "bin"));
  Object.assign(process.env, { PATH: `${join(caseDir, "bin")}:${process.env.PATH}`, FAKE_STORE_ROOT: storeRoot() });
});

describe("scouts.start", () => {
  test("a waited scout returns its report, run on the small model with the read tools and map_write only", async () => {
    const repo = makeRepo();
    createStore();
    await callAction("repos.add", { repo });
    await callAction("settings.set", { repo, settings: { models: { small: "a/b" } } });
    const result = (await callAction("scouts.start", { concern: "how a.txt is made", questions: ["who writes it?"], store: STORE, wait: true }, { cwd: repo, origin: "session-1" })) as {
      scout: ScoutView;
      timedOut: boolean;
    };
    expect(result.timedOut).toBe(false);
    expect(result.scout).toMatchObject({ state: "done", caller: { kind: "session", id: "session-1" }, concern: "how a.txt is made", questions: ["who writes it?"], store: STORE, model: "a/b" });
    expect(result.scout.report).toContain("KEY FACTS\n- a.txt:1 holds a");
    const [args] = noted<string[]>("argv");
    // Read-only: the reading tools and its map writer, nothing that edits or runs.
    expect(new Set(args[args.indexOf("--tools") + 1].split(","))).toEqual(new Set(["read", "grep", "find", "ls", "map_write"]));
  });

  test("map_write adds a fact, updates it on its path and stamps the commit", async () => {
    const repo = makeRepo();
    createStore();
    scoutPlan({ writes: [{ path: "map/a", description: "first", text: "a.txt:1 holds a" }, { path: "a", description: "second", text: "a.txt:1 holds only a" }] });
    const { scout } = (await callAction("scouts.start", { concern: "a", store: STORE, wait: true }, { cwd: repo })) as { scout: ScoutView };
    const head = git(repo, "rev-parse", "HEAD");
    expect(scout.written).toEqual(["map/a"]);
    expect(readStore(storeRoot(), STORE).memories["map/a"]).toEqual([`a.txt:1 holds only a\n(explored at ${head})`]);
  });

  test("a scout without a store, or with one memory-store does not know, is refused", async () => {
    const repo = makeRepo();
    await expectError(callAction("scouts.start", { concern: "a" }, { cwd: repo }), "refused");
    await expectError(callAction("scouts.start", { concern: "a", store: "no/store" }, { cwd: repo }), "refused");
    expect(await scouts()).toEqual([]);
  });

  test("a fifth scout of a caller queues until one of the four ends", async () => {
    const repo = makeRepo();
    createStore();
    scoutPlan({ hold: true });
    for (let n = 0; n < 5; n += 1) await callAction("scouts.start", { concern: `c${n}`, store: STORE }, { cwd: repo, origin: "s" });
    await until(async () => (await scouts()).filter((scout) => scout.state === "running").length === 4);
    // Another caller's scout does not wait for this one's: it runs while the fifth of "s", started before it, queues.
    await callAction("scouts.start", { concern: "other", store: STORE }, { cwd: repo, origin: "t" });
    await until(async () => (await scouts()).find((scout) => scout.concern === "other")?.state === "running");
    const all = (await scouts()).filter((scout) => scout.concern !== "other");
    expect(all.map((scout) => scout.state).sort()).toEqual(["queued", "running", "running", "running", "running"]);
    const running = all.find((scout) => scout.state === "running") as ScoutView;
    const dir = (await scoutDirs({ kind: "session", id: "s" })).find((path) => path.endsWith(running.id)) as string;
    await cancelScout(dir);
    const queued = all.find((scout) => scout.state === "queued") as ScoutView;
    await until(async () => ((await callAction("scouts.get", { id: queued.id })) as { scout: ScoutView }).scout.state === "running");
  });

});

describe("scouting cost", () => {
  test("a killed scout's cost stays in its task's sum, and cancelling the task's scouts ends them", async () => {
    const repo = makeRepo();
    createStore();
    const record = { ...fakeRecord(ID_1, repo), plan: STORE };
    git(repo, "worktree", "add", "--quiet", "-b", record.branch, record.worktree);
    await writeTask(record);
    writeSession(record, [{ type: "message", message: { role: "assistant", content: [], usage: { input: 1, output: 1, cost: { total: 1 } } } }]);
    scoutPlan({ hold: true, cost: 0.5 });
    const { scout } = (await callAction("scouts.start", { concern: "a" }, { cwd: record.worktree })) as { scout: ScoutView };
    expect(scout.caller).toEqual({ kind: "task", id: ID_1 });
    expect(scout.store).toBe(STORE);
    const [dir] = await scoutDirs({ kind: "task", id: ID_1 });
    await until(async () => (await readScout(dir)).fold.usage !== null);
    signalRunner(Number(readFileSync(scoutLockPath(dir), "utf8").split(" ")[0]), "SIGKILL");
    await until(async () => ((await callAction("scouts.get", { id: scout.id })) as { scout: ScoutView }).scout.interrupted);
    const task = (await callAction("tasks.get", { id: ID_1 })) as TaskView;
    expect(task.usage?.cost).toBe(1.5);

    const second = ((await callAction("scouts.start", { concern: "b" }, { cwd: record.worktree })) as { scout: ScoutView }).scout;
    await until(async () => ((await callAction("scouts.get", { id: second.id })) as { scout: ScoutView }).scout.state === "running");
    await cancelScouts({ kind: "task", id: ID_1 });
    const cancelled = ((await callAction("scouts.get", { id: second.id })) as { scout: ScoutView }).scout;
    expect(cancelled).toMatchObject({ state: "cancelled", running: false });
  });
});
