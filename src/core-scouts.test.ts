import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callAction, type TaskView } from "./core.ts";
import { caseDir, expectError, fakeRecord, git, ID_1, makeRepo, scratch, until, useCoreFixture, writeSession } from "./core-test-kit.ts";
import { appendScoutEvent, cancelScout, cancelScouts, readScout, runningScouts, scoutDir, scoutDirs, scoutRunnerAlive, scoutView, writeScoutDeclaration, type ScoutView } from "./scouts.ts";
import { runCommand } from "./run.ts";
import { ownRunners, signalRunner } from "./spawn.ts";
import { writeTask } from "./tasks.ts";

useCoreFixture();

let scoutBin: string;
let storeLog: string;

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

/** The fake memory-store: one JSON file per store under \`$FAKE_STORE_ROOT\`, the commands a scout runs. */
const FAKE_STORE = `#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const [command, store, ...rest] = process.argv.slice(2);
appendFileSync(process.env.FAKE_STORE_LOG, [command, store, ...rest].join(" ") + "\\n");
const file = join(process.env.FAKE_STORE_ROOT, store + ".json");
const load = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null);
const save = (data) => (mkdirSync(dirname(file), { recursive: true }), writeFileSync(file, JSON.stringify(data)));
let data = load();
if (command === "create") {
  data ??= { dirs: [], memories: {} };
  data.dirs = [...new Set([...data.dirs, ...rest])];
  save(data);
  process.exit(0);
}
if (data === null) {
  console.error("error: memory_store_missing: no memory_store at " + store);
  process.exit(1);
}
if (command === "ls") {
  console.log(Object.entries(data.memories).map(([path, memory]) => "- " + path + " — " + memory.description).join("\\n"));
} else if (command === "read") {
  const memory = data.memories[rest[0]];
  if (!memory) console.log("## " + rest[0] + " — not_found: no memory " + rest[0]);
  else console.log("## " + rest[0] + " — " + memory.description + "\\n" + memory.facts.map((fact) => "- [" + fact.id + "] " + fact.text).join("\\n"));
} else if (command === "apply") {
  let n = Object.keys(data.memories).length * 10;
  for (const op of JSON.parse(rest[rest.indexOf("--ops") + 1])) {
    if (!data.dirs.includes(op.path.split("/")[0])) (console.error("undeclared_directory"), process.exit(1));
    const memory = data.memories[op.path];
    if (op.op === "add") data.memories[op.path] = { description: op.description, facts: [{ id: "f" + ++n, text: op.text }, ...(memory?.facts ?? [])] };
    else if (op.op === "update") memory.facts = memory.facts.map((fact) => (fact.id === op.id ? { id: "u" + ++n, text: op.text } : fact));
    else if (op.op === "describe") memory.description = op.description;
    else process.exit(1);
  }
  save(data);
}
`;

function store(name: string): Record<string, { description: string; facts: { id: string; text: string }[] }> | undefined {
  const file = join(caseDir, "stores", `${name}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).memories : undefined;
}

function createStore(name: string): void {
  mkdirSync(join(caseDir, "stores", name.split("/")[0]), { recursive: true });
  writeFileSync(join(caseDir, "stores", `${name}.json`), JSON.stringify({ dirs: ["plan"], memories: {} }));
}

const scoutPlan = (plan: object) => (process.env.FAKE_SCOUT = JSON.stringify(plan));

async function scouts(): Promise<ScoutView[]> {
  return Promise.all((await scoutDirs()).map((dir) => scoutView(dir)));
}

beforeEach(() => {
  scoutBin = join(scratch, "scout-bin");
  if (!existsSync(scoutBin)) {
    mkdirSync(scoutBin);
    writeFileSync(join(scoutBin, "pi"), FAKE_PI);
    writeFileSync(join(scoutBin, "memory-store"), FAKE_STORE);
    chmodSync(join(scoutBin, "pi"), 0o755);
    chmodSync(join(scoutBin, "memory-store"), 0o755);
  }
  storeLog = join(caseDir, "store.log");
  Object.assign(process.env, { PATH: `${scoutBin}:${process.env.PATH}`, FAKE_STORE_ROOT: join(caseDir, "stores"), FAKE_STORE_LOG: storeLog, FACTORY_SCOUT_POLL_MS: "50" });
  delete process.env.FAKE_SCOUT;
  delete process.env.FACTORY_SCOUT_WAIT_MS;
});

afterEach(async () => {
  // Every scout runner of this test run (its marker), whatever agent dir it belongs to.
  const found = await runCommand(["pgrep", "-f", "scout-runner\\.ts"], { cwd: "/", maxStdoutChars: 10_000 });
  for (const pid of await ownRunners(found.stdout.split("\n").filter((line) => line.trim() !== "").map(Number))) signalRunner(pid, "SIGKILL");
});

describe("scouts.start", () => {
  test("a waited scout returns its report, run on the small model with the read tools and map_write only", async () => {
    const repo = makeRepo();
    createStore("team/plan");
    await callAction("repos.add", { repo });
    await callAction("settings.set", { repo, settings: { models: { small: "a/b" } } });
    const result = (await callAction("scouts.start", { concern: "how a.txt is made", questions: ["who writes it?"], store: "team/plan", wait: true }, { cwd: repo, origin: "session-1" })) as {
      scout: ScoutView;
      timedOut: boolean;
    };
    expect(result.timedOut).toBe(false);
    expect(result.scout).toMatchObject({ state: "done", caller: { kind: "session", id: "session-1" }, concern: "how a.txt is made", questions: ["who writes it?"], store: "team/plan", model: "a/b" });
    expect(result.scout.report).toContain("KEY FACTS\n- a.txt:1 holds a");
    expect(result.scout.usage).toEqual({ input: 100, output: 10, cacheRead: 5, cacheWrite: 1, cost: 0.25 });
    const args = JSON.parse(readFileSync(process.env.FAKE_PI_LOG as string, "utf8").trim().slice("scout ".length)) as string[];
    expect(args.slice(0, 9)).toEqual(["--mode", "json", "-p", "--tools", "read,grep,find,ls,map_write", "-ne", "-e", expect.stringContaining("scout-map-write.ts"), "--no-skills"]);
    expect(args[args.indexOf("--model") + 1]).toBe("a/b");
    const prompt = readFileSync(join(caseDir, "agent", "factory", "scouts", "session-session-1", result.scout.id, "prompt.md"), "utf8");
    expect(prompt).toContain(git(repo, "rev-parse", "HEAD"));
    expect(prompt).toContain("1. who writes it?");
    expect(((await callAction("scouts.get", { id: result.scout.id.slice(0, 8) })) as { scout: ScoutView }).scout.report).toBe(result.scout.report);
  });

  test("map_write adds a fact, updates it on its path and stamps the commit", async () => {
    const repo = makeRepo();
    createStore("team/plan");
    scoutPlan({ writes: [{ path: "map/a", description: "first", text: "a.txt:1 holds a" }, { path: "a", description: "second", text: "a.txt:1 holds only a" }] });
    const { scout } = (await callAction("scouts.start", { concern: "a", store: "team/plan", wait: true }, { cwd: repo })) as { scout: ScoutView };
    const head = git(repo, "rev-parse", "HEAD");
    expect(scout.written).toEqual(["map/a"]);
    expect(store("team/plan")?.["map/a"]).toEqual({ description: "second", facts: [{ id: expect.any(String), text: `a.txt:1 holds only a\n(explored at ${head})` }] });
    const applied = readFileSync(storeLog, "utf8").split("\n").filter((line) => line.startsWith("apply"));
    expect(applied[0]).toContain('"op":"add"');
    expect(applied[1]).toContain('"op":"update"');
  });

  test("a scout without a store, or with one memory-store does not know, is refused", async () => {
    const repo = makeRepo();
    await expectError(callAction("scouts.start", { concern: "a" }, { cwd: repo }), "refused", "a scout needs a memory store");
    await expectError(callAction("scouts.start", { concern: "a", store: "no/store" }, { cwd: repo }), "refused", "memory store no/store does not exist");
    expect(await scouts()).toEqual([]);
  });

  test("a missing memory-store binary is refused as one that could not run, not as a missing store", async () => {
    const repo = makeRepo();
    const empty = join(caseDir, "empty-bin");
    mkdirSync(empty);
    symlinkSync(Bun.which("git") as string, join(empty, "git"));
    process.env.PATH = empty;
    await expectError(callAction("scouts.start", { concern: "a", store: "team/plan" }, { cwd: repo }), "failed", "memory-store could not run");
  });

  test("a running scout whose pid is not recorded yet counts against the limit", async () => {
    const repo = makeRepo();
    createStore("team/plan");
    scoutPlan({ hold: true });
    await callAction("scouts.start", { concern: "a", store: "team/plan" }, { cwd: repo, origin: "s" });
    const caller = { kind: "session", id: "s" } as const;
    const [first] = await scoutDirs(caller);
    await until(async () => (await runningScouts(caller)) === 1);
    // A second scout `running` before its runner's pid is recorded counts too.
    const { declaration } = await readScout(first);
    const dir = scoutDir(caller, "ffffffff-0000-4000-8000-000000000000");
    await writeScoutDeclaration(dir, { ...declaration, id: "ffffffff-0000-4000-8000-000000000000" });
    await appendScoutEvent(dir, { kind: "state", state: "running" });
    expect((await readScout(dir)).fold.pid).toBeNull();
    expect(await runningScouts(caller)).toBe(2);
  });

  test("a fifth scout of a caller queues until one of the four ends", async () => {
    const repo = makeRepo();
    createStore("team/plan");
    scoutPlan({ hold: true });
    for (let n = 0; n < 5; n += 1) await callAction("scouts.start", { concern: `c${n}`, store: "team/plan" }, { cwd: repo, origin: "s" });
    await until(async () => (await scouts()).filter((scout) => scout.state === "running").length === 4);
    await Bun.sleep(300);
    const all = await scouts();
    expect(all.map((scout) => scout.state).sort()).toEqual(["queued", "running", "running", "running", "running"]);
    // Another caller's scout does not wait for this one's.
    await callAction("scouts.start", { concern: "other", store: "team/plan" }, { cwd: repo, origin: "t" });
    await until(async () => (await scouts()).find((scout) => scout.concern === "other")?.state === "running");
    const running = all.find((scout) => scout.state === "running") as ScoutView;
    const dir = (await scoutDirs({ kind: "session", id: "s" })).find((path) => path.endsWith(running.id)) as string;
    await cancelScout(dir);
    const queued = all.find((scout) => scout.state === "queued") as ScoutView;
    await until(async () => ((await callAction("scouts.get", { id: queued.id })) as { scout: ScoutView }).scout.state === "running");
  });

  test("a timed-out wait answers with what the scout wrote so far", async () => {
    const repo = makeRepo();
    createStore("team/plan");
    process.env.FACTORY_SCOUT_WAIT_MS = "600000";
    scoutPlan({ writes: [{ path: "map/a", description: "a", text: "a.txt:1" }], hold: true });
    const waiting = callAction("scouts.start", { concern: "a", store: "team/plan", wait: true }, { cwd: repo }) as Promise<{ scout: ScoutView; timedOut: boolean }>;
    // The deadline passes once the scout wrote, however long its start takes on a loaded machine.
    await until(async () => (await scouts()).some((scout) => scout.written.includes("map/a")), 25_000);
    setSystemTime(new Date(Date.now() + 3_600_000));
    try {
      const result = await waiting;
      expect(result.timedOut).toBe(true);
      expect(result.scout).toMatchObject({ state: "running", report: null, written: ["map/a"] });
    } finally {
      setSystemTime();
    }
  });
});

describe("scouting cost", () => {
  test("a killed scout's cost stays in its task's sum, and cancelling the task's scouts ends them", async () => {
    const repo = makeRepo();
    createStore("team/plan");
    const record = { ...fakeRecord(ID_1, repo), plan: "team/plan" };
    git(repo, "worktree", "add", "--quiet", "-b", record.branch, record.worktree);
    await writeTask(record);
    writeSession(record, [{ type: "message", message: { role: "assistant", content: [], usage: { input: 1, output: 1, cost: { total: 1 } } } }]);
    scoutPlan({ hold: true, cost: 0.5 });
    const { scout } = (await callAction("scouts.start", { concern: "a" }, { cwd: record.worktree })) as { scout: ScoutView };
    expect(scout.caller).toEqual({ kind: "task", id: ID_1 });
    expect(scout.store).toBe("team/plan");
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

describe("scoutRunnerAlive", () => {
  test("a runner whose pid is not yet its command (the spawner's fork before exec) counts as alive, a gone one not", async () => {
    const dir = join(caseDir, "scout-dir");
    // The command line names the scout's directory only after a moment, as a spawn's fork does after its exec.
    const child = Bun.spawn(["sh", "-c", 'sleep 0.1; exec sh -c "sleep 5; true" "$SCOUT_DIR"'], { env: { ...process.env, SCOUT_DIR: dir } });
    try {
      expect(await scoutRunnerAlive(child.pid, dir)).toBe(true);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
    expect(await scoutRunnerAlive(child.pid, dir)).toBe(false);
  });
});
