/**
 * The core over real git repos in a temp dir and a fake `pi` on PATH (never a model, never the real
 * `agent-worktree`). The fake answers each `/factory` command with the entries the plugin would write.
 */
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { ACTIONS, callAction, FactoryError, startWaveTasks, taskWave, waveMergeRefusal, waveReviewWorktree, type TaskView, type TimelineEntry } from "./core.ts";
import { liveRunners, stopRunners, taskInboxPath } from "./launch.ts";
import { lastFactoryState } from "./runner.ts";
import { defaultModels } from "./settings.ts";
import { listTasks, lockTask, taskLogPath, tasksDir, unlockTask, writeTask, type TaskRecord } from "./tasks.ts";
import { liveWaveRunners, pokeWave, stopWaveRunners, wavePokePath } from "./wave-poke.ts";
import { appendWaveEvent, createWave, listWaves, readWave, type WaveView } from "./waves.ts";

const savedEnv = { ...process.env };
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "factory-core-test-")));
const fakeBin = join(scratch, "bin");
const piLog = join(scratch, "fake-pi.log");

/** The fake `pi`: notes each prompt in `$FAKE_PI_LOG`, appends the `factory-state` entries of the command, ends on stdin EOF. */
mkdirSync(fakeBin);
writeFileSync(
  join(fakeBin, "pi"),
  `#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const dir = args[args.indexOf("--session-dir") + 1];
const id = args[args.indexOf("--session-id") + 1];
mkdirSync(dir, { recursive: true });
const file = join(dir, "2026-01-01T00-00-00-000Z_" + id + ".jsonl");
if (!existsSync(file)) writeFileSync(file, JSON.stringify({ type: "session", version: 3, id, cwd: process.cwd() }) + "\\n");
const state = (name, reason) =>
  appendFileSync(file, JSON.stringify({ type: "custom", customType: "factory-state", data: { state: name, round: 1, reason } }) + "\\n");
const lastState = () => readFileSync(file, "utf8").trim().split("\\n").map((line) => JSON.parse(line)).filter((e) => e.customType === "factory-state").at(-1)?.data.state;
const emit = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const forever = () => new Promise(() => {});
setInterval(() => {}, 1000);
let gotPrompt;
const prompt = new Promise((done) => (gotPrompt = done));
(async () => {
  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += new TextDecoder().decode(chunk);
    if (buffer.includes("\\n")) gotPrompt(buffer.split("\\n")[0]);
  }
  process.exit(0);
})();
const message = JSON.parse(await prompt).message;
appendFileSync(process.env.FAKE_PI_LOG, "prompt " + message.split(" ").slice(0, 2).join(" ") + "\\n");
if (process.env.FAKE_PI_ENV_LOG) appendFileSync(process.env.FAKE_PI_ENV_LOG, "secret " + (process.env.FACTORY_TEST_SECRET ?? "-") + "\\n");
const answer = () => emit({ id: "1", type: "response", command: "prompt", success: true, data: { disposition: "handled" } });
if (message.startsWith("/factory start ")) {
  appendFileSync(file, JSON.stringify({ type: "custom", customType: "factory-task", data: { mainBranch: "main", settings: JSON.parse(message.slice("/factory start ".length)).settings } }) + "\\n");
  state("running", "start");
  answer();
  emit({ type: "agent_start" });
  if (process.env.FAKE_PI_HOLD === "1") await forever();
  await sleep(50);
  state(process.env.FAKE_PI_START_END ?? "waiting_approve", "passed");
  emit({ type: "agent_settled", aborted: false });
} else if (message === "/factory approve") {
  state("merging", "approved");
  answer();
  await sleep(50);
  state("done", "merged");
  emit({ type: "entry_appended" });
} else if (message === "/factory retry") {
  state("running", "retry");
  answer();
  emit({ type: "agent_start" });
  await sleep(50);
  state("blocked", "gates");
  emit({ type: "agent_settled", aborted: false });
} else if (message === "/factory cancel") {
  if (lastState() === "running") state("blocked", "interrupted");
  state("cancelled", "cancelled");
  answer();
}
await forever();
`,
);
chmodSync(join(fakeBin, "pi"), 0o755);

/** A runner stand-in `pgrep` finds as the task's runner; it exits as soon as the task's inbox file appears. */
const exitingRunner = join(scratch, "fake-runner", "runner.ts");
mkdirSync(join(scratch, "fake-runner"));
writeFileSync(
  exitingRunner,
  `import { existsSync } from "node:fs";
const inbox = process.env.FAKE_INBOX;
while (!existsSync(inbox)) await Bun.sleep(1);
process.exit(0);
`,
);

/** A wave runner stand-in `liveWaveRunners` finds (`wave-runner.ts <id>`); it exits once `$FAKE_RUNNER_END` exists. */
const fakeWaveRunner = join(scratch, "fake-runner", "wave-runner.ts");
writeFileSync(
  fakeWaveRunner,
  `import { existsSync } from "node:fs";
while (!existsSync(process.env.FAKE_RUNNER_END)) await Bun.sleep(20);
process.exit(0);
`,
);

/** A PATH with the fake `pi` and without any directory that holds `agent-worktree`. */
const testPath = [fakeBin, ...(savedEnv.PATH ?? "").split(":").filter((dir) => dir !== "" && !existsSync(join(dir, "agent-worktree")))].join(":");

let caseDir: string;
let caseCount = 0;

beforeEach(() => {
  caseDir = join(scratch, `case-${++caseCount}`);
  mkdirSync(caseDir);
  Object.assign(process.env, {
    PATH: testPath,
    HOME: scratch,
    PI_CODING_AGENT_DIR: join(caseDir, "agent"),
    FAKE_PI_LOG: piLog,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "test",
    GIT_COMMITTER_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_EMAIL: "test@example.com",
  });
  delete process.env.FAKE_PI_HOLD;
  delete process.env.FAKE_PI_START_END;
  rmSync(piLog, { force: true });
  // Starting a task needs a factory models list; a test that wants none removes it.
  mkdirSync(join(caseDir, "agent", "factory"), { recursive: true });
  // Without the models of defaults.yaml: a task without models of its own runs with Pi's session model.
  writeFileSync(modelsFile(), "- a/b\n- c/d\n");
});

function modelsFile(): string {
  return join(caseDir, "agent", "factory", "models.yaml");
}

afterEach(async () => {
  // Wave runners first: they would start tasks while the tasks' runners stop.
  for (const wave of await listWaves()) await stopWaveRunners(wave.declaration.id);
  for (const record of await listTasks()) await stopRunners(record);
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A repo on `main` with one commit, `factory.yaml` in it unless `withConfig` is false. */
function makeRepo(withConfig = true, name = "repo"): string {
  const repo = join(caseDir, name);
  mkdirSync(repo);
  git(repo, "init", "--quiet", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  if (withConfig) writeFileSync(join(repo, "factory.yaml"), "gates: []\n");
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "init");
  return repo;
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(50);
  }
}

const stateOf = async (record: TaskRecord) => (await lastFactoryState(record.sessionDir, record.sessionId))?.state;
const runnerEnded = async (record: TaskRecord) => (await liveRunners(record)).length === 0;
const prompts = () => (existsSync(piLog) ? readFileSync(piLog, "utf8").trim().split("\n") : []);

/** The record of a started task. */
async function recordOf(view: TaskView): Promise<TaskRecord> {
  const record = (await listTasks()).find((task) => task.id === view.id);
  if (!record) throw new Error(`no record ${view.id}`);
  return record;
}

async function startTask(repo: string, title = "Add b"): Promise<TaskRecord> {
  return recordOf((await callAction("tasks.start", { title, request: "add b.txt" }, { cwd: repo })) as TaskView);
}

/** Starts a task and waits for its runner to leave it at `state`. */
async function restingTask(repo: string, state: "waiting_approve" | "blocked"): Promise<TaskRecord> {
  if (state === "blocked") process.env.FAKE_PI_START_END = "blocked";
  const record = await startTask(repo);
  await until(async () => (await stateOf(record)) === state);
  await until(() => runnerEnded(record));
  return record;
}

/** The `FactoryError` `promise` rejects with. */
async function failure(promise: Promise<unknown>): Promise<FactoryError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof FactoryError)) throw new Error(`expected a FactoryError, got ${String(error)}`);
  return error;
}

async function expectError(promise: Promise<unknown>, code: FactoryError["code"], message: string): Promise<void> {
  const error = await failure(promise);
  expect(error.code).toBe(code);
  expect(error.message).toContain(message);
}

/** Part of every fixed id and session id here: a concurrent test run (another worktree) never matches these runners. */
const RUN = randomBytes(2).toString("hex");
const ID_1 = `abc10000-${RUN}-4000-8000-000000000001`;
const ID_2 = `abc20000-${RUN}-4000-8000-000000000002`;
const ID_3 = `abc30000-${RUN}-4000-8000-000000000003`;

function fakeRecord(id: string, repo: string): TaskRecord {
  return {
    id,
    repo,
    worktree: join(caseDir, id),
    branch: id,
    title: `task ${id.slice(0, 8)}`,
    sessionId: `session-${id}`,
    sessionDir: join(caseDir, "sessions"),
    createdAt: `2026-01-01T00:00:0${id.at(-1)}.000Z`,
    tag: "team/a",
    plan: null,
    wave: null,
    origin: null,
  };
}

function writeSession(record: TaskRecord, entries: object[]): string {
  mkdirSync(record.sessionDir, { recursive: true });
  const path = join(record.sessionDir, `2026-01-01T00-00-00-000Z_${record.sessionId}.jsonl`);
  writeFileSync(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  return path;
}

describe("callAction", () => {
  test("ACTIONS names every action of the contract", () => {
    expect(Object.keys(ACTIONS).sort()).toEqual(
      [
        "models.get",
        "models.set",
        "repos.list",
        "repos.add",
        "repos.remove",
        "branches.list",
        "settings.get",
        "settings.set",
        "config.get",
        "config.write",
        "tasks.list",
        "tasks.get",
        "tasks.import",
        "tasks.timeline",
        "tasks.diff",
        "tasks.start",
        "tasks.approve",
        "tasks.retry",
        "tasks.cancel",
        "tasks.remove",
        "tasks.message",
        "tasks.wait",
        "waves.start",
        "waves.add",
        "waves.get",
        "waves.list",
        "waves.timeline",
        "waves.retry",
        "waves.approve",
        "waves.cancel",
        "waves.remove",
      ].sort(),
    );
    expect(ACTIONS["tasks.get"].mutates).toBe(false);
    expect(ACTIONS["tasks.start"].params.required).toEqual(["repo", "title", "request"]);
  });

  test("a wave task's model in the schema of waves.start and waves.add: small or big, never a provider/model", () => {
    for (const action of ["waves.start", "waves.add"] as const) {
      const tasks = ACTIONS[action].params.properties.tasks as { description?: string; items: { properties: Record<string, { enum?: string[]; description?: string }> } };
      expect(tasks.items.properties.model.enum).toEqual(["small", "big"]);
      expect(`${tasks.description} ${tasks.items.properties.model.description}`).not.toContain("models list");
    }
  });

  test("invalid: an unknown action, a missing or mistyped param, an ambiguous id", async () => {
    await expectError(callAction("tasks.fly", {}), "invalid", 'unknown action "tasks.fly"');
    await expectError(callAction("tasks.get", {}), "invalid", "tasks.get needs id");
    await expectError(callAction("tasks.timeline", { id: "x", since: "1" }), "invalid", "since must be an integer");
    await expectError(callAction("settings.get", {}), "invalid", "settings.get needs repo");
    await writeTask(fakeRecord(ID_1, "/r"));
    await writeTask(fakeRecord(ID_2, "/r"));
    await expectError(callAction("tasks.get", { id: "abc" }), "invalid", `"abc" matches 2 tasks (${ID_1}, ${ID_2}), give more of the id`);
  });

  test("not_found: an unknown id, a path outside git", async () => {
    await expectError(callAction("tasks.get", { id: "zz" }), "not_found", 'no task has an id starting with "zz"');
    await expectError(callAction("branches.list", {}, { cwd: caseDir }), "not_found", `${caseDir} is not inside a git repository`);
  });

  test("failed: a stored settings file that does not parse", async () => {
    const repo = makeRepo();
    await callAction("repos.add", { repo });
    writeFileSync(join(caseDir, "agent", "factory", "repos", `${encodeURIComponent(repo)}.yaml`), "merge: [\n");
    const error = await failure(callAction("settings.get", { repo }));
    expect(error.code).toBe("failed");
    expect(error.message).not.toContain("\n");
  });
});

describe("repos", () => {
  test("add registers the primary checkout, list names it, remove unregisters", async () => {
    const repo = makeRepo();
    git(repo, "worktree", "add", "--quiet", "-b", "side", join(caseDir, "side"));
    expect(await callAction("repos.list", {})).toEqual({ repos: [] });
    expect(await callAction("repos.add", { repo: "side" }, { cwd: caseDir })).toEqual({ repo, repos: [repo] });
    expect(await callAction("repos.add", {}, { cwd: repo })).toEqual({ repo, repos: [repo] });
    expect(await callAction("repos.list", {})).toEqual({ repos: [repo] });
    expect(await callAction("repos.remove", { repo })).toEqual({ repos: [] });
    await expectError(callAction("repos.remove", { repo }), "not_found", `${repo} is not registered`);
  });

  test("remove takes a registered path whose repository is gone", async () => {
    const repo = makeRepo();
    await callAction("repos.add", { repo });
    rmSync(repo, { recursive: true, force: true });
    expect(await callAction("repos.remove", { repo })).toEqual({ repos: [] });
  });

  test("core.ts and what it imports load without node_modules", () => {
    const copy = join(caseDir, "plugin");
    mkdirSync(copy);
    for (const name of readdirSync(import.meta.dir)) {
      if ((name.endsWith(".ts") && !name.endsWith(".test.ts")) || name === "factory.template.yaml") copyFileSync(join(import.meta.dir, name), join(copy, name));
    }
    expect(existsSync(join(copy, "node_modules"))).toBe(false);
    const repo = makeRepo();
    mkdirSync(join(caseDir, "agent", "factory", "repos"), { recursive: true });
    writeFileSync(join(caseDir, "agent", "factory", "repos", `${encodeURIComponent(repo)}.yaml`), "{}\n");
    const output = execFileSync("bun", ["-e", 'const { callAction } = await import("./core.ts"); console.log(JSON.stringify(await callAction("repos.list", {})));'], {
      cwd: copy,
      encoding: "utf8",
      env: process.env,
    });
    expect(JSON.parse(output.trim())).toEqual({ repos: [repo] });
  });
});

describe("models", () => {
  test("models.get reads the list, models.set replaces it deduplicated; an empty list reads as []", async () => {
    expect(await callAction("models.get", {})).toEqual({ models: ["a/b", "c/d"] });
    expect(await callAction("models.set", { models: ["x/y", "a/b", "x/y"] })).toEqual({ models: ["x/y", "a/b"] });
    expect(await callAction("models.get", {})).toEqual({ models: ["x/y", "a/b"] });
    expect(await callAction("models.set", { models: [] })).toEqual({ models: [] });
    rmSync(modelsFile());
    expect(await callAction("models.get", {})).toEqual({ models: [] });
    expect(ACTIONS["models.get"].mutates).toBe(false);
    expect(ACTIONS["models.set"].mutates).toBe(true);
  });

  test("models.set refuses a missing, mistyped or malformed list and keeps the old one", async () => {
    await expectError(callAction("models.set", {}), "invalid", "models.set needs models");
    await expectError(callAction("models.set", { models: "a/b" }), "invalid", "models.set: models must be an array");
    await expectError(callAction("models.set", { models: ["sonnet"] }), "invalid", 'models.set: "sonnet" is not a provider/model id');
    await expectError(callAction("models.set", { models: [4] }), "invalid", "models.set: 4 is not a provider/model id");
    expect(await callAction("models.get", {})).toEqual({ models: ["a/b", "c/d"] });
  });

  test("an empty list: settings.set and tasks.start are refused naming /factory models, reads still work", async () => {
    const repo = makeRepo();
    rmSync(modelsFile());
    const noModels = "no factory models are set (set them with /factory models)";
    await expectError(callAction("settings.set", { repo, settings: { merge: "review" } }), "refused", noModels);
    await expectError(callAction("tasks.start", { title: "t", request: "r" }, { cwd: repo }), "refused", noModels);
    expect(((await callAction("settings.get", { repo })) as { stored: object }).stored).toEqual({});
    expect(await callAction("tasks.list", {})).toEqual({ tasks: [] });
    expect(await callAction("repos.add", { repo })).toEqual({ repo, repos: [repo] });
    expect(await listTasks()).toEqual([]);
  });

  test("a model not on the list: settings.set and tasks.start (stored or override) are refused naming it", async () => {
    const repo = makeRepo();
    await expectError(callAction("settings.set", { repo, settings: { models: { coder: "a/b", reviewer: "z/z" } } }), "refused", "the reviewer model z/z is not a factory model");
    await expectError(
      callAction("tasks.start", { title: "t", request: "r", overrides: { models: { coder: "q/q" } } }, { cwd: repo }),
      "refused",
      "the coder model q/q is not a factory model (add it with /factory models add q/q)",
    );
    await callAction("settings.set", { repo, settings: { models: { coder: "c/d" } } });
    await callAction("models.set", { models: ["a/b"] });
    await expectError(callAction("tasks.start", { title: "t", request: "r" }, { cwd: repo }), "refused", "the coder model c/d is not a factory model");
    expect(await listTasks()).toEqual([]);
  });

  test("nothing stored and no override: a task outside a wave starts without a model, though defaults.yaml names models off the list", async () => {
    const repo = makeRepo();
    const { small, big } = defaultModels();
    expect(readFileSync(modelsFile(), "utf8")).not.toContain(big);
    expect(readFileSync(modelsFile(), "utf8")).not.toContain(small);
    const view = (await callAction("tasks.start", { title: "t", request: "r" }, { cwd: repo })) as TaskView;
    const settings = async () => ((await callAction("tasks.get", { id: view.id })) as TaskView).settings;
    await until(async () => (await settings()) !== null && (await settings()) !== undefined);
    expect((await settings())?.models).toEqual({});
  });
});

describe("branches, settings, config", () => {
  test("branches.list: name, default, hasConfig", async () => {
    const repo = makeRepo();
    git(repo, "checkout", "--quiet", "-b", "bare");
    git(repo, "rm", "--quiet", "factory.yaml");
    git(repo, "commit", "--quiet", "-m", "no config");
    git(repo, "checkout", "--quiet", "main");
    expect(await callAction("branches.list", { repo })).toEqual({
      branches: [
        { name: "bare", default: false, hasConfig: false },
        { name: "main", default: true, hasConfig: true },
      ],
    });
  });

  test("settings.get and settings.set: stored, resolved, defaults; preview passes through; invalid values refused", async () => {
    const repo = makeRepo();
    // Nothing stored: no model (Pi's session model), not the ones of defaults.yaml.
    const defaults = { branch: "main", merge: "auto", maxRounds: 2, review: false, models: {}, preview: false, remote: false };
    expect(await callAction("settings.get", { repo })).toEqual({ stored: {}, resolved: defaults, defaults });
    // The old names, as the settings panel sends them: coder is big, a reviewer equal to it is none of its own.
    const set = await callAction("settings.set", { repo, settings: { merge: "review", preview: true, models: { coder: "a/b", reviewer: "a/b" } } });
    expect(set).toEqual({
      stored: { merge: "review", preview: true, models: { big: "a/b" } },
      resolved: { ...defaults, merge: "review", preview: true, models: { big: "a/b", coder: "a/b", reviewer: "a/b" } },
      defaults,
    });
    // An old reviewer of its own stays one; the new names are taken as they are.
    const old = (await callAction("settings.set", { repo, settings: { models: { coder: "a/b", reviewer: "c/d" } } })) as { resolved: { models: object } };
    expect(old.resolved.models).toEqual({ big: "a/b", coder: "a/b", reviewer: "c/d" });
    const sized = (await callAction("settings.set", { repo, settings: { merge: "review", preview: true, models: { small: "c/d", big: "a/b" } } })) as { resolved: { models: object } };
    expect(sized.resolved.models).toEqual({ small: "c/d", big: "a/b", coder: "a/b", reviewer: "a/b" });
    await expectError(callAction("settings.set", { repo, settings: { preview: "yes" } }), "invalid", "settings.preview must be a boolean");
    await expectError(callAction("settings.set", { repo, settings: { maxRounds: 30 } }), "invalid", "settings.maxRounds");
    expect(((await callAction("settings.get", { repo })) as { stored: object }).stored).toEqual({ merge: "review", preview: true, models: { small: "c/d", big: "a/b" } });
    expect(await callAction("repos.list", {})).toEqual({ repos: [repo] });
  });

  test("config.get: the working copy, a branch's committed file, a draft when there is none", async () => {
    const repo = makeRepo();
    expect(await callAction("config.get", { repo })).toEqual({ exists: true, text: "gates: []\n", draft: null, source: [] });
    writeFileSync(join(repo, "factory.yaml"), "gates: [[make, lint]]\n");
    expect(((await callAction("config.get", { repo, branch: "main" })) as { text: string }).text).toBe("gates: []\n");
    await expectError(callAction("config.get", { repo, branch: "nope" }), "not_found", "has no local branch nope");
    rmSync(join(repo, "factory.yaml"));
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { lint: "eslint ." } }));
    const drafted = (await callAction("config.get", { repo })) as { exists: boolean; text: null; draft: string; source: string[] };
    expect(drafted.exists).toBe(false);
    expect(drafted.text).toBeNull();
    expect(drafted.draft).toContain("gates:");
    expect(drafted.source).toEqual(["package.json"]);
  });

  test("config.write needs a registered repo and overwrite: true to replace a file", async () => {
    const repo = makeRepo(false);
    await expectError(callAction("config.write", { repo, text: "gates: []\n" }), "not_found", `${repo} is not registered`);
    expect(existsSync(join(repo, "factory.yaml"))).toBe(false);
    await callAction("repos.add", { repo });
    expect(await callAction("config.write", { repo, text: "gates: []\n" })).toEqual({ path: join(repo, "factory.yaml") });
    await expectError(callAction("config.write", { repo, text: "gates: [[x]]\n" }), "refused", "exists, give overwrite: true to replace it");
    expect(readFileSync(join(repo, "factory.yaml"), "utf8")).toBe("gates: []\n");
  });

  test("config.write checks the text, writes factory.yaml, commits nothing", async () => {
    const repo = makeRepo();
    await callAction("repos.add", { repo });
    await expectError(callAction("config.write", { repo, text: "gates: 3\n", overwrite: true }), "invalid", "factory.yaml: gates must be a list of argv lists");
    expect(await callAction("config.write", { repo, text: "gates: [[make, lint]]\n", overwrite: true })).toEqual({ path: join(repo, "factory.yaml") });
    expect(readFileSync(join(repo, "factory.yaml"), "utf8")).toBe("gates: [[make, lint]]\n");
    expect(git(repo, "status", "--porcelain")).toBe("M factory.yaml");
  });
});

describe("task reads", () => {
  const sessionEntries = [
    { type: "session", version: 3, id: "s" },
    { type: "custom", customType: "factory-task", timestamp: "t1", data: { mainBranch: "main", settings: { branch: "main", merge: "auto", maxRounds: 2, review: true, models: {} } } },
    { type: "message", timestamp: "t2", message: { role: "user", content: "add b.txt" } },
    { type: "custom", customType: "factory-round", timestamp: "t3", data: { round: 1, trigger: "start" } },
    {
      type: "message",
      timestamp: "t4",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "done" }], usage: { input: 10, output: 5, cost: { total: 0.5 } } },
    },
    { type: "message", timestamp: "t5", message: { role: "assistant", content: [{ type: "toolCall" }], usage: { input: 1, output: 1, cost: { total: 0.25 } } } },
    { type: "custom", customType: "factory-review", timestamp: "t6", data: { round: 1, usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 1 } } },
    { type: "custom", customType: "factory-merge-intent", timestamp: "t7", data: { commit: "c", before: "b" } },
    { type: "custom_message", customType: "factory-feedback", content: "fix", timestamp: "t8" },
    { type: "message", timestamp: "t9", message: { role: "user", content: [{ type: "text", text: "/factory retry" }] } },
    { type: "custom", customType: "factory-state", timestamp: "t10", data: { state: "blocked", round: 1, reason: "gates" } },
  ];

  test("tasks.get: state, settings and usage from the session file", async () => {
    const record = fakeRecord(ID_1, "/r");
    await writeTask(record);
    const path = writeSession(record, sessionEntries);
    expect(await callAction("tasks.get", { id: "abc1" })).toEqual({
      id: ID_1,
      repo: "/r",
      worktree: record.worktree,
      branch: record.branch,
      title: record.title,
      createdAt: record.createdAt,
      tag: "team/a",
      plan: null,
      wave: null,
      origin: null,
      sessionId: record.sessionId,
      sessionPath: path,
      state: "blocked",
      round: 1,
      reason: "gates",
      at: "t10",
      question: null,
      running: false,
      interrupted: false,
      settings: { branch: "main", merge: "auto", maxRounds: 2, review: true, models: {} },
      usage: { input: 111, output: 56, cost: 1.75 },
      lastMessage: "done",
      failure: null,
      review: { round: 1, status: "unknown", approved: false, findings: [] },
      merged: null,
      actions: ["tasks.retry", "tasks.cancel", "tasks.remove", "tasks.message"],
    });
  });

  test("tasks.get: the coder's last message (not its commit message), a blocked task's failure, the merged commit", async () => {
    const record = fakeRecord(ID_1, "/r");
    await writeTask(record);
    const custom = (customType: string, data: object) => ({ type: "custom", customType, timestamp: "t", data });
    const said = (role: string, text: string) => ({ type: "message", timestamp: "t", message: { role, content: [{ type: "text", text }] } });
    const gate = (exitCode: number, outputTail: string) => custom("factory-gate", { round: 1, phase: "gates", argv: ["bun", "run", "types"], exitCode, killed: false, durationMs: 1, outputTail });
    const head = [sessionEntries[0], sessionEntries[1], custom("factory-round", { round: 1, trigger: "start" }), said("assistant", "Added b.txt.")];
    writeSession(record, [
      ...head,
      { type: "custom_message", customType: "factory-commit-ask", content: "commit message?", timestamp: "t" },
      said("assistant", "feat: add b"),
      custom("factory-merge", { ok: true, commit: "40ca0ce", error: null, depsSynced: false }),
      custom("factory-state", { state: "done", round: 1, reason: "merged" }),
    ]);
    expect(await callAction("tasks.get", { id: ID_1 })).toMatchObject({ lastMessage: "Added b.txt.", failure: null, merged: "40ca0ce", review: null });
    writeSession(record, [...head, gate(2, "src/a.ts: error\n"), gate(0, "ok"), custom("factory-state", { state: "blocked", round: 1, reason: "max_rounds: gates" })]);
    expect(await callAction("tasks.get", { id: ID_1 })).toMatchObject({ failure: "bun run types (exit 2)\nsrc/a.ts: error", merged: null });
    writeSession(record, [...head, custom("factory-merge", { ok: false, commit: null, error: "rebase conflicts in a.ts", depsSynced: false }), custom("factory-state", { state: "blocked", round: 1, reason: "merge_failed" })]);
    expect(await callAction("tasks.get", { id: ID_1 })).toMatchObject({ failure: "rebase conflicts in a.ts" });
    // A failure fed back to the coder in a later round is not why the task stopped.
    writeSession(record, [...head, gate(2, "x"), custom("factory-round", { round: 2, trigger: "gates" }), custom("factory-state", { state: "blocked", round: 2, reason: "pipeline_error: boom" })]);
    expect(await callAction("tasks.get", { id: ID_1 })).toMatchObject({ failure: null });
  });

  test("tasks.get before the session file exists: nulls", async () => {
    await writeTask(fakeRecord(ID_1, "/r"));
    const view = (await callAction("tasks.get", { id: ID_1 })) as TaskView;
    expect([view.sessionPath, view.state, view.round, view.at, view.settings, view.usage, view.running, view.interrupted]).toEqual([null, null, null, null, null, null, false, false]);
    expect(view.actions).toEqual(["tasks.cancel", "tasks.remove"]);
  });

  test("tasks.timeline: the kinds in order, a cursor that skips what was read and a torn last line", async () => {
    const record = fakeRecord(ID_1, "/r");
    await writeTask(record);
    expect(await callAction("tasks.timeline", { id: ID_1 })).toEqual({ entries: [], next: 0 });
    const path = writeSession(record, sessionEntries);
    const first = (await callAction("tasks.timeline", { id: ID_1 })) as { entries: TimelineEntry[]; next: number };
    expect(first.entries.map((entry) => [entry.at, entry.kind])).toEqual([
      ["t1", "task"],
      ["t2", "user"],
      ["t3", "round"],
      ["t4", "coder"],
      ["t6", "review"],
      ["t10", "state"],
    ]);
    expect(first.entries[3].data).toEqual({ text: "done" });
    expect(first.entries[5].data).toEqual({ state: "blocked", round: 1, reason: "gates" });
    expect(first.next).toBe(readFileSync(path).length);
    const more = { type: "custom", customType: "factory-merge", timestamp: "t11", data: { ok: true, commit: "c", error: null, depsSynced: false } };
    writeFileSync(path, `${readFileSync(path, "utf8")}${JSON.stringify(more)}\n{"type":"cus`);
    const second = (await callAction("tasks.timeline", { id: ID_1, since: first.next })) as { entries: TimelineEntry[]; next: number };
    expect(second.entries).toEqual([{ at: "t11", kind: "merge", data: more.data }]);
    expect(await callAction("tasks.timeline", { id: ID_1, since: second.next })).toEqual({ entries: [], next: second.next });
    await expectError(callAction("tasks.timeline", { id: ID_1, since: 1_000_000 }), "invalid", "past the end");
  });

  test("tasks.list: every task, or the repository's", async () => {
    const repo = makeRepo();
    await writeTask(fakeRecord(ID_1, repo));
    await writeTask(fakeRecord(ID_2, "/elsewhere"));
    const ids = (result: unknown) => (result as { tasks: TaskView[] }).tasks.map((view) => view.id);
    expect(ids(await callAction("tasks.list", { repo }))).toEqual([ID_1]);
    expect(ids(await callAction("tasks.list", {}, { cwd: repo }))).toEqual([ID_1, ID_2]);
  });
});

describe("task actions", () => {
  test("tasks.start refusals: no title, not a repo, no factory.yaml, bad overrides", async () => {
    const repo = makeRepo(false);
    await expectError(callAction("tasks.start", { title: " ", request: "r" }, { cwd: repo }), "invalid", "needs a title");
    await expectError(callAction("tasks.start", { title: "t", request: "r" }, { cwd: caseDir }), "not_found", "is not inside a git repository");
    await expectError(callAction("tasks.start", { title: "t", request: "r" }, { cwd: repo }), "refused", "branch main has no factory.yaml");
    await expectError(callAction("tasks.start", { title: "t", request: "r", overrides: { branch: "nope" } }, { cwd: repo }), "refused", "branch nope does not exist locally");
    await expectError(callAction("tasks.start", { title: "t", request: "r", overrides: { maxRounds: 21 } }, { cwd: repo }), "invalid", "overrides.maxRounds must be an integer from 1 to 20");
    expect(await listTasks()).toEqual([]);
  });

  test("start returns once the runner is spawned; get, approve, then remove", async () => {
    const repo = makeRepo();
    const started = (await callAction("tasks.start", { title: "Add b", request: "add b.txt", repo: "." }, { cwd: repo })) as TaskView;
    expect(started.repo).toBe(repo);
    expect(git(started.worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(started.branch);
    const record = await recordOf(started);
    await until(async () => (await stateOf(record)) === "waiting_approve");
    await until(() => runnerEnded(record));
    const view = (await callAction("tasks.get", { id: record.id.slice(0, 6) })) as TaskView;
    expect([view.state, view.round, view.reason, view.running]).toEqual(["waiting_approve", 1, "passed", false]);
    expect(view.actions).toEqual(["tasks.approve", "tasks.cancel", "tasks.remove", "tasks.message"]);
    await expectError(callAction("tasks.retry", { id: record.id }), "refused", "retry needs blocked, cancelled or interrupted");

    await callAction("tasks.approve", { id: record.id });
    await until(async () => (await stateOf(record)) === "done");
    await until(() => runnerEnded(record));
    expect(prompts()).toEqual(["prompt /factory start", "prompt /factory approve"]);

    expect(await callAction("tasks.remove", { id: record.id })).toEqual({ removed: record.id, dropped: null });
    expect(existsSync(record.worktree)).toBe(false);
    expect(git(repo, "branch", "--list", record.branch)).toBe("");
    expect(existsSync(taskLogPath(record.id))).toBe(false);
    expect(await listTasks()).toEqual([]);
  }, 30_000);

  test("busy: an action while another process holds the task lock", async () => {
    const repo = makeRepo();
    const record = await restingTask(repo, "waiting_approve");
    await lockTask(record.id);
    try {
      await expectError(callAction("tasks.approve", { id: record.id }), "busy", "is busy");
    } finally {
      await unlockTask(record.id);
    }
  }, 30_000);

  test("tasks.diff: base, patch and per-file counts of the worktree, uncommitted files included", async () => {
    const repo = makeRepo();
    const record = await restingTask(repo, "waiting_approve");
    writeFileSync(join(record.worktree, "a.txt"), "a\nmore\n");
    git(record.worktree, "commit", "--quiet", "-am", "more");
    writeFileSync(join(record.worktree, "b.txt"), "b\nc\n");
    const diff = (await callAction("tasks.diff", { id: record.id })) as { base: string; diff: string; files: object[] };
    expect(diff.base).toBe(git(repo, "rev-parse", "main"));
    expect(diff.files).toEqual([
      { path: "a.txt", added: 1, removed: 0 },
      { path: "b.txt", added: 2, removed: 0 },
    ]);
    expect(diff.diff).toContain("+more");
    expect(diff.diff).toContain("b/b.txt");
  }, 30_000);

  test("retry from blocked sends /factory retry, the runner ends with the task blocked again", async () => {
    const repo = makeRepo();
    const record = await restingTask(repo, "blocked");
    await expectError(callAction("tasks.approve", { id: record.id }), "refused", "approve needs waiting_approve");
    const view = (await callAction("tasks.retry", { id: record.id })) as TaskView;
    expect(view.id).toBe(record.id);
    await until(() => prompts().includes("prompt /factory retry"));
    await until(async () => (await lastFactoryState(record.sessionDir, record.sessionId))?.reason === "gates");
    await until(() => runnerEnded(record));
  }, 30_000);

  test("cancel of a running task stops its runner first; remove refuses while it runs", async () => {
    process.env.FAKE_PI_HOLD = "1";
    const repo = makeRepo();
    const record = await startTask(repo);
    await until(async () => (await stateOf(record)) === "running");
    const running = (await callAction("tasks.get", { id: record.id })) as TaskView;
    expect([running.running, running.actions]).toEqual([true, ["tasks.cancel", "tasks.message"]]);
    const refusal = await failure(callAction("tasks.remove", { id: record.id, force: true }));
    expect([refusal.code, refusal.message, refusal.detail]).toEqual(["refused", `task ${record.id.slice(0, 8)} is running, cancel it first`, undefined]);
    await callAction("tasks.cancel", { id: record.id });
    await until(async () => (await stateOf(record)) === "cancelled");
    await until(() => runnerEnded(record));
    await expectError(callAction("tasks.cancel", { id: record.id }), "refused", "is cancelled already");
  }, 30_000);

  test("remove refuses unmerged commits and uncommitted changes unless force, and names what it dropped", async () => {
    const repo = makeRepo();
    const record = await restingTask(repo, "waiting_approve");
    const short = record.id.slice(0, 8);
    writeFileSync(join(record.worktree, "b.txt"), "b\n");
    git(record.worktree, "add", "-A");
    git(record.worktree, "commit", "--quiet", "-m", "b");
    writeFileSync(join(record.worktree, "c.txt"), "c\n");
    const refusal = await failure(callAction("tasks.remove", { id: record.id }));
    expect([refusal.code, refusal.message, refusal.detail]).toEqual([
      "refused",
      `task ${short} has 1 unmerged commit (not on main) and uncommitted changes in its worktree, give force: true to remove it anyway`,
      { force: true },
    ]);
    expect(existsSync(record.worktree)).toBe(true);
    expect(await callAction("tasks.remove", { id: record.id, force: true })).toEqual({ removed: record.id, dropped: "1 unmerged commit (not on main) and uncommitted changes" });
    expect(existsSync(record.worktree)).toBe(false);
  }, 30_000);

  test("a running task whose runner is gone is interrupted; retry runs it", async () => {
    process.env.FAKE_PI_HOLD = "1";
    const repo = makeRepo();
    const record = await startTask(repo);
    await until(async () => (await stateOf(record)) === "running");
    await stopRunners(record);
    const view = (await callAction("tasks.get", { id: record.id })) as TaskView;
    expect([view.state, view.running, view.interrupted]).toEqual(["running", false, true]);
    expect(view.actions).toEqual(["tasks.retry", "tasks.cancel", "tasks.remove", "tasks.message"]);
    delete process.env.FAKE_PI_HOLD;
    await callAction("tasks.retry", { id: record.id });
    await until(() => prompts().includes("prompt /factory retry"));
    await until(async () => (await lastFactoryState(record.sessionDir, record.sessionId))?.reason === "gates");
    await until(() => runnerEnded(record));
  }, 30_000);
});

describe("tasks.message", () => {
  test("a resting task gets the message through a new runner", async () => {
    const repo = makeRepo();
    const record = await restingTask(repo, "blocked");
    const view = (await callAction("tasks.message", { id: record.id, text: "please fix it" })) as TaskView;
    expect(view.id).toBe(record.id);
    await until(() => prompts().includes("prompt please fix"));
    expect(existsSync(taskInboxPath(record.id))).toBe(false);
  }, 30_000);

  test("a running task's live runner gets an inbox line; no state and merging are refused", async () => {
    await writeTask(fakeRecord(ID_1, "/r"));
    await expectError(callAction("tasks.message", { id: ID_1, text: "hi" }), "refused", "has not started yet");
    process.env.FAKE_PI_HOLD = "1";
    const repo = makeRepo();
    const record = await startTask(repo);
    await until(async () => (await stateOf(record)) === "running");
    const view = (await callAction("tasks.message", { id: record.id, text: "also do c" })) as TaskView;
    expect(view.running).toBe(true);
    expect(readFileSync(taskInboxPath(record.id), "utf8")).toBe('{"text":"also do c"}\n');
    expect(prompts()).toEqual(["prompt /factory start"]);

    const merging = fakeRecord(ID_2, "/r");
    await writeTask(merging);
    writeSession(merging, [{ type: "custom", customType: "factory-state", data: { state: "merging", round: 1, reason: "approved" } }]);
    await expectError(callAction("tasks.message", { id: ID_2, text: "hi" }), "refused", "is merging");
  }, 30_000);

  test("a runner that ends as the line is appended: the line is taken back and a new runner delivers it", async () => {
    const repo = makeRepo();
    const record = await restingTask(repo, "blocked");
    writeSession(record, [
      { type: "custom", customType: "factory-task", data: { mainBranch: "main" } },
      { type: "custom", customType: "factory-state", data: { state: "running", round: 2, reason: "message" } },
    ]);
    const runner = Bun.spawn(["bun", exitingRunner, record.worktree, record.sessionDir, record.sessionId, "x"], {
      env: { ...process.env, FAKE_INBOX: taskInboxPath(record.id) },
    });
    await until(async () => (await liveRunners(record)).length === 1);
    await callAction("tasks.message", { id: record.id, text: "late note" });
    await runner.exited;
    await until(() => prompts().includes("prompt late note"));
    expect(readFileSync(taskInboxPath(record.id), "utf8")).toBe("");
  }, 30_000);
});

describe("tasks.import", () => {
  const ID = "11111111-2222-3333-4444-555555555555";

  test("hostOnly: tasks.import only", () => {
    expect(Object.entries(ACTIONS).filter(([, spec]) => spec.hostOnly).map(([name]) => name)).toEqual(["tasks.import"]);
  });

  test("writes a record of a linked worktree on its branch once, keeps an existing one, refuses a wrong shape", async () => {
    const repo = makeRepo();
    const worktree = join(caseDir, "task-wt");
    git(repo, "worktree", "add", "--quiet", "-b", "task", worktree);
    const record = { id: ID, repo, worktree, branch: "task", title: "first", sessionId: `test-session-s-${RUN}`, sessionDir: join(caseDir, "sessions"), createdAt: "2026-01-01T00:00:00.000Z" };
    expect(await callAction("tasks.import", { record })).toMatchObject({ id: ID, title: "first", state: null });
    expect(await callAction("tasks.import", { record: { ...record, title: "second" } })).toMatchObject({ title: "first" });
    await expect(callAction("tasks.import", { record: { ...record, id: "abc" } })).rejects.toMatchObject({ code: "invalid" });
    await expect(callAction("tasks.import", { record: { ...record, id: ID.replace("1", "9"), title: "" } })).rejects.toMatchObject({ code: "invalid" });
    await expect(callAction("tasks.import", { record: { ...record, id: ID.replace("1", "9"), worktree: "task-wt" } })).rejects.toMatchObject({ code: "invalid" });
    expect((await listTasks()).map((task) => task.id)).toEqual([ID]);
  });

  test("refuses a record that would let tasks.remove delete a checkout or branch the task does not own", async () => {
    const repo = makeRepo();
    const victim = join(caseDir, "victim-wt");
    git(repo, "worktree", "add", "--quiet", "-b", "precious", victim);
    const other = makeRepo(true, "other");
    const base = { id: ID, repo, worktree: victim, branch: "precious", title: "t", sessionId: `test-session-s-${RUN}`, sessionDir: join(caseDir, "sessions"), createdAt: "2026-01-01T00:00:00.000Z" };
    const refused = async (change: object, message: string) => expectError(callAction("tasks.import", { record: { ...base, ...change } }), "refused", message);
    await refused({ worktree: repo, branch: "main" }, `${repo} is not a linked worktree of ${repo}`);
    await refused({ branch: "main" }, `${victim} does not have branch main checked out`);
    await refused({ repo: victim }, `${victim} is not the primary checkout of its repository`);
    await refused({ repo: other }, `${victim} is not a linked worktree of ${other}`);
    await refused({ repo: join(caseDir, "nothing") }, "is not a git repository");
    expect(await listTasks()).toEqual([]);
    expect(existsSync(victim)).toBe(true);
  });

  test("an imported record belongs to no wave, whatever its wave field says (invariant 4)", async () => {
    const repo = makeRepo();
    const worktree = join(caseDir, "task-wt");
    git(repo, "worktree", "add", "--quiet", "-b", "task", worktree);
    const wave = `60000000-${RUN}-4000-8000-000000000001`;
    const record = { id: ID, repo, worktree, branch: "task", title: "t", sessionId: `test-session-s-${RUN}`, sessionDir: join(caseDir, "sessions"), createdAt: "2026-01-01T00:00:00.000Z", wave };
    expect(((await callAction("tasks.import", { record })) as TaskView).wave).toBeNull();
    expect((await listTasks()).map((task) => [task.id, task.wave])).toEqual([[ID, null]]);
  });
});

describe("an old merge request record (invariant 7)", () => {
  test("keeps its limits: removing it keeps its source branch and its commits, approve, retry, cancel and message are refused", async () => {
    const repo = makeRepo();
    const worktree = join(caseDir, "mr-wt");
    git(repo, "worktree", "add", "--quiet", "-b", "feature", worktree);
    writeFileSync(join(worktree, "f.txt"), "f\n");
    git(worktree, "add", "-A");
    git(worktree, "commit", "--quiet", "-m", "feature work");
    const feature = git(repo, "rev-parse", "feature");
    const record = { ...fakeRecord(ID_1, repo), worktree, branch: "feature" };
    mkdirSync(tasksDir(), { recursive: true });
    writeFileSync(join(tasksDir(), `${ID_1}.json`), JSON.stringify({ ...record, kind: "merge_request", source: "feature" }));
    writeSession(record, [{ type: "custom", customType: "factory-state", timestamp: "t", data: { state: "waiting_approve", round: 1, reason: "passed" } }]);
    const [loaded] = await listTasks();
    expect(loaded.kind).toBe("merge_request");
    const view = (await callAction("tasks.get", { id: ID_1 })) as TaskView;
    expect("kind" in view).toBe(false);
    expect(view.actions).toEqual(["tasks.remove"]);
    for (const [action, params, what] of [
      ["tasks.approve", {}, "approve"],
      ["tasks.retry", {}, "retry"],
      ["tasks.cancel", {}, "cancel"],
      ["tasks.message", { text: "hi" }, "a message"],
    ] as const) {
      await expectError(callAction(action, { id: ID_1, ...params }), "refused", `is an old merge request: ${what} is refused, it can only be removed`);
    }
    expect(prompts()).toEqual([]);
    // Its commits are its source branch's, which it never owned: no force needed, and the branch stays.
    expect(await callAction("tasks.remove", { id: ID_1 })).toEqual({ removed: ID_1, dropped: null });
    expect(git(repo, "rev-parse", "feature")).toBe(feature);
    expect(existsSync(worktree)).toBe(false);
    expect(await listTasks()).toEqual([]);
  });
});

describe("D review fixes", () => {
  test("a relative repo without cwd is invalid", async () => {
    await expectError(callAction("settings.get", { repo: "some/repo" }), "invalid", "repo some/repo must be an absolute path (the call has no cwd)");
  });

  test("env: the runners an action starts get the caller's environment, not the host's", async () => {
    const repo = makeRepo();
    const envLog = join(caseDir, "env.log");
    process.env.FAKE_PI_START_END = "blocked";
    const env = { ...(process.env as Record<string, string>), FAKE_PI_ENV_LOG: envLog };
    process.env.FACTORY_TEST_SECRET = "leak";
    const record = await recordOf((await callAction("tasks.start", { title: "t", request: "r" }, { cwd: repo, env })) as TaskView);
    await until(async () => (await stateOf(record)) === "blocked");
    await until(() => runnerEnded(record));
    await callAction("tasks.message", { id: record.id, text: "more" }, { env });
    await until(() => existsSync(envLog) && readFileSync(envLog, "utf8").split("\n").length === 3);
    expect(readFileSync(envLog, "utf8")).toBe("secret -\nsecret -\n");
  }, 30_000);

  test("an interrupted task without unmerged work is removed without force", async () => {
    process.env.FAKE_PI_HOLD = "1";
    const repo = makeRepo();
    const record = await startTask(repo);
    await until(async () => (await stateOf(record)) === "running");
    await stopRunners(record);
    expect(await callAction("tasks.remove", { id: record.id })).toEqual({ removed: record.id, dropped: null });
    expect(existsSync(record.worktree)).toBe(false);
  }, 30_000);

  test("an interrupted task with unmerged work: refused with detail force, removed with force", async () => {
    process.env.FAKE_PI_HOLD = "1";
    const repo = makeRepo();
    const record = await startTask(repo);
    await until(async () => (await stateOf(record)) === "running");
    await stopRunners(record);
    writeFileSync(join(record.worktree, "c.txt"), "c\n");
    const refusal = await failure(callAction("tasks.remove", { id: record.id }));
    expect([refusal.code, refusal.detail]).toEqual(["refused", { force: true }]);
    expect(await callAction("tasks.remove", { id: record.id, force: true })).toEqual({ removed: record.id, dropped: "0 unmerged commits (not on main) and uncommitted changes" });
  }, 30_000);

  test("cancel and retry of an interrupted task whose runner cannot start: failed", async () => {
    process.env.FAKE_PI_HOLD = "1";
    const repo = makeRepo();
    const record = await startTask(repo);
    await until(async () => (await stateOf(record)) === "running");
    await stopRunners(record);
    rmSync(record.worktree, { recursive: true, force: true });
    await expectError(callAction("tasks.cancel", { id: record.id }), "failed", `the runner of task ${record.id.slice(0, 8)} ended before it ran`);
    await expectError(callAction("tasks.retry", { id: record.id }), "failed", `the runner of task ${record.id.slice(0, 8)} ended before it ran`);
    expect(await callAction("tasks.remove", { id: record.id })).toEqual({ removed: record.id, dropped: null });
  }, 30_000);

  test("tasks.message: a runner that cannot start is failed, not refused", async () => {
    const repo = makeRepo();
    const record = await restingTask(repo, "blocked");
    process.env.PATH = testPath
      .split(":")
      .filter((dir) => !existsSync(join(dir, "bun")))
      .join(":");
    await expectError(callAction("tasks.message", { id: record.id, text: "hi" }), "failed", "bun is not on PATH");
  }, 30_000);

  test("tasks.timeline reads the session file from since on, not all of it", async () => {
    const record = fakeRecord(ID_1, "/r");
    await writeTask(record);
    const path = writeSession(record, []);
    // Sparse and larger than a Buffer can hold: reading the whole file fails.
    truncateSync(path, 2 ** 32 + 16);
    const since = statSync(path).size;
    const entry = { type: "custom", customType: "factory-state", timestamp: "t1", data: { state: "blocked", round: 1, reason: "gates" } };
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
    try {
      expect(await callAction("tasks.timeline", { id: ID_1, since })).toEqual({ entries: [{ at: "t1", kind: "state", data: entry.data }], next: statSync(path).size });
    } finally {
      rmSync(path, { force: true });
    }
  });
});

describe("task tags", () => {
  test("tasks.start: tag defaults to the system user, plan to null; given ones are stored", async () => {
    const repo = makeRepo();
    const plain = (await callAction("tasks.start", { title: "Add b", request: "add b.txt" }, { cwd: repo })) as TaskView;
    expect([plain.tag, plain.plan]).toEqual([userInfo().username, null]);
    const tagged = (await callAction("tasks.start", { title: "Add c", request: "add c.txt", tag: "plugin/m1/w1", plan: "plan/plugin/m1/w1.md" }, { cwd: repo })) as TaskView;
    expect([tagged.tag, tagged.plan]).toEqual(["plugin/m1/w1", "plan/plugin/m1/w1.md"]);
    const stored = await recordOf(tagged);
    expect([stored.tag, stored.plan]).toEqual(["plugin/m1/w1", "plan/plugin/m1/w1.md"]);
  }, 30_000);

  test("tasks.start refuses a malformed tag and an empty plan before any worktree; kind and source are no params", async () => {
    const repo = makeRepo();
    for (const tag of ["", "a//b", "/a", "a/", "a b", "ä"]) {
      await expectError(callAction("tasks.start", { title: "t", request: "r", tag }, { cwd: repo }), "invalid", "is not segments of");
    }
    await expectError(callAction("tasks.start", { title: "t", request: "r", plan: " " }, { cwd: repo }), "invalid", "plan must not be empty");
    expect(Object.keys(ACTIONS["tasks.start"].params.properties)).not.toContain("kind");
    expect(Object.keys(ACTIONS["tasks.start"].params.properties)).not.toContain("source");
    expect(await listTasks()).toEqual([]);
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
  });

  test("a record written without tag and plan still lists, with the defaults; an old kind is ignored", async () => {
    const { tag: _tag, plan: _plan, ...old } = fakeRecord(ID_1, "/r");
    mkdirSync(tasksDir(), { recursive: true });
    writeFileSync(join(tasksDir(), `${ID_1}.json`), JSON.stringify({ ...old, kind: "merge_request" }));
    const views = ((await callAction("tasks.list", {})) as { tasks: TaskView[] }).tasks;
    expect(views.map((view) => [view.id, view.tag, view.plan, "kind" in view])).toEqual([[ID_1, userInfo().username, null, false]]);
  });

  test("tasks.list tag: the tag itself and the tags under it, not a longer segment", async () => {
    await writeTask({ ...fakeRecord(ID_1, "/r"), tag: "a" });
    await writeTask({ ...fakeRecord(ID_2, "/r"), tag: "a/b" });
    await writeTask({ ...fakeRecord(ID_3, "/r"), tag: "ab" });
    const ids = async (tag: string) => ((await callAction("tasks.list", { tag })) as { tasks: TaskView[] }).tasks.map((view) => view.id);
    expect(await ids("a")).toEqual([ID_1, ID_2]);
    expect(await ids("a/b")).toEqual([ID_2]);
    expect(await ids("ab")).toEqual([ID_3]);
    expect(await ids("a/b/c")).toEqual([]);
    await expectError(callAction("tasks.list", { tag: "a/" }), "invalid", "is not segments of");
  });
});

describe("tasks.wait", () => {
  const stateEntry = (state: string) => ({ type: "custom", customType: "factory-state", timestamp: "t", data: { state, round: 1, reason: "r" } });

  /** A task tagged `tag`: resting in `state`, or starting (no session file) without one. */
  async function waitTask(id: string, tag: string, state?: string): Promise<TaskRecord> {
    const record = { ...fakeRecord(id, "/r"), tag };
    await writeTask(record);
    if (state !== undefined) writeSession(record, [stateEntry(state)]);
    return record;
  }

  type WaitResult = { tasks: TaskView[]; waves: WaveView[]; attention: string[]; timedOut: boolean };
  const wait = async (params: object) => (await callAction("tasks.wait", params)) as WaitResult;

  test("returns at once when every watched task rests; done needs no attention", async () => {
    await waitTask(ID_1, "w", "done");
    await waitTask(ID_2, "w", "cancelled");
    const started = Date.now();
    const result = await wait({ ids: [ID_1, ID_2.slice(0, 6)] });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect([result.tasks.map((view) => view.id), result.attention, result.timedOut]).toEqual([[ID_1, ID_2], [ID_2], false]);
    const done = await wait({ ids: [ID_1] });
    expect([done.attention, done.timedOut]).toEqual([[], false]);
  });

  test("returns when one task blocks while another has not finished", async () => {
    await waitTask(ID_1, "w");
    const blocking = await waitTask(ID_2, "w");
    setTimeout(() => writeSession(blocking, [stateEntry("blocked")]), 300);
    const result = await wait({ tag: "w", timeoutMs: 10_000 });
    expect(result.attention).toEqual([ID_2]);
    expect(result.timedOut).toBe(false);
    expect(result.tasks.map((view) => [view.id, view.state])).toEqual([
      [ID_1, null],
      [ID_2, "blocked"],
    ]);
  });

  test("tag: a task started during the wait is watched too", async () => {
    await waitTask(ID_1, "w/x");
    setTimeout(() => void waitTask(ID_2, "w/y", "waiting_approve"), 300);
    const result = await wait({ tag: "w", timeoutMs: 10_000 });
    expect([result.attention, result.timedOut]).toEqual([[ID_2], false]);
  });

  test("ignore leaves a task out of the watched ones", async () => {
    await waitTask(ID_1, "w");
    await waitTask(ID_2, "w", "done");
    const result = await wait({ tag: "w", ignore: [ID_1] });
    expect([result.tasks.map((view) => view.id), result.attention, result.timedOut]).toEqual([[ID_2], [], false]);
  });

  test("times out after timeoutMs while a task has not rested; no watched task answers at once", async () => {
    await waitTask(ID_1, "w");
    const started = Date.now();
    const result = await wait({ ids: [ID_1], timeoutMs: 1_000 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
    expect([result.tasks.map((view) => view.id), result.attention, result.timedOut]).toEqual([[ID_1], [], true]);
    expect(await wait({ tag: "nobody" })).toEqual({ tasks: [], waves: [], attention: [], timedOut: false });
  });

  test("an abort ends the wait", async () => {
    await waitTask(ID_1, "w");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await expectError(callAction("tasks.wait", { ids: [ID_1] }, { signal: controller.signal }), "failed", "tasks.wait was aborted");
  });

  test("an interrupted task (a running state, no runner) rests and needs attention (m7)", async () => {
    await waitTask(ID_1, "w", "running");
    const result = await wait({ ids: [ID_1], timeoutMs: 5_000 });
    expect([result.attention, result.timedOut, result.tasks[0].interrupted]).toEqual([[ID_1], false, true]);
  });

  test("a resting state with a live runner does not rest until the runner ends (m7)", async () => {
    const record = await waitTask(ID_1, "w", "blocked");
    const runner = Bun.spawn(["bun", exitingRunner, record.worktree, record.sessionDir, record.sessionId, "x"], { env: { ...process.env, FAKE_INBOX: taskInboxPath(record.id) } });
    await until(async () => (await liveRunners(record)).length === 1);
    const timedOut = await wait({ ids: [ID_1], timeoutMs: 1_000 });
    expect([timedOut.attention, timedOut.timedOut, timedOut.tasks[0].running]).toEqual([[], true, true]);
    setTimeout(() => writeFileSync(taskInboxPath(record.id), ""), 300);
    const ended = await wait({ ids: [ID_1], timeoutMs: 10_000 });
    expect([ended.attention, ended.timedOut]).toEqual([[ID_1], false]);
    await runner.exited;
  }, 30_000);

  test("a poll looks for no runner while that cannot end the wait: only the answer's views do (m5)", async () => {
    const pgrepLog = join(caseDir, "pgrep.log");
    const wrapperBin = join(caseDir, "pgrep-bin");
    mkdirSync(wrapperBin);
    const realPgrep = execFileSync("sh", ["-c", "command -v pgrep"], { encoding: "utf8" }).trim();
    writeFileSync(join(wrapperBin, "pgrep"), `#!/bin/sh\necho x >> "${pgrepLog}"\nexec "${realPgrep}" "$@"\n`, { mode: 0o755 });
    process.env.PATH = `${wrapperBin}:${process.env.PATH}`;
    await waitTask(ID_1, "w");
    await waitTask(ID_2, "w", "done");
    const result = await wait({ tag: "w", timeoutMs: 1_500 });
    expect(result.timedOut).toBe(true);
    // One lookup per task for the answer's TaskViews; the polls before it (a starting task, a done one) need none.
    expect(readFileSync(pgrepLog, "utf8").trim().split("\n")).toHaveLength(2);
  });

  test("invalid: ids and tag both or neither, empty ids, a timeout out of bounds", async () => {
    await waitTask(ID_1, "w", "done");
    await expectError(wait({}), "invalid", "tasks.wait needs exactly one of ids, tag and wave");
    await expectError(wait({ ids: [ID_1], tag: "w" }), "invalid", "tasks.wait needs exactly one of ids, tag and wave");
    await expectError(wait({ ids: [""] }), "invalid", "ids must hold non-empty strings");
    await expectError(wait({ ids: [ID_1], timeoutMs: 999 }), "invalid", "timeoutMs must be at least 1000");
    await expectError(wait({ ids: [ID_1], timeoutMs: 3_600_001 }), "invalid", "timeoutMs must be at most 3600000");
    expect(ACTIONS["tasks.wait"].mutates).toBe(false);
  });
});

describe("waiting_answer", () => {
  test("TaskView: the open question, actions message and cancel; timeline kind question; remove refused; tasks.wait needs attention", async () => {
    const record = fakeRecord(ID_1, "/r");
    await writeTask(record);
    const asked = [
      { type: "custom", customType: "factory-round", timestamp: "t1", data: { round: 1, trigger: "start" } },
      { type: "custom", customType: "factory-question", timestamp: "t2", data: { text: "Which table?" } },
      { type: "custom", customType: "factory-state", timestamp: "t3", data: { state: "waiting_answer", round: 1, reason: "question" } },
    ];
    const path = writeSession(record, asked);
    const view = (await callAction("tasks.get", { id: ID_1 })) as TaskView;
    expect([view.state, view.question, view.running, view.interrupted, view.actions]).toEqual(["waiting_answer", "Which table?", false, false, ["tasks.cancel", "tasks.message"]]);
    const timeline = (await callAction("tasks.timeline", { id: ID_1 })) as { entries: TimelineEntry[] };
    expect(timeline.entries[1]).toEqual({ at: "t2", kind: "question", data: { text: "Which table?" } });
    await expectError(callAction("tasks.remove", { id: ID_1, force: true }), "refused", "waits for the answer to its question");
    expect(await callAction("tasks.wait", { ids: [ID_1] })).toMatchObject({ attention: [ID_1], timedOut: false });

    appendFileSync(path, `${JSON.stringify({ type: "custom", customType: "factory-state", timestamp: "t4", data: { state: "blocked", round: 1, reason: "gates" } })}\n`);
    const answered = (await callAction("tasks.get", { id: ID_1 })) as TaskView;
    expect([answered.state, answered.question]).toEqual(["blocked", null]);
  });
});

describe("waves", () => {
  const spec = (key: string, after: string[] = []) => ({ key, title: `Task ${key}`, request: `do ${key}`, after });
  const TAG = "factory/w1";

  async function registeredRepo(withConfig = true): Promise<string> {
    const repo = makeRepo(withConfig);
    await callAction("repos.add", {}, { cwd: repo });
    return repo;
  }

  async function startWave(repo: string, tasks: unknown, extra: Record<string, unknown> = {}): Promise<WaveView> {
    const params = { tag: TAG, title: "Wave one", request: "review the wave", tasks, ...extra };
    return ((await callAction("waves.start", params, { cwd: repo, origin: "session-0" })) as { wave: WaveView }).wave;
  }

  const getWave = async (id: string) => ((await callAction("waves.get", { id })) as { wave: WaveView }).wave;
  const recordById = async (id: string | null) => {
    const record = (await listTasks()).find((task) => task.id === id);
    if (!record) throw new Error(`no task ${id}`);
    return record;
  };
  const taskOf = (wave: WaveView, key: string) => {
    const task = wave.tasks.find((candidate) => candidate.key === key);
    if (!task) throw new Error(`no task ${key}`);
    return task;
  };

  /** A wave written directly (no branch, no runner): for the reads. */
  async function writtenWave(id: string, repo: string, tag: string, createdAt = "2026-01-01T00:00:00.000Z"): Promise<void> {
    await createWave({ id, repo, tag, plan: null, title: `wave ${tag}`, request: "r", branch: `main-${tag}`, target: "main", base: "abc", origin: null, createdAt, overrides: {} });
  }

  test("waves.start creates the branch off the target, the record and starts the tasks that wait for nothing", async () => {
    const repo = await registeredRepo();
    const main = git(repo, "rev-parse", "main");
    const overrides = { maxRounds: 3, merge: "review" as const, models: { small: "c/d", big: "a/b" } };
    let wave = await startWave(repo, [spec("a"), spec("b", ["a"]), spec("c")], { plan: "plan/w1.md", overrides });
    expect(wave).toMatchObject({ repo, tag: TAG, plan: "plan/w1.md", title: "Wave one", request: "review the wave", branch: "main-factory-w1", target: "main", base: main });
    expect(wave).toMatchObject({ origin: "session-0", stage: "building", reason: null, counts: { total: 3, done: 0 } });
    expect("overrides" in wave).toBe(false);
    expect(git(repo, "rev-parse", "refs/heads/main-factory-w1")).toBe(main);
    // The wave's runner starts the tasks that wait for nothing; it lives while the wave does not rest.
    await until(async () => (await getWave(wave.id)).tasks.filter((task) => task.taskId !== null).length === 2);
    wave = await getWave(wave.id);
    expect([wave.running, wave.interrupted]).toEqual([true, false]);
    expect(taskOf(wave, "b")).toEqual({ key: "b", title: "Task b", after: ["a"], model: "big", taskId: null, sessionId: null, state: "pending", usage: null });
    for (const key of ["a", "c"]) {
      const task = taskOf(wave, key);
      const record = await recordById(task.taskId);
      expect(task.sessionId).toBe(record.sessionId);
      expect(record).toMatchObject({ wave: wave.id, tag: TAG, plan: "plan/w1.md", title: `Task ${key}` });
      expect(git(record.worktree, "rev-parse", "HEAD")).toBe(main);
      await until(async () => (await stateOf(record)) === "waiting_approve");
      const view = (await callAction("tasks.get", { id: record.id })) as TaskView;
      expect(view.wave).toBe(wave.id);
      // The wave's settings, its branch as the target, and a task merges by itself.
      expect(view.settings).toEqual({ branch: "main-factory-w1", merge: "auto", maxRounds: 3, review: false, models: { small: "c/d", big: "a/b", coder: "a/b", reviewer: "a/b" } });
    }
    const file = await readWave(wave.id);
    // Stored resolved: the overrides over the repository's stored settings (none here) over the defaults.
    expect(file.declaration.overrides).toEqual({ ...overrides, review: false, remote: false });
    expect(file.events.map((event) => event.kind)).toEqual(["tasks", "task", "task"]);
    expect(prompts().filter((line) => line === "prompt /factory start")).toHaveLength(2);
    // The same tag on the same target: its branch exists.
    await expectError(startWave(repo, [spec("x")]), "refused", "main-factory-w1 exists already");
  });

  test("waves.start stores the repository's stored settings with the overrides over them, resolved; a later change does not reach the wave", async () => {
    const repo = await registeredRepo();
    await callAction("settings.set", { repo, settings: { merge: "review", maxRounds: 4, models: { coder: "a/b", reviewer: "c/d" } } });
    const wave = await startWave(repo, [spec("a")], { overrides: { maxRounds: 1, models: { coder: "c/d" } } });
    // Its runner's launch ends before the test does: a runner stopped mid-launch outlasts the test's time.
    await until(async () => taskOf(await getWave(wave.id), "a").taskId !== null);
    // The old names: coder is big, a reviewer equal to big is no reviewer of its own.
    const resolved = { merge: "review" as const, maxRounds: 1, review: false, models: { big: "c/d" }, remote: false };
    expect((await readWave(wave.id)).declaration.overrides).toEqual(resolved);
    await callAction("settings.set", { repo, settings: { merge: "auto", models: { reviewer: "a/b" } } });
    expect((await readWave(wave.id)).declaration.overrides).toEqual(resolved);
  });

  test("a task with after starts once its predecessor is done (its runner pokes the wave); a wave without changes ends merged", async () => {
    // The wave runner never polls in this test: only the pokes of the tasks' runners move it on.
    process.env.FACTORY_WAVE_POLL_MS = "600000";
    process.env.FAKE_PI_START_END = "done";
    const repo = await registeredRepo();
    const wave = await startWave(repo, [spec("a"), spec("b", ["a"])]);
    expect(taskOf(wave, "b").state).toBe("pending");
    await until(async () => taskOf(await getWave(wave.id), "b").taskId !== null, 20_000);
    const a = await recordById(taskOf(await getWave(wave.id), "a").taskId);
    expect(await stateOf(a)).toBe("done");
    const b = await recordById(taskOf(await getWave(wave.id), "b").taskId);
    expect(b.wave).toBe(wave.id);
    // Nothing differs from the target: no review, no merge, the wave rests merged and its runner ends.
    await until(async () => (await getWave(wave.id)).stage === "merged", 20_000);
    await until(async () => (await liveWaveRunners(wave.id)).length === 0);
    const done = await getWave(wave.id);
    expect([done.counts, done.merge, done.running, done.interrupted]).toEqual([{ total: 2, done: 2 }, null, false, false]);
    expect((await readWave(wave.id)).events.map((event) => event.kind)).toEqual(["tasks", "task", "task", "stage", "stage"]);
  }, 30_000);

  test("waves.add to a rejected wave returns it to building; after may name existing keys", async () => {
    const repo = await registeredRepo();
    const wave = await startWave(repo, [spec("a")]);
    await until(async () => taskOf(await getWave(wave.id), "a").taskId !== null);
    await appendWaveEvent(wave.id, { kind: "stage", stage: "rejected", reason: null });
    expect((await getWave(wave.id)).stage).toBe("rejected");
    // A stage change pokes the runner (as the actions do), which sees the wave rest and ends.
    await pokeWave(wave.id);
    await until(async () => (await liveWaveRunners(wave.id)).length === 0);
    const added = ((await callAction("waves.add", { id: wave.id.slice(0, 8), tasks: [spec("fix", ["a"]), spec("more")] })) as { wave: WaveView }).wave;
    expect(added.stage).toBe("building");
    expect(taskOf(added, "fix").state).toBe("pending");
    expect(added.counts).toEqual({ total: 3, done: 0 });
    // The poke started a runner again: it starts what can start.
    await until(async () => taskOf(await getWave(wave.id), "more").taskId !== null);
    expect(taskOf(await getWave(wave.id), "fix").taskId).toBeNull();
    await stopWaveRunners(wave.id);
    const kinds = (await readWave(wave.id)).events.map((event) => event.kind);
    expect(kinds).toEqual(["tasks", "task", "stage", "tasks", "stage", "task"]);
    await expectError(callAction("waves.add", { id: wave.id, tasks: [spec("a")] }), "invalid", "task key a is not unique");
    await expectError(callAction("waves.add", { id: wave.id, tasks: [spec("x", ["nope"])] }), "invalid", "waits for nope");
    await appendWaveEvent(wave.id, { kind: "stage", stage: "merged", reason: null });
    await expectError(callAction("waves.add", { id: wave.id, tasks: [spec("late")] }), "refused", "is merged");
    await expectError(callAction("waves.add", { id: "ffffffff", tasks: [spec("late")] }), "not_found", "no wave");
  }, 30_000);

  test("a wave's small task runs its coder on the small model, its neighbour on the big one; the reviewer on the big one", async () => {
    const repo = await registeredRepo();
    const models = { small: "c/d", big: "a/b" };
    const wave = await startWave(repo, [{ ...spec("cheap"), model: "small" }, spec("other")], { overrides: { models } });
    expect(taskOf(wave, "cheap").model).toBe("small");
    expect(taskOf(wave, "other").model).toBe("big");
    await until(async () => (await getWave(wave.id)).tasks.every((task) => task.taskId !== null));
    const settingsOf = async (key: string) => ((await callAction("tasks.get", { id: taskOf(await getWave(wave.id), key).taskId })) as TaskView).settings?.models;
    expect(await settingsOf("cheap")).toEqual({ ...models, coder: "c/d", reviewer: "a/b" });
    expect(await settingsOf("other")).toEqual({ ...models, coder: "a/b", reviewer: "a/b" });
    const [tasks] = (await readWave(wave.id)).events;
    expect(tasks).toMatchObject({ kind: "tasks", tasks: [{ key: "cheap", model: "small" }, { key: "other" }] });
    expect(tasks.kind === "tasks" && "model" in tasks.tasks[1]).toBe(false);
    expect((await readWave(wave.id)).declaration.overrides.models).toEqual(models);
  });

  test("a wave that names no model: a small task takes defaults.yaml's small when it is listed, else none; big and the reviewer none", async () => {
    const repo = await registeredRepo();
    const { small, big } = defaultModels();
    const settingsOf = async (id: string, key: string) => ((await callAction("tasks.get", { id: taskOf(await getWave(id), key).taskId })) as TaskView).settings?.models;
    // Off the list: skipped (Pi's session model), never refused.
    const off = await startWave(repo, [{ ...spec("cheap"), model: "small" }, spec("other")]);
    await until(async () => (await getWave(off.id)).tasks.every((task) => task.taskId !== null));
    expect(await settingsOf(off.id, "cheap")).toEqual({});
    expect(await settingsOf(off.id, "other")).toEqual({});
    expect((await readWave(off.id)).declaration.overrides.models).toEqual({});
    await stopWaveRunners(off.id);
    // Listed: the small task's coder runs on it; the big default still never applies.
    writeFileSync(modelsFile(), `- a/b\n- ${small}\n- ${big}\n`);
    const on = await startWave(repo, [{ ...spec("cheap"), model: "small" }, spec("other")], { tag: `${TAG}-on` });
    await until(async () => (await getWave(on.id)).tasks.every((task) => task.taskId !== null));
    expect(await settingsOf(on.id, "cheap")).toEqual({ small, coder: small });
    expect(await settingsOf(on.id, "other")).toEqual({ small });
    await stopWaveRunners(on.id);
  }, 30_000);

  test("a concrete model id in a wave's task is invalid before anything is created; a small model off the list is refused; waves.add takes small too", async () => {
    const repo = await registeredRepo();
    const start = (tasks: unknown[], overrides?: object) => callAction("waves.start", { tag: TAG, title: "t", request: "r", tasks, overrides }, { cwd: repo });
    await expectError(start([spec("a"), { ...spec("b"), model: "c/d" }]), "invalid", 'tasks[1].model must be "small" or "big"');
    await expectError(start([{ ...spec("a"), model: 4 }]), "invalid", "tasks[0].model");
    await expectError(start([{ ...spec("a"), model: "small" }], { models: { small: "x/y", big: "a/b" } }), "refused", "the small model x/y is not a factory model");
    expect(git(repo, "branch", "--list", "main-*")).toBe("");
    expect(await listWaves()).toEqual([]);
    expect(await listTasks()).toEqual([]);

    const wave = await startWave(repo, [spec("a")], { overrides: { models: { small: "c/d", big: "a/b" } } });
    await until(async () => taskOf(await getWave(wave.id), "a").taskId !== null);
    const add = (tasks: unknown[]) => callAction("waves.add", { id: wave.id, tasks });
    const before = (await readWave(wave.id)).events.length;
    await expectError(add([{ ...spec("bad"), model: "c/d" }]), "invalid", 'tasks[0].model must be "small" or "big"');
    expect((await readWave(wave.id)).events).toHaveLength(before);
    const added = ((await add([{ ...spec("fix", ["a"]), model: "small" }])) as { wave: WaveView }).wave;
    expect(taskOf(added, "fix")).toMatchObject({ model: "small", state: "pending" });
    expect((await readWave(wave.id)).events.at(-1)).toMatchObject({ kind: "tasks", tasks: [{ key: "fix", model: "small" }] });
  }, 30_000);

  test("every validation error of waves.start, and none leaves a branch or a wave", async () => {
    const repo = await registeredRepo();
    const start = (params: Record<string, unknown>, cwd = repo) =>
      callAction("waves.start", { tag: TAG, title: "t", request: "r", tasks: [spec("a")], ...params }, { cwd });
    await expectError(callAction("waves.start", { title: "t", request: "r", tasks: [spec("a")] }, { cwd: repo }), "invalid", "needs tag");
    await expectError(start({ tag: "a//b" }), "invalid", "is not segments");
    await expectError(start({ title: " " }), "invalid", "title");
    await expectError(start({ request: "" }), "invalid", "request");
    await expectError(start({ plan: "" }), "invalid", "plan");
    await expectError(start({ tasks: [] }), "invalid", "non-empty array");
    await expectError(start({ tasks: "a" }), "invalid", "must be an array");
    await expectError(start({ tasks: [spec("a b")] }), "invalid", "key");
    await expectError(start({ tasks: [spec("a"), spec("a")] }), "invalid", "not unique");
    await expectError(start({ tasks: [{ key: "a", title: "t" }] }), "invalid", "request");
    await expectError(start({ tasks: [spec("a", ["b"])] }), "invalid", "waits for b");
    await expectError(start({ tasks: [spec("a", ["b"]), spec("b", ["a"])] }), "invalid", "cycle");
    await expectError(start({ overrides: { maxRounds: 0 } }), "invalid", "maxRounds");
    await expectError(start({ overrides: { models: { coder: "x/y" } } }), "refused", "x/y");
    await expectError(start({ overrides: { branch: "nope" } }), "not_found", "no local branch nope");
    const unregistered = makeRepo(true, "other");
    await expectError(start({}, unregistered), "not_found", "is not registered");
    const bare = makeRepo(false, "bare");
    await callAction("repos.add", {}, { cwd: bare });
    await expectError(start({}, bare), "refused", "has no factory.yaml");
    expect(git(repo, "branch", "--list", "main-*")).toBe("");
    expect(await listWaves()).toEqual([]);
    expect(await listTasks()).toEqual([]);
    await expectError(callAction("waves.get", { id: "nothing" }), "not_found", "no wave");
  });

  test("waves.list filters by repository and by tag (equal or prefix + /)", async () => {
    const repo = await registeredRepo();
    await writtenWave(`10000000-${RUN}-4000-8000-000000000001`, repo, "factory/w1", "2026-01-01T00:00:01.000Z");
    await writtenWave(`10000000-${RUN}-4000-8000-000000000002`, repo, "factory/w2", "2026-01-01T00:00:02.000Z");
    await writtenWave(`10000000-${RUN}-4000-8000-000000000003`, "/elsewhere", "factorybot/w1", "2026-01-01T00:00:03.000Z");
    const list = async (params: object) => ((await callAction("waves.list", params, { cwd: repo })) as { waves: WaveView[] }).waves.map((wave) => wave.tag);
    expect(await list({})).toEqual(["factory/w1", "factory/w2", "factorybot/w1"]);
    expect(await list({ tag: "factory" })).toEqual(["factory/w1", "factory/w2"]);
    expect(await list({ tag: "factory/w1" })).toEqual(["factory/w1"]);
    expect(await list({ repo })).toEqual(["factory/w1", "factory/w2"]);
    await expectError(list({ tag: "a//" }), "invalid", "tag");
  });

  test("the view: task states and usage, counts without cancelled tasks, usage of tasks and reviews, timeline", async () => {
    const repo = makeRepo();
    const id = `20000000-${RUN}-4000-8000-000000000001`;
    await writtenWave(id, repo, "factory/w9");
    const usage = (input: number, output: number, total: number) => ({ type: "message", message: { role: "assistant", usage: { input, output, cost: { total } } } });
    const state = (name: string) => ({ type: "custom", customType: "factory-state", data: { state: name, round: 1, reason: "r" } });
    const done = { ...fakeRecord(ID_1, repo), wave: id };
    const cancelled = { ...fakeRecord(ID_2, repo), wave: id };
    for (const record of [done, cancelled]) await writeTask(record);
    writeSession(done, [state("running"), usage(10, 5, 0.5), state("done")]);
    writeSession(cancelled, [state("running"), usage(1, 1, 0.25), state("cancelled")]);
    await appendWaveEvent(id, { kind: "tasks", tasks: [spec("a"), spec("b"), spec("c", ["a"]), spec("gone")] });
    await appendWaveEvent(id, { kind: "task", key: "a", taskId: done.id, sessionId: done.sessionId });
    await appendWaveEvent(id, { kind: "task", key: "b", taskId: cancelled.id, sessionId: cancelled.sessionId });
    await appendWaveEvent(id, { kind: "task", key: "gone", taskId: ID_3, sessionId: "session-gone" });
    const review = { round: 1, sessionId: "rev", model: "a/b", verdict: "rejected" as const, status: "ok", findings: [], usage: { input: 100, output: 50, cost: 1 }, wallMs: 5 };
    await appendWaveEvent(id, { kind: "review", ...review });
    const wave = await getWave(id);
    expect(wave.tasks.map((task) => [task.key, task.state, task.usage])).toEqual([
      ["a", "done", { input: 10, output: 5, cost: 0.5 }],
      ["b", "cancelled", { input: 1, output: 1, cost: 0.25 }],
      ["c", "pending", null],
      // A task whose record was removed never finishes: it counts as cancelled.
      ["gone", "cancelled", null],
    ]);
    expect(wave.counts).toEqual({ total: 2, done: 1 });
    expect(wave.usage).toEqual({ input: 111, output: 56, cost: 1.75 });
    expect(wave.reviews).toEqual([{ at: expect.any(String), ...review }]);
    // Not resting and no runner: interrupted, whatever the stage.
    expect([wave.running, wave.interrupted]).toEqual([false, true]);
    expect(wave.actions).toEqual(["waves.add", "waves.retry", "waves.cancel", "waves.remove"]);
    await appendWaveEvent(id, { kind: "stage", stage: "reviewing", reason: null });
    expect((await getWave(id)).interrupted).toBe(true);
    await appendWaveEvent(id, { kind: "stage", stage: "rejected", reason: null });
    expect((await getWave(id)).interrupted).toBe(false);
    const timeline = (await callAction("waves.timeline", { id, since: 4 })) as { events: { kind: string }[]; next: number };
    expect(timeline.events.map((event) => event.kind)).toEqual(["review", "stage", "stage"]);
    expect(timeline.next).toBe(7);
    expect(((await callAction("waves.timeline", { id, since: 7 })) as { events: unknown[] }).events).toEqual([]);
    await expectError(callAction("waves.timeline", { id, since: 8 }), "invalid", "past");
  });

  test("a record of the wave no task event names (its runner died after the launch) is adopted, not launched again", async () => {
    const repo = makeRepo();
    git(repo, "branch", "main-factory-w9");
    const id = `20000000-${RUN}-4000-8000-000000000002`;
    await createWave({ id, repo, tag: "factory/w9", plan: null, title: "w", request: "r", branch: "main-factory-w9", target: "main", base: git(repo, "rev-parse", "main"), origin: null, createdAt: "2026-01-01T00:00:00.000Z", overrides: {} });
    await appendWaveEvent(id, { kind: "tasks", tasks: [spec("a")] });
    const orphan = { ...fakeRecord(ID_1, repo), title: "Task a", tag: "factory/w9", wave: id };
    await writeTask(orphan);
    // Another wave's record and one of another title are no orphans of this task.
    await writeTask({ ...fakeRecord(ID_2, repo), title: "Task a", wave: `20000000-${RUN}-4000-8000-000000000003` });
    expect(await startWaveTasks(id)).toEqual(["a"]);
    expect(taskOf(await getWave(id), "a")).toMatchObject({ taskId: ID_1, sessionId: orphan.sessionId });
    expect((await listTasks()).map((record) => record.id)).toEqual([ID_1, ID_2]);
    expect(prompts()).toEqual([]);
  });

  test("a stopping runner starts no further task: the launch in progress is undone, nothing of it is left", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "factory.yaml"), 'hooks:\n  after_create:\n    - ["sleep", "5"]\ngates: []\n');
    git(repo, "commit", "--quiet", "-am", "a slow hook");
    git(repo, "branch", "main-factory-w9");
    const id = `20000000-${RUN}-4000-8000-000000000004`;
    await createWave({ id, repo, tag: "factory/w9", plan: null, title: "w", request: "r", branch: "main-factory-w9", target: "main", base: git(repo, "rev-parse", "main"), origin: null, createdAt: "2026-01-01T00:00:00.000Z", overrides: {} });
    await appendWaveEvent(id, { kind: "tasks", tasks: [spec("a"), spec("b")] });
    const stopped = new AbortController();
    stopped.abort();
    expect(await startWaveTasks(id, undefined, stopped.signal)).toEqual([]);
    // Stopped while the first launch runs its after_create hook: the hook is killed, its worktree and branch removed.
    const stopping = new AbortController();
    setTimeout(() => stopping.abort(), 500);
    const begun = Date.now();
    expect(await startWaveTasks(id, undefined, stopping.signal)).toEqual([]);
    expect(Date.now() - begun).toBeLessThan(4_000);
    expect(await listTasks()).toEqual([]);
    expect(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
    expect(git(repo, "branch", "--format=%(refname:short)")).toBe("main\nmain-factory-w9");
    expect((await readWave(id)).events.map((event) => event.kind)).toEqual(["tasks"]);
    expect(prompts()).toEqual([]);
  });

  test("tasks.start (and with it factory_new_task) refuses the branch of a wave not merged or cancelled (invariant 13)", async () => {
    const repo = makeRepo();
    git(repo, "branch", "main-factory-w9");
    const id = `20000000-${RUN}-4000-8000-000000000005`;
    await createWave({ id, repo, tag: "factory/w9", plan: null, title: "w", request: "r", branch: "main-factory-w9", target: "main", base: git(repo, "rev-parse", "main"), origin: null, createdAt: "2026-01-01T00:00:00.000Z", overrides: {} });
    const start = () => callAction("tasks.start", { title: "t", request: "r", overrides: { branch: "main-factory-w9" } }, { cwd: repo });
    for (const stage of [null, "reviewing", "rejected", "blocked", "waiting_approve", "merging"] as const) {
      if (stage !== null) await appendWaveEvent(id, { kind: "stage", stage, reason: stage === "blocked" ? "gates" : null });
      await expectError(start(), "refused", `main-factory-w9 is the branch of wave 20000000, which is ${stage ?? "building"}: only the wave's own tasks reach it; give the work to the wave with waves.add`);
    }
    expect(await listTasks()).toEqual([]);
    expect(prompts()).toEqual([]);
    // Another target of the same repository is no wave's.
    expect(((await callAction("tasks.start", { title: "t", request: "r" }, { cwd: repo })) as TaskView).wave).toBeNull();
    // Once the wave is merged its branch takes tasks again.
    await appendWaveEvent(id, { kind: "stage", stage: "merged", reason: null });
    expect(((await start()) as TaskView).wave).toBeNull();
    expect(await listTasks()).toHaveLength(2);
  });

  test("waves.start that fails midway (its runner does not start) leaves no branch and no record behind", async () => {
    const repo = await registeredRepo();
    const id: `${string}-${string}-${string}-${string}-${string}` = `20000000-${RUN}-4000-8000-000000000006`;
    // The poke's marker cannot be written: a directory lies where it goes.
    mkdirSync(wavePokePath(id), { recursive: true });
    const uuid = spyOn(crypto, "randomUUID").mockReturnValue(id);
    try {
      await expectError(startWave(repo, [spec("a")]), "failed", "its runner did not start");
    } finally {
      uuid.mockRestore();
    }
    expect(git(repo, "branch", "--format=%(refname:short)")).toBe("main");
    expect(await listWaves()).toEqual([]);
    expect(existsSync(wavePokePath(id))).toBe(false);
    expect(await listTasks()).toEqual([]);
    // Nothing of it is in the way of the next declaration.
    const again = await startWave(repo, [spec("a")]);
    expect(again.branch).toBe("main-factory-w1");
    // Its runner's launch ends before the test does.
    await until(async () => taskOf(await getWave(again.id), "a").taskId !== null);
  });

  test("tasks.start cannot set a wave", async () => {
    const repo = makeRepo();
    expect(Object.keys(ACTIONS["tasks.start"].params.properties)).not.toContain("wave");
    const view = (await callAction("tasks.start", { title: "t", request: "r", wave: `20000000-${RUN}-4000-8000-000000000001` }, { cwd: repo })) as TaskView;
    expect(view.wave).toBeNull();
    expect((await recordById(view.id)).wave).toBeNull();
  });
});

describe("waiting on waves and the wave actions", () => {
  const WAVE = `50000000-${RUN}-4000-8000-000000000001`;
  const spec = (key: string) => ({ key, title: `Task ${key}`, request: `do ${key}`, after: [] });
  const stateEntry = (state: string) => ({ type: "custom", customType: "factory-state", timestamp: "t", data: { state, round: 1, reason: "r" } });
  type WaitResult = { tasks: TaskView[]; waves: WaveView[]; attention: string[]; timedOut: boolean };
  const wait = async (params: object) => (await callAction("tasks.wait", params)) as WaitResult;
  const getWave = async (id = WAVE) => ((await callAction("waves.get", { id })) as { wave: WaveView }).wave;

  /** A wave written directly with two tasks in `states` (a, b), at `stage`. */
  async function writtenWave(repo: string, states: string[], stage?: "reviewing" | "rejected" | "merged" | "waiting_approve" | "blocked", branch = "main-factory-w1"): Promise<TaskRecord[]> {
    await createWave({ id: WAVE, repo, tag: "factory/w1", plan: null, title: "w", request: "r", branch, target: "main", base: "abc", origin: null, createdAt: "2026-01-01T00:00:00.000Z", overrides: {} });
    await appendWaveEvent(WAVE, { kind: "tasks", tasks: states.map((_, index) => spec(String.fromCharCode(97 + index))) });
    const records: TaskRecord[] = [];
    for (const [index, state] of states.entries()) {
      const record = { ...fakeRecord([ID_1, ID_2, ID_3][index], repo), tag: "factory/w1", wave: WAVE };
      await writeTask(record);
      // "starting": no session file yet.
      if (state !== "starting") writeSession(record, [stateEntry(state)]);
      await appendWaveEvent(WAVE, { kind: "task", key: String.fromCharCode(97 + index), taskId: record.id, sessionId: record.sessionId });
      records.push(record);
    }
    if (stage) await appendWaveEvent(WAVE, { kind: "stage", stage, reason: stage === "blocked" ? "conflict" : null });
    return records;
  }

  /** A live stand-in of the wave's runner; resolves with the function that ends it. */
  async function fakeRunner(): Promise<() => Promise<void>> {
    const end = join(caseDir, "runner-end");
    const child = Bun.spawn(["bun", fakeWaveRunner, WAVE], { env: { ...process.env, FAKE_RUNNER_END: end } });
    await until(async () => (await liveWaveRunners(WAVE)).length === 1);
    return async () => {
      writeFileSync(end, "");
      await child.exited;
    };
  }

  test("by wave: not while it reviews with every task done; on merged, without attention", async () => {
    await writtenWave("/r", ["done", "done"], "reviewing");
    const stop = await fakeRunner();
    const busy = await wait({ wave: WAVE.slice(0, 8), timeoutMs: 1_500 });
    expect([busy.timedOut, busy.attention, busy.tasks.map((view) => view.id), busy.waves.map((wave) => [wave.id, wave.stage, wave.running])]).toEqual([
      true,
      [],
      [ID_1, ID_2],
      [[WAVE, "reviewing", true]],
    ]);
    setTimeout(() => void appendWaveEvent(WAVE, { kind: "stage", stage: "merged", reason: null }).then(stop), 300);
    const merged = await wait({ wave: WAVE, timeoutMs: 10_000 });
    expect([merged.timedOut, merged.attention, merged.waves[0].stage]).toEqual([false, [], "merged"]);
  });

  test("by wave: rejected is the wave's attention; by tag the wave is watched too", async () => {
    await writtenWave("/r", ["done"], "reviewing");
    const stop = await fakeRunner();
    setTimeout(() => void appendWaveEvent(WAVE, { kind: "stage", stage: "rejected", reason: null }).then(stop), 300);
    const rejected = await wait({ wave: WAVE, timeoutMs: 10_000 });
    expect([rejected.timedOut, rejected.attention, rejected.waves[0].stage]).toEqual([false, [WAVE], "rejected"]);
    const byTag = await wait({ tag: "factory", timeoutMs: 5_000 });
    expect([byTag.attention, byTag.waves.map((wave) => wave.id)]).toEqual([[WAVE], [WAVE]]);
    // An ignored wave is not watched.
    expect((await wait({ tag: "factory", ignore: [WAVE.slice(0, 8)] })).waves).toEqual([]);
  });

  test("by wave: a task's question needs attention while the wave builds; a cancelled task of it does not", async () => {
    const [, asking] = await writtenWave("/r", ["cancelled", "starting"]);
    const stop = await fakeRunner();
    const quiet = await wait({ wave: WAVE, timeoutMs: 1_000 });
    expect([quiet.timedOut, quiet.attention]).toEqual([true, []]);
    setTimeout(() => writeSession(asking, [stateEntry("waiting_answer")]), 300);
    const asked = await wait({ wave: WAVE, timeoutMs: 10_000 });
    expect([asked.timedOut, asked.attention, asked.waves[0].stage]).toEqual([false, [ID_2], "building"]);
    await stop();
    // Without its runner the building wave is interrupted: attention.
    expect((await wait({ wave: WAVE })).attention).toEqual([ID_2, WAVE]);
  });

  test("by wave: building with a task that can never start needs attention once no task runs, its runner alive or not", async () => {
    await writtenWave("/r", ["cancelled", "starting"]);
    await appendWaveEvent(WAVE, { kind: "tasks", tasks: [{ key: "c", title: "Task c", request: "do c", after: ["a"] }] });
    const stop = await fakeRunner();
    // b still runs: the wave may move on by itself.
    const quiet = await wait({ wave: WAVE, timeoutMs: 1_000 });
    expect([quiet.timedOut, quiet.attention]).toEqual([true, []]);
    writeSession((await listTasks())[1], [stateEntry("done")]);
    const stuck = await wait({ wave: WAVE, timeoutMs: 10_000 });
    expect([stuck.timedOut, stuck.attention, stuck.waves[0].stage, stuck.waves[0].running, stuck.waves[0].interrupted]).toEqual([false, [WAVE], "building", true, false]);
    await stop();
    const rested = await wait({ wave: WAVE, timeoutMs: 10_000 });
    expect([rested.attention, rested.waves[0].interrupted, rested.waves[0].actions]).toEqual([[WAVE], false, ["waves.add", "waves.cancel", "waves.remove"]]);
  });

  test("exactly one of ids, tag and wave", async () => {
    await writtenWave("/r", ["done"]);
    for (const params of [{}, { ids: [ID_1], wave: WAVE }, { tag: "factory", wave: WAVE }, { ids: [ID_1], tag: "factory", wave: WAVE }]) {
      await expectError(wait(params), "invalid", "tasks.wait needs exactly one of ids, tag and wave");
    }
    await expectError(wait({ wave: "ffffffff" }), "not_found", "no wave");
  });

  test("approve only from waiting_approve, retry only blocked or interrupted: refused otherwise; actions say so", async () => {
    await writtenWave("/r", ["done"], "rejected");
    expect((await getWave()).actions).toEqual(["waves.add", "waves.cancel", "waves.remove"]);
    await expectError(callAction("waves.approve", { id: WAVE }), "refused", "is rejected, approve needs waiting_approve");
    await expectError(callAction("waves.retry", { id: WAVE }), "refused", "is rejected, retry needs blocked or interrupted");
    await appendWaveEvent(WAVE, { kind: "stage", stage: "waiting_approve", reason: null });
    expect((await getWave()).actions).toEqual(["waves.add", "waves.approve", "waves.cancel", "waves.remove"]);
    await expectError(callAction("waves.retry", { id: WAVE }), "refused", "retry needs blocked or interrupted");
    await appendWaveEvent(WAVE, { kind: "stage", stage: "merged", reason: null });
    expect((await getWave()).actions).toEqual(["waves.remove"]);
    await expectError(callAction("waves.approve", { id: WAVE }), "refused", "is merged");
    await expectError(callAction("waves.cancel", { id: WAVE }), "refused", "is merged already");
  });

  test("a task of a wave past building is not continued (invariant 2): retry, a follow-up and approve refused, actions say so; its question is answered", async () => {
    const [cancelled, done, asking] = await writtenWave("/r", ["cancelled", "done", "waiting_answer"]);
    const actionsOf = async (record: TaskRecord) => ((await callAction("tasks.get", { id: record.id })) as TaskView).actions;
    // While the wave builds: as for any task.
    expect(await actionsOf(cancelled)).toEqual(["tasks.retry", "tasks.remove", "tasks.message"]);
    // A done task stays while its wave is neither merged nor cancelled (its own test below).
    expect(await actionsOf(done)).toEqual(["tasks.message"]);
    expect(await actionsOf(asking)).toEqual(["tasks.cancel", "tasks.message"]);
    for (const stage of ["reviewing", "waiting_approve", "merging", "rejected", "blocked", "merged", "cancelled"] as const) {
      await appendWaveEvent(WAVE, { kind: "stage", stage, reason: stage === "blocked" ? "gates" : null });
      expect(await actionsOf(cancelled)).toEqual(["tasks.remove"]);
      expect(await actionsOf(done)).toEqual(stage === "merged" || stage === "cancelled" ? ["tasks.remove"] : []);
      // The answer to a question continues the round it asked in: always allowed.
      expect(await actionsOf(asking)).toEqual(["tasks.cancel", "tasks.message"]);
      await expectError(callAction("tasks.retry", { id: cancelled.id }), "refused", `belongs to wave ${WAVE.slice(0, 8)}, which is ${stage}`);
      await expectError(callAction("tasks.message", { id: done.id, text: "one more thing" }), "refused", "give the work to the wave with waves.add");
    }
    writeSession(done, [stateEntry("waiting_approve")]);
    expect(await actionsOf(done)).toEqual(["tasks.cancel", "tasks.remove"]);
    await expectError(callAction("tasks.approve", { id: done.id }), "refused", "approve is refused; give the work to the wave with waves.add");
    // Nothing reached a runner.
    expect(prompts()).toEqual([]);
    // Building again (waves.add): the task actions are back.
    await appendWaveEvent(WAVE, { kind: "stage", stage: "building", reason: null });
    expect(await actionsOf(cancelled)).toEqual(["tasks.retry", "tasks.remove", "tasks.message"]);
    expect(await actionsOf(done)).toEqual(["tasks.approve", "tasks.cancel", "tasks.remove", "tasks.message"]);
  });

  test("tasks.remove refuses a done task while its wave is neither merged nor cancelled: removed, it would strand the tasks after it", async () => {
    const repo = makeRepo();
    const [done, cancelled] = await writtenWave(repo, ["done", "cancelled"]);
    const actionsOf = async (record: TaskRecord) => ((await callAction("tasks.get", { id: record.id })) as TaskView).actions;
    for (const stage of [null, "reviewing", "rejected", "blocked", "waiting_approve", "merging"] as const) {
      if (stage !== null) await appendWaveEvent(WAVE, { kind: "stage", stage, reason: stage === "blocked" ? "gates" : null });
      expect(await actionsOf(done)).not.toContain("tasks.remove");
      await expectError(callAction("tasks.remove", { id: done.id, force: true }), "refused", `is done in wave ${WAVE.slice(0, 8)}, which is ${stage ?? "building"}: the wave counts on it`);
    }
    // A cancelled task counts as cancelled either way; the wave itself is still removable with its done task.
    expect(await actionsOf(cancelled)).toContain("tasks.remove");
    expect((await getWave()).actions).toContain("waves.remove");
    expect(await callAction("tasks.remove", { id: cancelled.id })).toEqual({ removed: cancelled.id, dropped: null });
    await appendWaveEvent(WAVE, { kind: "stage", stage: "merged", reason: null });
    expect(await actionsOf(done)).toEqual(["tasks.remove"]);
    expect(await callAction("tasks.remove", { id: done.id })).toEqual({ removed: done.id, dropped: null });
    expect(await listTasks()).toEqual([]);
  });

  test("a task's merge is refused once its wave's review began, whatever started it, until the wave builds again", async () => {
    const [task] = await writtenWave("/r", ["running"]);
    // A factory task's session lies under the factory's home.
    const record = { ...task, sessionDir: join(caseDir, "agent", "factory", "sessions", "r") };
    await writeTask(record);
    const refusal = () => waveMergeRefusal(record.sessionDir, record.sessionId);
    expect(await refusal()).toBeNull();
    // A launch failed while it built: no review began, its running tasks still merge.
    await appendWaveEvent(WAVE, { kind: "stage", stage: "blocked", reason: "infra" });
    expect(await refusal()).toBeNull();
    await appendWaveEvent(WAVE, { kind: "stage", stage: "building", reason: null });
    for (const stage of ["reviewing", "blocked", "waiting_approve", "merging", "merged"] as const) {
      await appendWaveEvent(WAVE, { kind: "stage", stage, reason: stage === "blocked" ? "gates" : null });
      expect(await refusal()).toContain(`its wave ${WAVE.slice(0, 8)} is ${stage}, its review began: nothing more reaches its branch main-factory-w1`);
    }
    await appendWaveEvent(WAVE, { kind: "stage", stage: "building", reason: null });
    expect(await refusal()).toBeNull();
    await appendWaveEvent(WAVE, { kind: "stage", stage: "reviewing", reason: null });
    // A session outside the factory's home, a task outside a wave: never refused.
    expect(await waveMergeRefusal(task.sessionDir, task.sessionId)).toBeNull();
    await writeTask({ ...record, wave: null });
    expect(await refusal()).toBeNull();
  });

  test("taskWave: the wave of a factory task's session, null outside a wave or the factory's home", async () => {
    const [task] = await writtenWave("/r", ["running"]);
    const record = { ...task, sessionDir: join(caseDir, "agent", "factory", "sessions", "r") };
    await writeTask(record);
    expect(await taskWave(record.sessionDir, record.sessionId)).toBe(WAVE);
    expect(await taskWave(task.sessionDir, task.sessionId)).toBeNull();
    await writeTask({ ...record, wave: null });
    expect(await taskWave(record.sessionDir, record.sessionId)).toBeNull();
  });

  test("waves.cancel stops the wave's runner and its running tasks, the branch stays; then nothing moves", async () => {
    process.env.FAKE_PI_HOLD = "1";
    const repo = makeRepo();
    await callAction("repos.add", {}, { cwd: repo });
    const started = ((await callAction("waves.start", { tag: "factory/w1", title: "w", request: "r", tasks: [spec("a"), spec("b")] }, { cwd: repo })) as { wave: WaveView }).wave;
    await until(async () => (await getWave(started.id)).tasks.every((task) => task.taskId !== null));
    const records = (await listTasks()).filter((record) => record.wave === started.id);
    for (const record of records) await until(async () => (await stateOf(record)) === "running");
    expect((await getWave(started.id)).running).toBe(true);
    await expectError(callAction("waves.remove", { id: started.id }), "refused", "has a runner, cancel it first");
    const cancelled = ((await callAction("waves.cancel", { id: started.id })) as { wave: WaveView }).wave;
    expect([cancelled.stage, cancelled.running, cancelled.actions]).toEqual(["cancelled", false, ["waves.remove"]]);
    for (const record of records) {
      await until(async () => (await stateOf(record)) === "cancelled");
      await until(() => runnerEnded(record));
    }
    expect((await getWave(started.id)).tasks.map((task) => task.state)).toEqual(["cancelled", "cancelled"]);
    expect(git(repo, "branch", "--list", started.branch)).toBe(started.branch);
    await expectError(callAction("waves.cancel", { id: started.id }), "refused", "is cancelled already");
    await expectError(callAction("waves.add", { id: started.id, tasks: [spec("c")] }), "refused", "is cancelled");
    // The cancelled tasks' runners poke the wave: a runner that looks sees it rest and starts nothing.
    await until(async () => (await liveWaveRunners(started.id)).length === 0);
    expect((await listTasks()).filter((record) => record.wave === started.id)).toHaveLength(2);
    // Then remove: the tasks (no work of theirs), the record; the branch of a wave not merged stays.
    expect(await callAction("waves.remove", { id: started.id })).toEqual({ removed: started.id });
    expect((await listTasks()).filter((record) => record.wave === started.id)).toEqual([]);
    for (const record of records) expect(existsSync(record.worktree)).toBe(false);
    expect(existsSync(join(caseDir, "agent", "factory", "waves", `${started.id}.jsonl`))).toBe(false);
    expect(git(repo, "branch", "--list", started.branch)).toBe(started.branch);
    await expectError(callAction("waves.get", { id: started.id }), "not_found", "no wave");
  }, 60_000);

  test("waves.remove: refused for a waiting question and unmerged work without force; a merged wave's branch is deleted", async () => {
    const repo = makeRepo();
    git(repo, "branch", "main-factory-w1");
    const [a, b] = await writtenWave(repo, ["done", "waiting_answer"], "merged");
    for (const record of [a, b]) git(repo, "worktree", "add", "--quiet", "-b", record.branch, record.worktree, "main");
    await expectError(callAction("waves.remove", { id: WAVE, force: true }), "refused", "waits for the answer to its question");
    expect((await getWave()).actions).toEqual([]);
    writeSession(b, [stateEntry("cancelled")]);
    writeFileSync(join(a.worktree, "stray.txt"), "x\n");
    const refused = await failure(callAction("waves.remove", { id: WAVE }));
    expect([refused.code, refused.detail, refused.message]).toEqual(["refused", { force: true }, expect.stringContaining("give force: true")]);
    // Nothing was deleted by the refusal.
    expect([existsSync(a.worktree), existsSync(b.worktree), (await listTasks()).length, (await listWaves()).length]).toEqual([true, true, 2, 1]);
    expect(await callAction("waves.remove", { id: WAVE, force: true })).toEqual({ removed: WAVE });
    expect([existsSync(a.worktree), existsSync(b.worktree), await listTasks(), await listWaves()]).toEqual([false, false, [], []]);
    expect(git(repo, "branch", "--list", "main-factory-w1")).toBe("");
    expect(readdirSync(join(caseDir, "agent", "factory", "waves"))).toEqual([]);
  });

  test("waves.remove: a review worktree a block left is removed with the wave (a dirty one refused, named), then a merged wave's branch is deleted", async () => {
    const repo = makeRepo();
    git(repo, "branch", "main-factory-w1");
    const [a] = await writtenWave(repo, ["done"], "merged");
    git(repo, "worktree", "add", "--quiet", "-b", a.branch, a.worktree, "main");
    const review = waveReviewWorktree({ id: WAVE, repo });
    git(repo, "worktree", "add", "--quiet", review, "main-factory-w1");
    writeFileSync(join(review, "stray.txt"), "x\n");
    const refused = await failure(callAction("waves.remove", { id: WAVE }));
    expect([refused.code, refused.detail, refused.message]).toEqual(["refused", { force: true }, expect.stringContaining(`its review worktree ${review} holds uncommitted changes`)]);
    expect([existsSync(a.worktree), existsSync(review), (await listTasks()).length, (await listWaves()).length]).toEqual([true, true, 1, 1]);
    rmSync(join(review, "stray.txt"));
    expect(await callAction("waves.remove", { id: WAVE })).toEqual({ removed: WAVE });
    expect([existsSync(a.worktree), existsSync(review), git(repo, "branch", "--list", "main-factory-w1")]).toEqual([false, false, ""]);
  });
});

describe("liveRunners", () => {
  test("a one-letter session id matches no other runner, nor a wave's runner", async () => {
    const inbox = join(caseDir, "inbox");
    const env = { ...process.env, FAKE_INBOX: inbox, FAKE_RUNNER_END: inbox };
    const task = Bun.spawn(["bun", exitingRunner, join(caseDir, "a"), join(caseDir, "a-sessions"), "abc", "a b"], { env });
    const wave = Bun.spawn(["bun", fakeWaveRunner, "a"], { env });
    try {
      await until(async () => (await liveRunners({ sessionId: "abc" })).length === 1);
      expect(await liveRunners({ sessionId: "a" })).toEqual([]);
      expect(await liveRunners({ sessionId: "b" })).toEqual([]);
      expect(await liveRunners({ sessionId: "ab" })).toEqual([]);
      expect(await liveRunners({ sessionId: "abc" })).toEqual([task.pid]);
    } finally {
      writeFileSync(inbox, "");
      await Promise.all([task.exited, wave.exited]);
    }
  });
});
