/**
 * The core's own part (`core.ts`): `callAction`'s errors, over the fixture of `core-test-kit.ts`.
 * The areas' tests: `core-settings.test.ts`, `core-tasks.test.ts`, `core-wait.test.ts`, `core-waves.test.ts`.
 */
import { describe, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { callAction } from "./core.ts";
import { caseDir, expectError, fakeRecord, ID_1, ID_2, makeRepo, useCoreFixture } from "./core-test-kit.ts";
import { writeTask } from "./tasks.ts";

useCoreFixture();

describe("callAction", () => {
  test("invalid: an unknown action, a missing or mistyped param, an ambiguous id", async () => {
    await expectError(callAction("tasks.fly", {}), "invalid");
    await expectError(callAction("tasks.get", {}), "invalid");
    await expectError(callAction("tasks.timeline", { id: "x", since: "1" }), "invalid");
    await writeTask(fakeRecord(ID_1, "/r"));
    await writeTask(fakeRecord(ID_2, "/r"));
    await expectError(callAction("tasks.get", { id: "abc" }), "invalid");
  });

  test("not_found: an unknown id, a path outside git", async () => {
    await expectError(callAction("tasks.get", { id: "zz" }), "not_found");
    await expectError(callAction("branches.list", {}, { cwd: caseDir }), "not_found");
  });

  test("failed: a stored settings file that does not parse", async () => {
    const repo = makeRepo();
    await callAction("repos.add", { repo });
    writeFileSync(join(caseDir, "agent", "factory", "repos", `${encodeURIComponent(repo)}.yaml`), "merge: [\n");
    await expectError(callAction("settings.get", { repo }), "failed");
  });
});
