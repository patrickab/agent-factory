/** The core's models and settings actions (`core-settings.ts`), over the fixture of `core-test-kit.ts`. */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callAction } from "./core.ts";
import { caseDir, expectError, makeRepo, useCoreFixture } from "./core-test-kit.ts";
import { listTasks } from "./tasks.ts";

useCoreFixture();

describe("loading", () => {
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
  test("models.set replaces the list deduplicated; a missing, mistyped or malformed list is refused and keeps the old one", async () => {
    expect(await callAction("models.set", { models: ["x/y", "a/b", "x/y"] })).toEqual({ models: ["x/y", "a/b"] });
    await expectError(callAction("models.set", { models: "a/b" }), "invalid", "models.set: models must be an array");
    await expectError(callAction("models.set", { models: ["sonnet"] }), "invalid", '"sonnet" is not a provider/model id');
    await expectError(callAction("models.set", { models: [4] }), "invalid", "models.set: models[0] must be a string");
    expect(await callAction("models.get", {})).toEqual({ models: ["x/y", "a/b"] });
  });

  test("a model not on the list: settings.set and tasks.start (stored or override) are refused naming it", async () => {
    const repo = makeRepo();
    await expectError(callAction("settings.set", { repo, settings: { models: { big: "a/b", reviewer: "z/z" } } }), "refused", "the reviewer model z/z is not a factory model");
    await expectError(
      callAction("tasks.start", { title: "t", request: "r", overrides: { models: { big: "q/q" } } }, { cwd: repo }),
      "refused",
      "q/q",
    );
    await callAction("settings.set", { repo, settings: { models: { big: "c/d" } } });
    await callAction("models.set", { models: ["a/b"] });
    await expectError(callAction("tasks.start", { title: "t", request: "r" }, { cwd: repo }), "refused", "c/d");
    expect(await listTasks()).toEqual([]);
  });
});

describe("settings", () => {
  test("defaults < stored: settings.set resolves over the defaults, settings.get reads it back; invalid values change nothing", async () => {
    const repo = makeRepo();
    // Nothing stored: no model (Pi's session model), not the ones of defaults.yaml.
    const defaults = { branch: "main", merge: "auto", maxRounds: 2, review: false, models: {}, preview: false, squash: false };
    expect(await callAction("settings.get", { repo })).toEqual({ stored: {}, resolved: defaults, defaults });
    const set = (await callAction("settings.set", { repo, settings: { merge: "review", preview: true, models: { small: "c/d", big: "a/b" } } })) as { resolved: object };
    expect(set.resolved).toEqual({ ...defaults, merge: "review", preview: true, models: { small: "c/d", big: "a/b" } });
    await expectError(callAction("settings.set", { repo, settings: { preview: "yes" } }), "invalid", "settings.preview must be a boolean");
    await expectError(callAction("settings.set", { repo, settings: { maxRounds: 30 } }), "invalid", "settings.maxRounds");
    expect(((await callAction("settings.get", { repo })) as { resolved: object }).resolved).toEqual(set.resolved);
  });
});
