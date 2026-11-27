import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messageTask, sendCommand } from "./launch.ts";
import { saveSettings } from "./settings.ts";
import { lockTask, taskLockPath, taskLogPath, unlockTask, type TaskRecord } from "./tasks.ts";

const savedEnv = { ...process.env };
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "factory-runner-test-")));
const RUNNER = join(import.meta.dir, "runner.ts");

/**
 * The fake `pi`: speaks the RPC lines the runner reads (prompt response, `agent_start`, `agent_settled`,
 * `entry_appended`), appends `factory-state` entries to `<session-dir>/<ts>_<session-id>.jsonl` and notes in
 * `$FAKE_PI_LOG` what happened, `eof <last state>` when its stdin closes.
 * A session file that exists already is appended to, as Pi does for a later command of the task.
 * FAKE_PI_MODE: `merge` (settled while merging, done later), `rest-before-settle` (blocked, settled later), `stubborn`
 * (ignores stdin EOF and SIGTERM), `approve` (answers with no run, merging, then done), `cancel` (cancelled, then the
 * answer), `retry` (answers, a run starts later and ends blocked again), `started` (the prompt went to the model:
 * disposition `started`, a run, no entry), `inbox` (a run that takes every follow-up prompt that comes in, noted as
 * `coder <text>`, until 1.5 s pass without one, then blocked), `plain` (as `inbox`, answered `started`).
 * FAKE_PI_EXIT_DELAY: ms between stdin EOF and the exit. Every stdin line after the prompt is noted as `stdin <line>`;
 * a later prompt is answered `queued` during a run, else `started`.
 */
const fakeBin = join(scratch, "bin");
mkdirSync(fakeBin);
writeFileSync(
  join(fakeBin, "pi"),
  `#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const log = process.env.FAKE_PI_LOG;
const mode = process.env.FAKE_PI_MODE ?? "merge";
const note = (text) => appendFileSync(log, text + "\\n");
writeFileSync(log + ".pid", String(process.pid));
writeFileSync(log + ".env", process.env.FACTORY_TASK_SESSION ?? "");
note("argv " + JSON.stringify(args));
note("cwd " + process.cwd());
if (mode === "stubborn") process.on("SIGTERM", () => note("sigterm ignored"));
const dir = args[args.indexOf("--session-dir") + 1];
const id = args[args.indexOf("--session-id") + 1];
mkdirSync(dir, { recursive: true });
const file = join(dir, "2026-01-01T00-00-00-000Z_" + id + ".jsonl");
if (!existsSync(file)) writeFileSync(file, JSON.stringify({ type: "session", version: 3, id, cwd: process.cwd() }) + "\\n");
let current = "none";
const state = (name) => {
  current = name;
  appendFileSync(file, JSON.stringify({ type: "custom", customType: "factory-state", data: { state: name, round: 1, reason: "r" } }) + "\\n");
  note("state " + name);
};
let agentRunning = false;
const emit = (record) => {
  if (record.type === "agent_start") agentRunning = true;
  if (record.type === "agent_settled") agentRunning = false;
  process.stdout.write(JSON.stringify(record) + "\\n");
};
const followUps = [];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let gotPrompt;
const prompt = new Promise((done) => (gotPrompt = done));
setInterval(() => {}, 1000);
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
        note("stdin " + line);
        const command = JSON.parse(line);
        if (command.type === "prompt") {
          emit({ id: command.id, type: "response", command: "prompt", success: true, data: { disposition: agentRunning ? "queued" : "started" } });
          followUps.push(command.message);
        }
      }
      first = false;
    }
  }
  note("eof " + current);
  if (process.env.FAKE_PI_EXIT_DELAY) await sleep(Number(process.env.FAKE_PI_EXIT_DELAY));
  if (mode !== "stubborn") process.exit(0);
})();
note("prompt " + (await prompt));
const answer = () => emit({ id: "1", type: "response", command: "prompt", success: true, data: { disposition: "handled" } });
if (mode === "approve") {
  answer();
  await sleep(300);
  state("merging");
  emit({ type: "entry_appended" });
  await sleep(300);
  state("done");
  emit({ type: "entry_appended" });
  await new Promise(() => {});
}
if (mode === "cancel") {
  state("cancelled");
  answer();
  await new Promise(() => {});
}
if (mode === "started") {
  emit({ id: "1", type: "response", command: "prompt", success: true, data: { disposition: "started" } });
  emit({ type: "agent_start" });
  await sleep(100);
  emit({ type: "agent_settled", aborted: false });
  await new Promise(() => {});
}
/** The run takes follow-ups until 1.5 s pass without one. */
const takeFollowUps = async () => {
  let quiet = 0;
  while (quiet < 15) {
    await sleep(100);
    if (followUps.length > 0) {
      note("coder " + followUps.shift());
      quiet = 0;
    } else quiet += 1;
  }
};
if (mode === "inbox" || mode === "plain") {
  if (mode === "plain") emit({ id: "1", type: "response", command: "prompt", success: true, data: { disposition: "started" } });
  else answer();
  emit({ type: "agent_start" });
  state("running");
  await takeFollowUps();
  state("blocked");
  note("settled");
  emit({ type: "agent_settled", aborted: false });
  await new Promise(() => {});
}
if (mode === "retry") {
  answer();
  await sleep(300);
  emit({ type: "agent_start" });
  state("running");
  await sleep(100);
  state("blocked");
  note("settled");
  emit({ type: "agent_settled", aborted: false });
  await new Promise(() => {});
}
answer();
emit({ type: "agent_start" });
state("running");
await sleep(100);
if (mode === "rest-before-settle") {
  state("blocked");
  emit({ type: "entry_appended" });
  await sleep(300);
  note("settled");
  emit({ type: "agent_settled", aborted: false });
} else {
  state("merging");
  note("settled");
  emit({ type: "agent_settled", aborted: false });
  await sleep(300);
  state("done");
  emit({ type: "entry_appended" });
}
`,
);
chmodSync(join(fakeBin, "pi"), 0o755);

let caseCount = 0;
function newCase() {
  const dir = join(scratch, `case-${++caseCount}`);
  const worktree = join(dir, "worktree");
  mkdirSync(worktree, { recursive: true });
  return { dir, worktree, sessionDir: join(dir, "sessions"), sessionId: `session-${caseCount}`, inbox: join(dir, "task.inbox"), log: join(dir, "fake-pi.log") };
}

function startRunner(c: ReturnType<typeof newCase>, mode: string, message = "/factory start {}") {
  return Bun.spawn(["bun", RUNNER, c.worktree, c.sessionDir, c.sessionId, c.inbox, message], {
    env: { ...process.env, PATH: `${fakeBin}:${savedEnv.PATH}`, FAKE_PI_LOG: c.log, FAKE_PI_MODE: mode },
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** A session file in which the task rests in `state`, as an earlier command left it. */
function restingIn(c: ReturnType<typeof newCase>, state: string) {
  mkdirSync(c.sessionDir, { recursive: true });
  const header = JSON.stringify({ type: "session", version: 3, id: c.sessionId, cwd: c.worktree });
  const entry = JSON.stringify({ type: "custom", customType: "factory-state", data: { state, round: 1, reason: "earlier" } });
  writeFileSync(join(c.sessionDir, `2026-01-01T00-00-00-000Z_${c.sessionId}.jsonl`), `${header}\n${entry}\n`);
}

function noted(c: ReturnType<typeof newCase>): string[] {
  return existsSync(c.log) ? readFileSync(c.log, "utf8").trim().split("\n") : [];
}

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(50);
  }
}

/** Whether process `pid` (this test's own) still exists. */
const alive = (pid: number) => existsSync(`/proc/${pid}`);

/** The task of case `c`, its runner's `pi` the fake one in `mode`, the factory's state under `c`. */
function taskOf(c: ReturnType<typeof newCase>, mode: string): TaskRecord {
  process.env.PI_CODING_AGENT_DIR = join(c.dir, "agent");
  process.env.PATH = `${fakeBin}:${savedEnv.PATH}`;
  process.env.FAKE_PI_LOG = c.log;
  process.env.FAKE_PI_MODE = mode;
  return {
    id: `00000000-0000-4000-8000-${String(caseCount).padStart(12, "0")}`,
    repo: c.dir,
    worktree: c.worktree,
    branch: "t",
    title: "t",
    sessionId: c.sessionId,
    sessionDir: c.sessionDir,
    createdAt: new Date().toISOString(),
    tag: "t",
    plan: null,
    wave: null,
    origin: null,
  };
}

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("runner", () => {
  test("stdin closes only once the task rests after agent_settled; the task's Pi is marked a task session", async () => {
    for (const [mode, message, resting, end] of [
      ["merge", "/factory start {}", null, ["state done", "eof done"]],
      ["rest-before-settle", "/factory start {}", null, ["settled", "eof blocked"]],
      ["approve", "/factory approve", "waiting_approve", ["state done", "eof done"]],
      ["cancel", "/factory cancel", "waiting_approve", ["state cancelled", "eof cancelled"]],
      ["retry", "/factory retry", "blocked", ["settled", "eof blocked"]],
    ] as const) {
      const c = newCase();
      if (resting !== null) restingIn(c, resting);
      expect(await startRunner(c, mode, message).exited, mode).toBe(0);
      expect(noted(c).slice(-2), mode).toEqual([...end]);
      // The factory tool in that Pi offers only the actions that change nothing (`tool.ts`).
      expect(readFileSync(`${c.log}.env`, "utf8")).toBe("1");
    }
  }, 30_000);

  test("a prompt pi did not handle as a command (no factory plugin): aborts, closes and exits 1", async () => {
    const c = newCase();
    const runner = startRunner(c, "started");
    expect(await runner.exited).toBe(1);
    expect(noted(c).slice(3)).toEqual(['stdin {"type":"abort"}', "eof none"]);
    expect(await new Response(runner.stderr).text()).toContain("disposition started");
  }, 15_000);

  test("an inbox line appended during the run: sent once as a follow-up, the runner ends after that run settles", async () => {
    const c = newCase();
    const runner = startRunner(c, "inbox");
    await until(() => noted(c).includes("state running"));
    appendFileSync(c.inbox, `${JSON.stringify({ text: "use tabs" })}\n`);
    expect(await runner.exited).toBe(0);
    const followUp = `stdin ${JSON.stringify({ id: "inbox-1", type: "prompt", message: "use tabs", streamingBehavior: "followUp" })}`;
    expect(noted(c).slice(3)).toEqual(["state running", followUp, "coder use tabs", "state blocked", "settled", "eof blocked"]);
    expect(readFileSync(`${c.inbox}.read`, "utf8").trim()).toBe(String(readFileSync(c.inbox).length));
  }, 15_000);

  test("an inbox line left after the runner ended: the next runner sends it, and only it", async () => {
    const c = newCase();
    const first = startRunner(c, "inbox");
    await until(() => noted(c).includes("state running"));
    appendFileSync(c.inbox, `${JSON.stringify({ text: "one" })}\n`);
    expect(await first.exited).toBe(0);
    appendFileSync(c.inbox, `${JSON.stringify({ text: "two" })}\n`);
    const next = { ...c, log: `${c.log}.next` };
    expect(await startRunner(next, "plain", "go on").exited).toBe(0);
    const stdin = noted(next).filter((line) => line.startsWith("stdin "));
    expect(stdin).toEqual([`stdin ${JSON.stringify({ id: "inbox-1", type: "prompt", message: "two", streamingBehavior: "followUp" })}`]);
    expect(noted(next).slice(3)).toEqual(["state running", stdin[0], "coder two", "state blocked", "settled", "eof blocked"]);
  }, 20_000);

  test("an inbox line that came after stdin closed: once pi exited at rest, a successor runner sends it and takes the lock", async () => {
    const c = newCase();
    const lock = join(c.dir, "task.lock");
    const runner = Bun.spawn(["bun", RUNNER, c.worktree, c.sessionDir, c.sessionId, c.inbox, "/factory start {}"], {
      env: { ...process.env, PATH: `${fakeBin}:${savedEnv.PATH}`, FAKE_PI_LOG: c.log, FAKE_PI_MODE: "merge", FAKE_PI_EXIT_DELAY: "1500", FACTORY_TASK_LOCK: lock },
    });
    writeFileSync(lock, `${runner.pid} 0\n`);
    await until(() => noted(c).includes("eof done"));
    appendFileSync(c.inbox, `${JSON.stringify({ text: "late" })}\n`);
    expect(await runner.exited).toBe(0);
    const prompt = `prompt ${JSON.stringify({ id: "1", type: "prompt", message: "late", streamingBehavior: "followUp" })}`;
    await until(() => noted(c).includes(prompt));
    const holder = Number(readFileSync(lock, "utf8").split(" ")[0]);
    expect(holder).not.toBe(runner.pid);
    expect(readFileSync(`${c.inbox}.read`, "utf8").trim()).toBe(String(readFileSync(c.inbox).length));
    // The last runner removes the lock as it exits.
    await until(() => !existsSync(lock), 15_000);
    expect(noted(c).filter((line) => line.startsWith("eof "))).toEqual(["eof done", "eof done"]);
  }, 30_000);

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    test(`${signal}: closes stdin, kills a pi that does not end, leaves no pi behind`, async () => {
      const c = newCase();
      const runner = startRunner(c, "stubborn");
      await until(() => noted(c).includes("state running"));
      const piPid = Number(readFileSync(`${c.log}.pid`, "utf8"));
      expect(alive(piPid)).toBe(true);
      runner.kill(signal);
      expect(await runner.exited).not.toBe(0);
      expect(noted(c)).toContain("eof running");
      await until(() => !alive(piPid), 2000);
    }, 15_000);
  }
});

describe("sendCommand", () => {
  test("starts the runner detached, its output in the task's log, hands it the task lock, and it ends with the task", async () => {
    const c = newCase();
    const record = taskOf(c, "merge");
    await lockTask(record.id);
    await sendCommand(record, "/factory approve");
    expect(existsSync(taskLogPath(record.id))).toBe(true);
    expect(readFileSync(taskLockPath(record.id), "utf8")).not.toStartWith(`${process.pid} `);
    await until(() => noted(c).includes("eof done"));
    expect(noted(c)[2]).toBe(`prompt ${JSON.stringify({ id: "1", type: "prompt", message: "/factory approve" })}`);
    await until(() => !existsSync(taskLockPath(record.id)));
  }, 15_000);

  test("the coder's Pi loads every user extension, or with the repository's `extensions` only the factory's plugin and those", async () => {
    const plugin = join(import.meta.dir, "pi", "index.ts");
    for (const [extensions, sources] of [
      [undefined, null],
      [[], [plugin]],
      [["npm:pi-lens", "builtin:codemode"], [plugin, "npm:pi-lens", "builtin:codemode"]],
    ] as const) {
      const c = newCase();
      const record = taskOf(c, "merge");
      await saveSettings(record.repo, extensions === undefined ? {} : { extensions: [...extensions] });
      await lockTask(record.id);
      await sendCommand(record, "/factory approve");
      await until(() => noted(c).includes("eof done"));
      const args: string[] = JSON.parse(noted(c)[0].slice("argv ".length));
      expect(args.includes("-ne") ? args.filter((_, index) => args[index - 1] === "-e") : null, JSON.stringify(extensions)).toEqual(sources === null ? null : [...sources]);
      await until(() => !existsSync(taskLockPath(record.id)));
    }
    expect(existsSync(plugin)).toBe(true);
  }, 30_000);
});

describe("messageTask", () => {
  test("a task whose lock another holds: refused as busy, no runner", async () => {
    const c = newCase();
    restingIn(c, "blocked");
    const record = taskOf(c, "plain");
    await lockTask(record.id);
    await expect(messageTask(record, "hi")).rejects.toThrow(`task ${record.id.slice(0, 8)} is busy`);
    expect(existsSync(c.log)).toBe(false);
    await unlockTask(record.id);
  });

});
