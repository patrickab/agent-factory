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
  test("a model not on the list: settings.set and tasks.start (stored or override) are refused", async () => {
    const repo = makeRepo();
    await expectError(callAction("settings.set", { repo, settings: { models: { big: "a/b", reviewer: "z/z" } } }), "refused");
    await expectError(callAction("tasks.start", { title: "t", request: "r", overrides: { models: { big: "q/q" } } }, { cwd: repo }), "refused");
    await callAction("settings.set", { repo, settings: { models: { big: "c/d" } } });
    await callAction("models.set", { models: ["a/b"] });
    await expectError(callAction("tasks.start", { title: "t", request: "r" }, { cwd: repo }), "refused");
    expect(await listTasks()).toEqual([]);
  });
});

describe("settings", () => {
  test("settings.set stores over the defaults, settings.get reads it back; an invalid value changes nothing", async () => {
    const repo = makeRepo();
    const set = (await callAction("settings.set", { repo, settings: { merge: "review", preview: true } })) as { resolved: object };
    expect(set.resolved).toMatchObject({ merge: "review", preview: true });
    await expectError(callAction("settings.set", { repo, settings: { preview: "yes" } }), "invalid");
    expect(await callAction("settings.get", { repo })).toMatchObject({ stored: { merge: "review", preview: true }, resolved: set.resolved });
  });
});
