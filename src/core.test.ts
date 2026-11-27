/**
 * The core's own part (`core.ts`): `callAction`'s errors, over the fixture of `core-test-kit.ts`.
 * The areas' tests: `core-settings.test.ts`, `core-tasks.test.ts`, `core-wait.test.ts`, `core-waves.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { callAction } from "./core.ts";
import { caseDir, expectError, failure, fakeRecord, ID_1, ID_2, makeRepo, useCoreFixture } from "./core-test-kit.ts";
import { writeTask } from "./tasks.ts";

useCoreFixture();

describe("callAction", () => {
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
