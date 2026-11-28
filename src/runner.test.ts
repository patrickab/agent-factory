import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { caseDir, fakeRecord, ID_1, ID_2, ID_3, noted, until, useCoreFixture } from "./core-test-kit.ts";
import { sendCommand } from "./launch.ts";
import { saveSettings } from "./settings.ts";
import { lockTask, taskLockPath, taskLogPath, type TaskRecord } from "./tasks.ts";

useCoreFixture();

const RUNNER = join(import.meta.dir, "runner.ts");

/** The task of this test: its worktree made, its session dir and inbox under the case dir. */
function task(id = ID_1): TaskRecord & { inbox: string } {
  const record = fakeRecord(id, caseDir);
  mkdirSync(record.worktree, { recursive: true });
  return { ...record, inbox: join(caseDir, `${id}.inbox`) };
}

/** A runner for `message`, its fake `pi` playing `script` (null: the command's own steps). */
function startRunner(c: ReturnType<typeof task>, script: string[] | null, message = "/factory start {}") {
  const env = { ...process.env, FAKE_PI_SCRIPT: script === null ? undefined : JSON.stringify(script) };
  return Bun.spawn(["bun", RUNNER, c.worktree, c.sessionDir, c.sessionId, c.inbox, message], { env, stdout: "pipe", stderr: "pipe" });
}

/** A session file in which the task rests in `state`, as an earlier command left it. */
function restingIn(c: ReturnType<typeof task>, state: string) {
  mkdirSync(c.sessionDir, { recursive: true });
  const header = JSON.stringify({ type: "session", version: 3, id: c.sessionId, cwd: c.worktree });
  const entry = JSON.stringify({ type: "custom", customType: "factory-state", timestamp: "2026-01-01T00:00:00.000Z", data: { state, round: 1, reason: "earlier" } });
  writeFileSync(join(c.sessionDir, `2026-01-01T00-00-00-000Z_${c.sessionId}.jsonl`), `${header}\n${entry}\n`);
}

const STUBBORN = ["stubborn", "answer", "run", "running", "hold"];

/** Whether process `pid` (this test's own) still exists. */
const alive = (pid: number) => existsSync(`/proc/${pid}`);

describe("runner", () => {
  test("stdin closes only once the task rests after agent_settled; the task's Pi is marked a task session", async () => {
    // The fake exits on EOF: a run it noted as settled was settled before stdin closed.
    for (const [n, script, message, resting, eof, settles] of [
      // Settled while merging, done later.
      [1, ["answer", "run", "running", "wait", "merging", "settle", "wait", "done", "appended"], "/factory start {}", null, "done", true],
      // Rests blocked, settled later.
      [2, ["answer", "run", "running", "wait", "blocked", "appended", "wait", "settle"], "/factory start {}", null, "blocked", true],
      [3, null, "/factory approve", "waiting_approve", "done", false],
      [4, null, "/factory cancel", "waiting_approve", "cancelled", false],
      [5, null, "/factory retry", "blocked", "blocked", true],
    ] as const) {
      const c = task(`${ID_1.slice(0, -1)}${n}`);
      if (resting !== null) restingIn(c, resting);
      const before = noted("settled").length;
      expect(await startRunner(c, script === null ? null : [...script], message).exited, message).toBe(0);
      expect([noted("eof").at(-1), noted("settled").length > before], message).toEqual([eof, settles]);
      // The factory tool in that Pi offers only the actions that change nothing (`tool.ts`).
      expect(noted<{ taskSession?: string }>("env").at(-1)?.taskSession).toBe("1");
    }
  }, 30_000);

  test("a prompt pi did not handle as a command (no factory plugin): aborts, closes and exits 1", async () => {
    const c = task();
    expect(await startRunner(c, ["answer:started", "run", "settle"]).exited).toBe(1);
    expect([noted("stdin"), noted("eof")]).toEqual([[{ type: "abort" }], ["none"]]);
  }, 15_000);

  test("an inbox line appended during the run: sent once as a follow-up, the runner ends after that run settles", async () => {
    const c = task();
    const runner = startRunner(c, null, "go on");
    await until(() => noted("state").includes("running"));
    appendFileSync(c.inbox, `${JSON.stringify({ text: "use tabs" })}\n`);
    expect(await runner.exited).toBe(0);
    expect([noted("coder"), noted("eof")]).toEqual([["use tabs"], ["blocked"]]);
    expect(readFileSync(`${c.inbox}.read`, "utf8").trim()).toBe(String(readFileSync(c.inbox).length));
  }, 15_000);

  test("an inbox line left after the runner ended: the next runner sends it, and only it", async () => {
    const c = task();
    const first = startRunner(c, null, "go on");
    await until(() => noted("state").includes("running"));
    appendFileSync(c.inbox, `${JSON.stringify({ text: "one" })}\n`);
    expect(await first.exited).toBe(0);
    appendFileSync(c.inbox, `${JSON.stringify({ text: "two" })}\n`);
    expect(await startRunner(c, null, "go on").exited).toBe(0);
    expect([noted("coder"), noted("eof")]).toEqual([["one", "two"], ["blocked", "blocked"]]);
  }, 20_000);

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    test(`${signal}: closes stdin, kills a pi that does not end, leaves no pi behind`, async () => {
      const runner = startRunner(task(), STUBBORN);
      await until(() => noted("state").includes("running"));
      const [piPid] = noted<number>("pid");
      expect(alive(piPid)).toBe(true);
      runner.kill(signal);
      expect(await runner.exited).not.toBe(0);
      expect(noted("eof")).toEqual(["running"]);
      await until(() => !alive(piPid), 2000);
    }, 15_000);
  }
});

describe("sendCommand", () => {
  test("starts the runner detached, its output in the task's log, hands it the task lock, and it ends with the task", async () => {
    const record = task();
    restingIn(record, "waiting_approve");
    await lockTask(record.id);
    await sendCommand(record, "/factory approve");
    expect(existsSync(taskLogPath(record.id))).toBe(true);
    expect(readFileSync(taskLockPath(record.id), "utf8")).not.toStartWith(`${process.pid} `);
    await until(() => noted("eof").includes("done"));
    expect(noted("prompt")).toEqual(["/factory approve"]);
    await until(() => !existsSync(taskLockPath(record.id)));
  }, 15_000);

  test("the coder's Pi loads every user extension, or with the repository's `extensions` only the factory's plugin and those", async () => {
    const plugin = join(import.meta.dir, "pi", "index.ts");
    for (const [id, extensions, sources] of [
      [ID_1, undefined, null],
      [ID_2, [], [plugin]],
      [ID_3, ["npm:pi-lens", "builtin:codemode"], [plugin, "npm:pi-lens", "builtin:codemode"]],
    ] as const) {
      const record = task(id);
      restingIn(record, "waiting_approve");
      await saveSettings(record.repo, extensions === undefined ? {} : { extensions: [...extensions] });
      await lockTask(record.id);
      await sendCommand(record, "/factory approve");
      await until(() => !existsSync(taskLockPath(record.id)));
      const args = noted<string[]>("argv").at(-1) as string[];
      expect(args.includes("-ne") ? new Set(args.filter((_, index) => args[index - 1] === "-e")) : null, JSON.stringify(extensions)).toEqual(sources === null ? null : new Set(sources));
      for (const flag of ["--no-skills", "--no-prompt-templates", "--no-themes"]) expect(args.includes(flag), `${flag} ${JSON.stringify(extensions)}`).toBe(sources !== null);
    }
    expect(existsSync(plugin)).toBe(true);
  }, 30_000);
});
