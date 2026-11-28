/**
 * What the tests that run the factory's processes share: real git repos in a temp dir and one fake `pi` (never a
 * model, never the real `agent-worktree`).
 *
 * - `useCoreFixture()`, called once at the top of a test file: its own scratch dir with the fake `pi` and runner
 *   stand-ins, a fresh case dir (`caseDir`) and environment per test, every runner stopped after each, the scratch dir
 *   removed after the file
 * - The helpers read the fixture of the file running (`caseDir`, `$FAKE_PI_LOG`): call them only inside its tests
 * - `caseTests`: a `test` whose body runs in a scope of its own, so an id built from `caseSerial()` stays the test's
 *   even when the body outlives its timeout and the next test has started
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeEach, expect, test as bunTest } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callAction, FactoryError, type TaskView } from "./core.ts";
import { liveRunners, stopRunners } from "./launch.ts";
import { lastFactoryState } from "./runner.ts";
import { handLockFile, lockFile } from "./lock.ts";
import { listTasks, type TaskRecord } from "./tasks.ts";
import { stopWaveRunners } from "./wave-poke.ts";
import { listWaves } from "./waves.ts";

/**
 * The fake `pi`, by its `--mode`. Each note goes to `$FAKE_PI_LOG` as `<kind> <json>` (`noted`): its `argv`, `env`
 * (`FACTORY_TASK_SESSION`, `FACTORY_TEST_SECRET`), `pid`. `FAKE_PI_EXIT=1`: it exits at once, as a broken Pi does.
 * - `rpc` (a task's Pi): notes the `prompt`, every later stdin line (`stdin`), each `state`, `settled`, a follow-up its
 *   run took (`coder`) and `eof <last state>` when its stdin closes; then plays the steps of `$FAKE_PI_SCRIPT` (JSON),
 *   else those of the command. A step: `answer[:disposition]`, `run`, `settle`, `appended`, `wait` (100 ms), `hold`,
 *   `followup` (waits for one), `stubborn` (ignores stdin EOF and SIGTERM), `task` (the `factory-task` entry of a
 *   start), `fix` (a file changed in the worktree), else `<state>[:reason]`. `FAKE_PI_HOLD=1`: a start runs forever;
 *   `FAKE_PI_START_END`: the state a start rests in (default `waiting_approve`)
 * - `json` with `map_write` (a scout's child): loads its extension, writes `$FAKE_SCOUT.writes`, then holds (`hold`)
 *   or ends with `report`; each assistant message costs `$FAKE_SCOUT.cost`
 * - `json` else (a reviewer): notes `reviewing <key>`, sleeps `$FAKE_REVIEW_SLEEP` ms, answers the next of the
 *   verdicts in `$FAKE_VERDICT_<key>` (`approve`, `reject`; the last one repeats) and notes the call (`reviewed`)
 */
const FAKE_PI = `#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const env = process.env;
if (env.FAKE_PI_EXIT === "1") process.exit(1);
// Never outlives its test: it ends once the test's home (the dir of its log) is gone. This also keeps it alive.
setInterval(() => existsSync(dirname(env.FAKE_PI_LOG)) || process.exit(0), 200);
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const note = (kind, value) => appendFileSync(env.FAKE_PI_LOG, kind + " " + JSON.stringify(value) + "\\n");
const noted = (kind) => readFileSync(env.FAKE_PI_LOG, "utf8").split("\\n").filter((line) => line.startsWith(kind + " ")).map((line) => JSON.parse(line.slice(kind.length + 1)));
const emit = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const forever = () => new Promise(() => {});
const usage = (cost) => ({ input: 100, output: 10, cacheRead: 5, cacheWrite: 1, cost: { total: cost } });
note("argv", args);
note("env", { taskSession: env.FACTORY_TASK_SESSION, secret: env.FACTORY_TEST_SECRET });
note("pid", process.pid);
const id = option("--session-id") ?? "11111111-2222-4333-8444-555555555555";
const dir = option("--session-dir");
mkdirSync(dir, { recursive: true });
const file = join(dir, readdirSync(dir).find((name) => name.endsWith("_" + id + ".jsonl")) ?? "2026-01-01T00-00-00-000Z_" + id + ".jsonl");
if (!existsSync(file)) writeFileSync(file, JSON.stringify({ type: "session", version: 3, id, cwd: process.cwd() }) + "\\n");

if (option("--mode") === "json" && option("--tools").includes("map_write")) {
  const tools = {};
  (await import(option("-e"))).default({ registerTool: (tool) => (tools[tool.name] = tool) });
  const plan = JSON.parse(env.FAKE_SCOUT ?? "{}");
  const message = (text) => emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage: usage(plan.cost ?? 0.25) } });
  for (const write of plan.writes ?? []) {
    await tools.map_write.execute("call", write);
    message("");
  }
  if (plan.hold) {
    message("");
    await forever();
  }
  message(plan.report ?? "MISSING\\n1. nothing\\n\\nDECISIONS\\n- none\\n\\nKEY FACTS\\n- a.txt:1 holds a\\n\\nMEMORY\\n- none");
  process.exit(0);
}

if (option("--mode") === "json") {
  const prompt = args.at(-1);
  const key = (/Review task (\\S+)/.exec(prompt) ?? [, "wave"])[1];
  note("reviewing", key);
  const start = Date.now();
  if (env.FAKE_REVIEW_SLEEP) await sleep(Number(env.FAKE_REVIEW_SLEEP));
  const verdicts = (env["FAKE_VERDICT_" + key] ?? "approve").split(" ");
  const verdict = verdicts[Math.min(noted("reviewed").filter((call) => call.key === key).length, verdicts.length - 1)];
  const findings = verdict === "reject" ? [{ file: "x.txt", line: 1, severity: "major", text: "x is wrong" }, { file: "x.txt", line: null, severity: "minor", text: "style" }] : [];
  note("reviewed", { key, prompt, tools: option("--tools"), diff: env.FACTORY_REVIEW_DIFF ? readFileSync(env.FACTORY_REVIEW_DIFF, "utf8") : null, start, end: Date.now() });
  emit({ type: "session", id });
  emit({ type: "tool_execution_end", toolName: "submit_verdict", isError: false, result: { details: { findings } } });
  emit({ type: "message_end", message: { role: "assistant", usage: usage(0.5) } });
  process.exit(0);
}

let current = "none";
let round = 1;
let running = false;
let stubborn = false;
const followUps = [];
const state = (name, reason = "r") => {
  current = name;
  appendFileSync(file, JSON.stringify({ type: "custom", customType: "factory-state", timestamp: new Date().toISOString(), data: { state: name, round, reason } }) + "\\n");
  note("state", name);
};
const lastState = () => readFileSync(file, "utf8").trim().split("\\n").map((line) => JSON.parse(line)).filter((entry) => entry.customType === "factory-state").at(-1)?.data.state;
let gotPrompt;
const prompt = new Promise((done) => (gotPrompt = done));
// Stdin closed: it ends (a stubborn one only once its home is gone), whatever a note on the way throws.
(async () => {
  let buffer = "";
  let first = true;
  for await (const chunk of Bun.stdin.stream()) {
    buffer += new TextDecoder().decode(chunk);
    let newline;
    while ((newline = buffer.indexOf("\\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (first) gotPrompt(line);
      else {
        note("stdin", JSON.parse(line));
        const command = JSON.parse(line);
        if (command.type === "prompt") {
          emit({ id: command.id, type: "response", command: "prompt", success: true, data: { disposition: running ? "queued" : "started" } });
          followUps.push(command.message);
        }
      }
      first = false;
    }
  }
  note("eof", current);
})().finally(() => stubborn || process.exit(0));
const message = JSON.parse(await prompt).message;
note("prompt", message);
const reviewed = message.startsWith("/factory reviewed ") ? JSON.parse(message.slice("/factory reviewed ".length)) : null;
const merge = ["answer", "wait", "merging:approved", "appended", "wait", "done:merged", "appended"];
const scripts = {
  start: env.FAKE_PI_HOLD === "1" ? ["task", "running:start", "answer", "run", "hold"] : ["task", "running:start", "answer", "run", "wait", (env.FAKE_PI_START_END ?? "waiting_approve") + ":passed", "settle"],
  approve: merge,
  retry: ["answer", "wait", "run", "running:retry", "wait", "blocked:gates", "settle"],
  cancel: [...(lastState() === "running" ? ["blocked:interrupted"] : []), "cancelled:cancelled", "answer"],
  reviewed: reviewed?.review.approved ? merge : ["answer", "run", "running", "fix", "reviewing", "settle"],
};
if (reviewed !== null && !reviewed.review.approved) round = reviewed.round + 1;
const script = env.FAKE_PI_SCRIPT ? JSON.parse(env.FAKE_PI_SCRIPT) : message.startsWith("/factory ") ? (scripts[message.split(" ")[1]] ?? []) : ["answer:started", "run", "running", "followup", "blocked", "settle"];
for (const step of script) {
  const [name, detail] = step.split(":");
  if (name === "answer") emit({ id: "1", type: "response", command: "prompt", success: true, data: { disposition: detail ?? "handled" } });
  else if (name === "run") {
    running = true;
    emit({ type: "agent_start" });
  } else if (name === "settle") {
    running = false;
    note("settled", true);
    emit({ type: "agent_settled", aborted: false });
  } else if (name === "appended") emit({ type: "entry_appended" });
  else if (name === "wait") await sleep(100);
  else if (name === "hold") await forever();
  else if (name === "followup") {
    while (followUps.length === 0) await sleep(20);
    note("coder", followUps.shift());
  } else if (name === "stubborn") {
    stubborn = true;
    process.on("SIGTERM", () => note("sigterm", "ignored"));
  } else if (name === "task") appendFileSync(file, JSON.stringify({ type: "custom", customType: "factory-task", data: { mainBranch: "main", settings: JSON.parse(message.slice("/factory start ".length)).settings } }) + "\\n");
  else if (name === "fix") writeFileSync("fix.txt", "fixed in round " + round + "\\n");
  else state(name, detail);
}
await forever();
`;

/** Writes the fake `pi` into `bin` (put it first on PATH). */
export function writeFakePi(bin: string): void {
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "pi"), FAKE_PI);
  chmodSync(join(bin, "pi"), 0o755);
}

/** What the fake `pi`s of this test noted of `kind`, oldest first. */
export function noted<T = unknown>(kind: string): T[] {
  const log = process.env.FAKE_PI_LOG as string;
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.startsWith(`${kind} `))
    .map((line) => JSON.parse(line.slice(kind.length + 1)) as T);
}

/** The prompts the task's Pis got, oldest first. */
export const prompts = (): string[] => noted<string>("prompt");

const scope = new AsyncLocalStorage<number>();
let serial = 0;

/** The running test's serial, 1 and up; 0 outside a `caseTests` body. */
export const caseSerial = (): number => scope.getStore() ?? 0;

/** `n` as the last group of an id: 12 digits. */
export const caseDigits = (n = caseSerial()): string => String(n).padStart(12, "0");

/** A `test` whose body (after `setup`, when given) runs in a scope of its own. */
export function caseTests(setup?: () => void | Promise<void>): (name: string, body: () => unknown, timeoutMs?: number) => void {
  return (name, body, timeoutMs) =>
    bunTest(
      name,
      () =>
        scope.run(++serial, async () => {
          await setup?.();
          return body();
        }),
      timeoutMs,
    );
}

/** The git identity and config every fixture runs git with. */
export const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "test",
  GIT_COMMITTER_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

export let scratch: string;
/** A runner stand-in (`runnerHolding`); it exits once `$FAKE_RUNNER_END` exists. */
let fakeRunner: string;
/** A PATH with the fake `pi` and without any directory that holds `agent-worktree`. */
export let testPath: string;
export let caseDir: string;
let caseCount = 0;

/** Sets up the test file's fixture and registers its hooks; call once at the top of the file. */
export function useCoreFixture(): void {
  const savedEnv = { ...process.env };
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "factory-core-test-")));
  caseCount = 0;
  writeFakePi(join(scratch, "bin"));
  mkdirSync(join(scratch, "fake-runner"));
  fakeRunner = join(scratch, "fake-runner", "runner.ts");
  writeFileSync(
    fakeRunner,
    `import { existsSync } from "node:fs";
import { dirname } from "node:path";
// Ends at its marker, or once the test's home is gone.
while (!existsSync(process.env.FAKE_RUNNER_END) && existsSync(dirname(process.env.FAKE_RUNNER_END))) await Bun.sleep(20);
process.exit(0);
`,
  );

  testPath = [join(scratch, "bin"), ...(savedEnv.PATH ?? "").split(":").filter((dir) => dir !== "" && !existsSync(join(dir, "agent-worktree")))].join(":");

  beforeEach(() => {
    caseDir = join(scratch, `case-${++caseCount}`);
    mkdirSync(caseDir);
    Object.assign(process.env, { PATH: testPath, HOME: scratch, PI_CODING_AGENT_DIR: join(caseDir, "agent"), FAKE_PI_LOG: join(caseDir, "fake-pi.log"), ...GIT_ENV });
    // Starting a task needs a factory models list; a test that wants none removes it.
    mkdirSync(join(caseDir, "agent", "factory"), { recursive: true });
    // Without the models of defaults.yaml: a task without models of its own runs with Pi's session model.
    writeFileSync(join(caseDir, "agent", "factory", "models.yaml"), "- a/b\n- c/d\n");
  });

  afterEach(async () => {
    // Wave runners first: they would start tasks while the tasks' runners stop.
    for (const wave of await listWaves()) await stopWaveRunners(wave.declaration.id);
    for (const record of await listTasks()) await stopRunners(record);
    restoreEnv(savedEnv);
  });

  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
}

/** Sets the environment back to `saved`: a variable set since is removed. */
export function restoreEnv(saved: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
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
    await Bun.sleep(20);
  }
}

export const stateOf = async (record: TaskRecord) => (await lastFactoryState(record.sessionDir, record.sessionId))?.state;
/**
 * Starts a runner stand-in with `id` among its arguments and hands it the `lock`, as a poke or `sendCommand` does:
 * `liveWaveRunners` or `liveRunners` finds it. It ends once `$FAKE_RUNNER_END` exists, sending nothing.
 */
export async function runnerHolding(lock: string, id: string, env: Record<string, string | undefined>): Promise<Bun.Subprocess> {
  await lockFile(lock, "a runner holds it");
  const child = Bun.spawn(["bun", fakeRunner, id], { env });
  await handLockFile(lock, child.pid);
  return child;
}

export const runnerEnded = async (record: TaskRecord) => (await liveRunners(record)).length === 0;

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

export async function expectError(promise: Promise<unknown>, code: FactoryError["code"]): Promise<void> {
  expect((await failure(promise)).code).toBe(code);
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

/** A session's first entry, as the plugin writes it: a state needs a task. */
export const TASK_ENTRY = { type: "custom", customType: "factory-task", timestamp: "2026-01-01T00:00:00.000Z", data: { mainBranch: "main", settings: { branch: "main", merge: "auto", maxRounds: 2, review: true, models: {} } } };

export function writeSession(record: TaskRecord, entries: object[]): string {
  mkdirSync(record.sessionDir, { recursive: true });
  const path = join(record.sessionDir, `2026-01-01T00-00-00-000Z_${record.sessionId}.jsonl`);
  writeFileSync(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  return path;
}
