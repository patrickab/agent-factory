/**
 * What the core's tests (`core*.test.ts`) share: real git repos in a temp dir and a fake `pi` on PATH (never a model,
 * never the real `agent-worktree`). The fake answers each `/factory` command with the entries the plugin would write.
 *
 * - `useCoreFixture()`, called once at the top of a test file: its own scratch dir with the fake `pi` and runner
 *   stand-ins, a fresh case dir (`caseDir`) and environment per test, every runner stopped after each, the scratch dir
 *   removed after the file
 * - The helpers read the fixture of the file running (`caseDir`, `piLog`): call them only inside its tests
 */
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeEach, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callAction, FactoryError, type TaskView } from "./core.ts";
import { liveRunners, stopRunners } from "./launch.ts";
import { lastFactoryState } from "./runner.ts";
import { listTasks, type TaskRecord } from "./tasks.ts";
import { liveWaveRunners, runnerSnapshot, stopWaveRunners } from "./wave-poke.ts";
import { listWaves } from "./waves.ts";

let savedEnv: NodeJS.ProcessEnv;
export let scratch: string;
export let fakeBin: string;
let piLog: string;
/** A runner stand-in `pgrep` finds as the task's runner; it exits as soon as the task's inbox file appears. */
export let exitingRunner: string;
/** A wave runner stand-in `liveWaveRunners` finds (`wave-runner.ts <id>`); it exits once `$FAKE_RUNNER_END` exists. */
export let fakeWaveRunner: string;
/** A PATH with the fake `pi` and without any directory that holds `agent-worktree`. */
export let testPath: string;
export let caseDir: string;
let caseCount = 0;

/** Sets up the test file's fixture and registers its hooks; call once at the top of the file. */
export function useCoreFixture(): void {
  savedEnv = { ...process.env };
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "factory-core-test-")));
  fakeBin = join(scratch, "bin");
  piLog = join(scratch, "fake-pi.log");
  caseCount = 0;

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
if (process.env.FAKE_PI_MESSAGE_LOG) appendFileSync(process.env.FAKE_PI_MESSAGE_LOG, JSON.stringify(message) + "\\n");
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

  exitingRunner = join(scratch, "fake-runner", "runner.ts");
  mkdirSync(join(scratch, "fake-runner"));
  writeFileSync(
    exitingRunner,
    `import { existsSync } from "node:fs";
const inbox = process.env.FAKE_INBOX;
while (!existsSync(inbox)) await Bun.sleep(1);
process.exit(0);
`,
  );

  fakeWaveRunner = join(scratch, "fake-runner", "wave-runner.ts");
  writeFileSync(
    fakeWaveRunner,
    `import { existsSync } from "node:fs";
while (!existsSync(process.env.FAKE_RUNNER_END)) await Bun.sleep(20);
process.exit(0);
`,
  );

  testPath = [fakeBin, ...(savedEnv.PATH ?? "").split(":").filter((dir) => dir !== "" && !existsSync(join(dir, "agent-worktree")))].join(":");

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

  afterEach(async () => {
    // Wave runners first: they would start tasks while the tasks' runners stop.
    // Only those with a live runner: a search per wave and task would cost seconds in a case with many.
    const waveRunners = await runnerSnapshot();
    for (const wave of await listWaves()) if ((await liveWaveRunners(wave.declaration.id, waveRunners)).length > 0) await stopWaveRunners(wave.declaration.id);
    const taskRunners = await runnerSnapshot();
    for (const record of await listTasks()) if ((await liveRunners(record, taskRunners)).length > 0) await stopRunners(record);
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
}

export function modelsFile(): string {
  return join(caseDir, "agent", "factory", "models.yaml");
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A repo on `main` with one commit, `factory.yaml` in it unless `withConfig` is false. */
export function makeRepo(withConfig = true, name = "repo"): string {
  const repo = join(caseDir, name);
  mkdirSync(repo);
  git(repo, "init", "--quiet", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  if (withConfig) writeFileSync(join(repo, "factory.yaml"), "gates: []\n");
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "init");
  return repo;
}

export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(50);
  }
}

export const stateOf = async (record: TaskRecord) => (await lastFactoryState(record.sessionDir, record.sessionId))?.state;
export const runnerEnded = async (record: TaskRecord) => (await liveRunners(record)).length === 0;
export const prompts = () => (existsSync(piLog) ? readFileSync(piLog, "utf8").trim().split("\n") : []);

/** The record of a started task. */
export async function recordOf(view: TaskView): Promise<TaskRecord> {
  const record = (await listTasks()).find((task) => task.id === view.id);
  if (!record) throw new Error(`no record ${view.id}`);
  return record;
}

export async function startTask(repo: string, title = "Add b"): Promise<TaskRecord> {
  return recordOf((await callAction("tasks.start", { title, request: "add b.txt" }, { cwd: repo })) as TaskView);
}

/** Starts a task and waits for its runner to leave it at `state`. */
export async function restingTask(repo: string, state: "waiting_approve" | "blocked"): Promise<TaskRecord> {
  if (state === "blocked") process.env.FAKE_PI_START_END = "blocked";
  const record = await startTask(repo);
  await until(async () => (await stateOf(record)) === state);
  await until(() => runnerEnded(record));
  return record;
}

/** The `FactoryError` `promise` rejects with. */
export async function failure(promise: Promise<unknown>): Promise<FactoryError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof FactoryError)) throw new Error(`expected a FactoryError, got ${String(error)}`);
  return error;
}

export async function expectError(promise: Promise<unknown>, code: FactoryError["code"], message: string): Promise<void> {
  const error = await failure(promise);
  expect(error.code).toBe(code);
  expect(error.message).toContain(message);
}

/** Part of every fixed id and session id here: a concurrent test run (another worktree) never matches these runners. */
export const RUN = randomBytes(2).toString("hex");
export const ID_1 = `abc10000-${RUN}-4000-8000-000000000001`;
export const ID_2 = `abc20000-${RUN}-4000-8000-000000000002`;
export const ID_3 = `abc30000-${RUN}-4000-8000-000000000003`;

export function fakeRecord(id: string, repo: string): TaskRecord {
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

export function writeSession(record: TaskRecord, entries: object[]): string {
  mkdirSync(record.sessionDir, { recursive: true });
  const path = join(record.sessionDir, `2026-01-01T00-00-00-000Z_${record.sessionId}.jsonl`);
  writeFileSync(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  return path;
}
