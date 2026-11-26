/**
 * The core's own part (`core.ts`): the action list and `callAction`'s errors, over the fixture of `core-test-kit.ts`.
 * The areas' tests: `core-settings.test.ts`, `core-tasks.test.ts`, `core-wait.test.ts`, `core-waves.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACTIONS, callAction } from "./core.ts";
import { caseDir, exitingRunner, expectError, failure, fakeRecord, fakeWaveRunner, ID_1, ID_2, makeRepo, until, useCoreFixture } from "./core-test-kit.ts";
import { liveRunners } from "./launch.ts";
import { writeTask } from "./tasks.ts";

useCoreFixture();

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
        "scouts.start",
        "scouts.get",
        "scouts.list",
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
