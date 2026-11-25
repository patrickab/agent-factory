import { afterEach, expect, test } from "bun:test";
import { commandEnv, runCommand } from "./run.ts";

const saved = { session: process.env.FACTORY_TASK_SESSION, lock: process.env.FACTORY_TASK_LOCK };

afterEach(() => {
  for (const [key, value] of [["FACTORY_TASK_SESSION", saved.session], ["FACTORY_TASK_LOCK", saved.lock]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("a command (a gate, a hook) never inherits the runner's task-session and lock variables", async () => {
  process.env.FACTORY_TASK_SESSION = "1";
  process.env.FACTORY_TASK_LOCK = "/tmp/x.lock";
  const result = await runCommand(["sh", "-c", 'echo "${FACTORY_TASK_SESSION-unset} ${FACTORY_TASK_LOCK-unset} $GIT_EDITOR $EXTRA"'], { cwd: "/", env: { EXTRA: "e" }, maxStdoutChars: 1000 });
  expect(result.stdout.trim()).toBe("unset unset true e");
  expect(commandEnv({ FACTORY_TASK_SESSION: "1", PATH: "/bin" })).toEqual({ PATH: "/bin", GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" });
});
