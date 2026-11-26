/** The core's repos, models, branches, settings and config actions (`core-settings.ts`), over the fixture of `core-test-kit.ts`. */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACTIONS, callAction } from "./core.ts";
import type { TaskView } from "./core-tasks.ts";
import { caseDir, expectError, git, makeRepo, modelsFile, until, useCoreFixture } from "./core-test-kit.ts";
import { defaultModels } from "./settings.ts";
import { listTasks } from "./tasks.ts";

useCoreFixture();

describe("repos", () => {
  test("add registers the primary checkout, list names it, remove unregisters", async () => {
    const repo = makeRepo();
    git(repo, "worktree", "add", "--quiet", "-b", "side", join(caseDir, "side"));
    expect(await callAction("repos.list", {})).toEqual({ repos: [] });
    expect(await callAction("repos.add", { repo: "side" }, { cwd: caseDir })).toEqual({ repo, repos: [repo] });
    expect(await callAction("repos.add", {}, { cwd: repo })).toEqual({ repo, repos: [repo] });
    expect(await callAction("repos.list", {})).toEqual({ repos: [repo] });
    expect(await callAction("repos.remove", { repo })).toEqual({ repos: [] });
    await expectError(callAction("repos.remove", { repo }), "not_found", `${repo} is not registered`);
  });

  test("remove takes a registered path whose repository is gone", async () => {
    const repo = makeRepo();
    await callAction("repos.add", { repo });
    rmSync(repo, { recursive: true, force: true });
    expect(await callAction("repos.remove", { repo })).toEqual({ repos: [] });
  });

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
  test("models.get reads the list, models.set replaces it deduplicated; an empty list reads as []", async () => {
    expect(await callAction("models.get", {})).toEqual({ models: ["a/b", "c/d"] });
    expect(await callAction("models.set", { models: ["x/y", "a/b", "x/y"] })).toEqual({ models: ["x/y", "a/b"] });
    expect(await callAction("models.get", {})).toEqual({ models: ["x/y", "a/b"] });
    expect(await callAction("models.set", { models: [] })).toEqual({ models: [] });
    rmSync(modelsFile());
    expect(await callAction("models.get", {})).toEqual({ models: [] });
    expect(ACTIONS["models.get"].mutates).toBe(false);
    expect(ACTIONS["models.set"].mutates).toBe(true);
  });

  test("models.set refuses a missing, mistyped or malformed list and keeps the old one", async () => {
    await expectError(callAction("models.set", {}), "invalid", "models.set needs models");
    await expectError(callAction("models.set", { models: "a/b" }), "invalid", "models.set: models must be an array");
    await expectError(callAction("models.set", { models: ["sonnet"] }), "invalid", 'models.set: "sonnet" is not a provider/model id');
    await expectError(callAction("models.set", { models: [4] }), "invalid", "models.set: 4 is not a provider/model id");
    expect(await callAction("models.get", {})).toEqual({ models: ["a/b", "c/d"] });
  });

  test("an empty list: settings.set and tasks.start are refused naming /factory models, reads still work", async () => {
    const repo = makeRepo();
    rmSync(modelsFile());
    const noModels = "no factory models are set (set them with /factory models)";
    await expectError(callAction("settings.set", { repo, settings: { merge: "review" } }), "refused", noModels);
    await expectError(callAction("tasks.start", { title: "t", request: "r" }, { cwd: repo }), "refused", noModels);
    expect(((await callAction("settings.get", { repo })) as { stored: object }).stored).toEqual({});
    expect(await callAction("tasks.list", {})).toEqual({ tasks: [] });
    expect(await callAction("repos.add", { repo })).toEqual({ repo, repos: [repo] });
    expect(await listTasks()).toEqual([]);
  });

  test("a model not on the list: settings.set and tasks.start (stored or override) are refused naming it", async () => {
    const repo = makeRepo();
    await expectError(callAction("settings.set", { repo, settings: { models: { coder: "a/b", reviewer: "z/z" } } }), "refused", "the reviewer model z/z is not a factory model");
    await expectError(
      callAction("tasks.start", { title: "t", request: "r", overrides: { models: { coder: "q/q" } } }, { cwd: repo }),
      "refused",
      "the coder model q/q is not a factory model (add it with /factory models add q/q)",
    );
    await callAction("settings.set", { repo, settings: { models: { coder: "c/d" } } });
    await callAction("models.set", { models: ["a/b"] });
    await expectError(callAction("tasks.start", { title: "t", request: "r" }, { cwd: repo }), "refused", "the coder model c/d is not a factory model");
    expect(await listTasks()).toEqual([]);
  });

  test("nothing stored and no override: a task outside a wave starts without a model, though defaults.yaml names models off the list", async () => {
    const repo = makeRepo();
    const { small, big } = defaultModels();
    expect(readFileSync(modelsFile(), "utf8")).not.toContain(big);
    expect(readFileSync(modelsFile(), "utf8")).not.toContain(small);
    const view = (await callAction("tasks.start", { title: "t", request: "r" }, { cwd: repo })) as TaskView;
    const settings = async () => ((await callAction("tasks.get", { id: view.id })) as TaskView).settings;
    await until(async () => (await settings()) !== null && (await settings()) !== undefined);
    expect((await settings())?.models).toEqual({});
  });

  test("only coder stored: a task outside a wave runs its coder on it and has no reviewer model (Pi's session model), as before", async () => {
    const repo = makeRepo();
    await callAction("settings.set", { repo, settings: { review: true, models: { coder: "a/b" } } });
    const view = (await callAction("tasks.start", { title: "t", request: "r" }, { cwd: repo })) as TaskView;
    const settings = async () => ((await callAction("tasks.get", { id: view.id })) as TaskView).settings;
    await until(async () => (await settings()) !== null && (await settings()) !== undefined);
    expect((await settings())?.models).toEqual({ coder: "a/b", big: "a/b" });
  });
});

describe("branches, settings, config", () => {
  test("branches.list: name, default, hasConfig", async () => {
    const repo = makeRepo();
    git(repo, "checkout", "--quiet", "-b", "bare");
    git(repo, "rm", "--quiet", "factory.yaml");
    git(repo, "commit", "--quiet", "-m", "no config");
    git(repo, "checkout", "--quiet", "main");
    expect(await callAction("branches.list", { repo })).toEqual({
      branches: [
        { name: "bare", default: false, hasConfig: false },
        { name: "main", default: true, hasConfig: true },
      ],
    });
  });

  test("settings.get and settings.set: stored, resolved, defaults; preview passes through; invalid values refused", async () => {
    const repo = makeRepo();
    // Nothing stored: no model (Pi's session model), not the ones of defaults.yaml.
    const defaults = { branch: "main", merge: "auto", maxRounds: 2, review: false, models: {}, preview: false, remote: false, squash: false };
    expect(await callAction("settings.get", { repo })).toEqual({ stored: {}, resolved: defaults, defaults });
    // The names as before, as the settings panel sends them: answered and stored as they are, big added equal to coder.
    const set = await callAction("settings.set", { repo, settings: { merge: "review", preview: true, models: { coder: "a/b" } } });
    expect(set).toEqual({
      stored: { merge: "review", preview: true, models: { coder: "a/b", big: "a/b" } },
      resolved: { ...defaults, merge: "review", preview: true, models: { coder: "a/b", big: "a/b" } },
      defaults,
    });
    expect(Bun.YAML.parse(readFileSync(join(caseDir, "agent", "factory", "repos", `${encodeURIComponent(repo)}.yaml`), "utf8"))).toMatchObject({ models: { coder: "a/b", big: "a/b" } });
    const both = (await callAction("settings.set", { repo, settings: { models: { coder: "a/b", reviewer: "a/b" } } })) as { stored: { models: object }; resolved: { models: object } };
    expect(both.stored.models).toEqual({ coder: "a/b", big: "a/b", reviewer: "a/b" });
    // big is accepted as coder; small is added.
    const sized = (await callAction("settings.set", { repo, settings: { merge: "review", preview: true, models: { small: "c/d", big: "a/b" } } })) as { resolved: { models: object } };
    expect(sized.resolved.models).toEqual({ small: "c/d", big: "a/b", coder: "a/b" });
    await expectError(callAction("settings.set", { repo, settings: { preview: "yes" } }), "invalid", "settings.preview must be a boolean");
    await expectError(callAction("settings.set", { repo, settings: { maxRounds: 30 } }), "invalid", "settings.maxRounds");
    expect(((await callAction("settings.get", { repo })) as { stored: object }).stored).toEqual({ merge: "review", preview: true, models: { small: "c/d", coder: "a/b", big: "a/b" } });
    expect(await callAction("repos.list", {})).toEqual({ repos: [repo] });
  });

  test("config.get: the working copy, a branch's committed file, a draft when there is none", async () => {
    const repo = makeRepo();
    expect(await callAction("config.get", { repo })).toEqual({ exists: true, text: "gates: []\n", draft: null, source: [] });
    writeFileSync(join(repo, "factory.yaml"), "gates: [[make, lint]]\n");
    expect(((await callAction("config.get", { repo, branch: "main" })) as { text: string }).text).toBe("gates: []\n");
    await expectError(callAction("config.get", { repo, branch: "nope" }), "not_found", "has no local branch nope");
    rmSync(join(repo, "factory.yaml"));
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { lint: "eslint ." } }));
    const drafted = (await callAction("config.get", { repo })) as { exists: boolean; text: null; draft: string; source: string[] };
    expect(drafted.exists).toBe(false);
    expect(drafted.text).toBeNull();
    expect(drafted.draft).toContain("gates:");
    expect(drafted.source).toEqual(["package.json"]);
  });

  test("config.write needs a registered repo and overwrite: true to replace a file", async () => {
    const repo = makeRepo(false);
    await expectError(callAction("config.write", { repo, text: "gates: []\n" }), "not_found", `${repo} is not registered`);
    expect(existsSync(join(repo, "factory.yaml"))).toBe(false);
    await callAction("repos.add", { repo });
    expect(await callAction("config.write", { repo, text: "gates: []\n" })).toEqual({ path: join(repo, "factory.yaml") });
    await expectError(callAction("config.write", { repo, text: "gates: [[x]]\n" }), "refused", "exists, give overwrite: true to replace it");
    expect(readFileSync(join(repo, "factory.yaml"), "utf8")).toBe("gates: []\n");
  });

  test("config.write checks the text, writes factory.yaml, commits nothing", async () => {
    const repo = makeRepo();
    await callAction("repos.add", { repo });
    await expectError(callAction("config.write", { repo, text: "gates: 3\n", overwrite: true }), "invalid", "factory.yaml: gates must be a list of argv lists");
    expect(await callAction("config.write", { repo, text: "gates: [[make, lint]]\n", overwrite: true })).toEqual({ path: join(repo, "factory.yaml") });
    expect(readFileSync(join(repo, "factory.yaml"), "utf8")).toBe("gates: [[make, lint]]\n");
    expect(git(repo, "status", "--porcelain")).toBe("M factory.yaml");
  });
});

