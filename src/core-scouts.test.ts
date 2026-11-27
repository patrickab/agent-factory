import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callAction, type TaskView } from "./core.ts";
import { caseDir, expectError, fakeRecord, git, ID_1, makeRepo, scratch, until, useCoreFixture, writeSession } from "./core-test-kit.ts";
import { cancelScout, cancelScouts, readScout, scoutDirs, scoutView, type ScoutView } from "./scouts.ts";
import { readStore, writeFakeMemoryStore, writeStore } from "./fake-memory-store.ts";
import { runCommand } from "./run.ts";
import { ownRunners, signalRunner } from "./spawn.ts";
import { writeTask } from "./tasks.ts";

useCoreFixture();

let scoutBin: string;

/**
 * The fake scout child: loads the extension it is given with `-e`, calls `map_write` for each of `$FAKE_SCOUT.writes`
 * (one assistant message each, cost `$FAKE_SCOUT.cost`), then holds (`hold`) or ends with `report` as its last message.
 */
const FAKE_PI = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_PI_LOG, "scout " + JSON.stringify(args) + "\\n");
const tools = {};
(await import(args[args.indexOf("-e") + 1])).default({ registerTool: (tool) => (tools[tool.name] = tool) });
const plan = JSON.parse(process.env.FAKE_SCOUT ?? "{}");
const emit = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
const message = (text) =>
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage: { input: 100, output: 10, cacheRead: 5, cacheWrite: 1, cost: { total: plan.cost ?? 0.25 } } } });
for (const write of plan.writes ?? []) {
  await tools.map_write.execute("call", write);
  message("");
}
if (plan.hold) {
  message("");
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
message(plan.report ?? "MISSING\\n1. nothing\\n\\nDECISIONS\\n- none\\n\\nKEY FACTS\\n- a.txt:1 holds a\\n\\nMEMORY\\n- none");
`;

const STORE = "team/plan";
const storeRoot = () => join(caseDir, "stores");
const createStore = () => writeStore(storeRoot(), STORE, { memories: {}, docs: {}, dirs: ["plan"] });

const scoutPlan = (plan: object) => (process.env.FAKE_SCOUT = JSON.stringify(plan));

async function scouts(): Promise<ScoutView[]> {
  return Promise.all((await scoutDirs()).map((dir) => scoutView(dir)));
}

beforeEach(() => {
  scoutBin = join(scratch, "scout-bin");
  if (!existsSync(scoutBin)) {
    writeFakeMemoryStore(scoutBin);
    writeFileSync(join(scoutBin, "pi"), FAKE_PI);
    chmodSync(join(scoutBin, "pi"), 0o755);
  }
  Object.assign(process.env, { PATH: `${scoutBin}:${process.env.PATH}`, FAKE_STORE_ROOT: storeRoot(), FACTORY_SCOUT_POLL_MS: "50" });
  delete process.env.FAKE_SCOUT;
});

afterEach(async () => {
  // Every scout runner of this test run (its marker), whatever agent dir it belongs to.
  const found = await runCommand(["pgrep", "-f", "scout-runner\\.ts"], { cwd: "/", maxStdoutChars: 10_000 });
  for (const pid of await ownRunners(found.stdout.split("\n").filter((line) => line.trim() !== "").map(Number))) signalRunner(pid, "SIGKILL");
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
    const args = JSON.parse(readFileSync(process.env.FAKE_PI_LOG as string, "utf8").trim().slice("scout ".length)) as string[];
    expect(args[args.indexOf("--tools") + 1]).toBe("read,grep,find,ls,map_write");
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
    await expectError(callAction("scouts.start", { concern: "a" }, { cwd: repo }), "refused", "a scout needs a memory store");
    await expectError(callAction("scouts.start", { concern: "a", store: "no/store" }, { cwd: repo }), "refused", "memory store no/store does not exist");
    expect(await scouts()).toEqual([]);
  });

  test("a fifth scout of a caller queues until one of the four ends", async () => {
    const repo = makeRepo();
    createStore();
    scoutPlan({ hold: true });
    for (let n = 0; n < 5; n += 1) await callAction("scouts.start", { concern: `c${n}`, store: STORE }, { cwd: repo, origin: "s" });
    await until(async () => (await scouts()).filter((scout) => scout.state === "running").length === 4);
    await Bun.sleep(300);
    const all = await scouts();
    expect(all.map((scout) => scout.state).sort()).toEqual(["queued", "running", "running", "running", "running"]);
    // Another caller's scout does not wait for this one's.
    await callAction("scouts.start", { concern: "other", store: STORE }, { cwd: repo, origin: "t" });
    await until(async () => (await scouts()).find((scout) => scout.concern === "other")?.state === "running");
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
    signalRunner((await readScout(dir)).fold.pid as number, "SIGKILL");
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
