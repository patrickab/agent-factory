import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandRunner, commandEnv, runCommand } from "./run.ts";
import { until } from "./core-test-kit.ts";
import { restoreEnv } from "./core-test-kit.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "factory-run-test-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const runner = new CommandRunner();

const savedEnv = { ...process.env };
afterEach(() => restoreEnv(savedEnv));

test("a command (a gate, a hook) never inherits the runner's task-session and lock variables", async () => {
  process.env.FACTORY_TASK_SESSION = "1";
  process.env.FACTORY_TASK_LOCK = "/tmp/x.lock";
  const result = await runCommand(["sh", "-c", 'echo "${FACTORY_TASK_SESSION-unset} ${FACTORY_TASK_LOCK-unset} $GIT_EDITOR $EXTRA"'], { cwd: "/", env: { EXTRA: "e" }, maxStdoutChars: 1000 });
  expect(result.stdout.trim()).toBe("unset unset true e");
  expect(commandEnv({ FACTORY_TASK_SESSION: "1", PATH: "/bin" })).toEqual({ PATH: "/bin", GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" });
});

describe("CommandRunner", () => {
  test("cancel kills the whole process group, a member that ignores SIGTERM too, and never reports exit 0", async () => {
    const own = new CommandRunner();
    const pidFile = join(scratch, "stubborn.pid");
    const running = own.run(["sh", "-c", `sh -c 'trap "" TERM; echo $$ > ${pidFile}; exec sleep 60' & wait`], { cwd: scratch });
    await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    own.cancel();
    const result = await running;
    expect(result).toMatchObject({ exitCode: null, killed: true });
    await until(() => {
      try {
        process.kill(grandchild, 0);
        return false;
      } catch {
        return true;
      }
    });
    expect(await own.run(["true"], { cwd: scratch })).toMatchObject({ exitCode: null, killed: true });
    own.reset();
    expect(await own.run(["true"], { cwd: scratch })).toMatchObject({ exitCode: 0, killed: false });
  });

  test("a command that leaves a daemon holding its pipes ends when the command exits", async () => {
    const result = await runner.run(["sh", "-c", "setsid sleep 30 & echo $!"], { cwd: scratch, maxStdoutChars: 100 });
    process.kill(Number(result.stdout), "SIGKILL");
    expect(result).toMatchObject({ exitCode: 0, killed: false });
  });

  test("a timeout kills the command and marks it", async () => {
    const result = await runner.run(["sleep", "60"], { cwd: scratch, timeoutMs: 100 });
    expect(result).toMatchObject({ exitCode: null, killed: true, timedOut: true });
  });
});
