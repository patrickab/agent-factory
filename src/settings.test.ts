import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  DEFAULTS_PATH,
  defaultModels,
  factoryHome,
  loadDefaults,
  loadSettings,
  parseStoredSettings,
  registeredRepos,
  resolveRepoSettings,
  resolveSettings,
  saveSettings,
  unregisterRepo,
  type StoredSettings,
} from "./settings.ts";

const REPO = "/home/someone/git/project";
const REPO_FILE = "%2Fhome%2Fsomeone%2Fgit%2Fproject.yaml";
const { small: SMALL, big: BIG } = defaultModels();
const DEFAULTS = { merge: "auto", maxRounds: 2, review: false, models: { small: SMALL, big: BIG, coder: BIG, reviewer: BIG } } as const;
let agentDir: string;
let previousAgentDir: string | undefined;

beforeEach(async () => {
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  agentDir = await mkdtemp(join(tmpdir(), "factory-settings-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(agentDir, { recursive: true, force: true });
});

/** The settings file of `REPO`: its path, URI-encoded, as the file name. */
function settingsPath(): string {
  return join(agentDir, "factory", "repos", REPO_FILE);
}

async function writeSettingsFile(text: string): Promise<string> {
  const path = settingsPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  return path;
}

describe("paths", () => {
  test("factoryHome follows PI_CODING_AGENT_DIR, the settings file is <factoryHome>/repos/<encoded path>.yaml", async () => {
    expect(factoryHome()).toBe(join(agentDir, "factory"));
    await saveSettings(REPO, { review: true });
    expect(await readdir(join(agentDir, "factory", "repos"))).toEqual([REPO_FILE]);
  });

  test("factoryHome without PI_CODING_AGENT_DIR is ~/.pi/agent/factory; a leading ~ is the home dir", () => {
    delete process.env.PI_CODING_AGENT_DIR;
    expect(factoryHome()).toBe(join(homedir(), ".pi", "agent", "factory"));
    process.env.PI_CODING_AGENT_DIR = "~/agent-x";
    expect(factoryHome()).toBe(join(homedir(), "agent-x", "factory"));
  });

  test("a settings file registers its repo: registeredRepos lists them sorted, unregisterRepo removes one", async () => {
    expect(await registeredRepos()).toEqual([]);
    await saveSettings("/b/repo", {});
    await saveSettings(REPO, {});
    expect(await registeredRepos()).toEqual(["/b/repo", REPO]);
    expect(await unregisterRepo(REPO)).toBe(true);
    expect(await unregisterRepo(REPO)).toBe(false);
    expect(await registeredRepos()).toEqual(["/b/repo"]);
  });

  test("two repos whose paths differ only in / and - have their own settings", async () => {
    await saveSettings("/a/b-c", { merge: "review" });
    expect(await loadSettings("/a-b/c")).toEqual({});
    expect(await loadSettings("/a/b-c")).toEqual({ merge: "review" });
  });
});

describe("loadSettings", () => {
  test("a missing file is empty settings", async () => {
    expect(await loadSettings(REPO)).toEqual({});
  });

  test("an empty file is empty settings", async () => {
    await writeSettingsFile("");
    expect(await loadSettings(REPO)).toEqual({});
  });

  test("drops unknown keys and unknown model names", async () => {
    await writeSettingsFile("merge: review\nextra: 1\nmodels:\n  small: a/s\n  big: a/b\n  planner: c/d\n");
    expect(await loadSettings(REPO)).toEqual({ merge: "review", models: { small: "a/s", big: "a/b" } });
  });

  test("old names: coder is read as big, a reviewer equal to it is dropped, another one is kept as the reviewer's own", async () => {
    await writeSettingsFile("models:\n  coder: a/b\n  reviewer: a/b\n");
    expect(await loadSettings(REPO)).toEqual({ models: { big: "a/b" } });
    await writeSettingsFile("models:\n  coder: a/b\n  reviewer: c/d\n");
    expect(await loadSettings(REPO)).toEqual({ models: { big: "a/b", reviewer: "c/d" } });
    // An old client edits only coder, sending back the big it read: coder wins.
    await writeSettingsFile("models:\n  big: a/b\n  coder: e/f\n  reviewer: e/f\n");
    expect(await loadSettings(REPO)).toEqual({ models: { big: "e/f" } });
    await writeSettingsFile("models:\n  reviewer: c/d\n");
    expect(await loadSettings(REPO)).toEqual({ models: { reviewer: "c/d" } });
  });

  const invalid: [string, string, string][] = [
    ["not a mapping", "- 1\n", "settings must be a mapping"],
    ["branch empty", 'branch: ""\n', "branch"],
    ["branch not a string", "branch: 3\n", "branch"],
    ["merge", "merge: later\n", "merge"],
    ["maxRounds zero", "maxRounds: 0\n", "maxRounds"],
    ["maxRounds above 20", "maxRounds: 21\n", "maxRounds"],
    ["maxRounds fraction", "maxRounds: 1.5\n", "maxRounds"],
    ["maxRounds string", "maxRounds: two\n", "maxRounds"],
    ["review", "review: yes please\n", "review"],
    ["models not a mapping", "models: a/b\n", "models"],
    ["coder model without provider", "models:\n  coder: sonnet\n", "models.coder"],
    ["small model without provider", "models:\n  small: sonnet\n", "models.small"],
    ["big model not a string", "models:\n  big: 4\n", "models.big"],
    ["reviewer model not a string", "models:\n  reviewer: 4\n", "models.reviewer"],
    ["preview", "preview: 1\n", "preview"],
  ];
  for (const [name, text, key] of invalid) {
    test(`an invalid file throws naming the file and the key: ${name}`, async () => {
      const path = await writeSettingsFile(text);
      const error = await loadSettings(REPO).then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toStartWith(`${path}: `);
      expect((error as Error).message).toContain(key);
    });
  }

  test("an unparsable file throws naming the file", async () => {
    const path = await writeSettingsFile("merge: [\n");
    await expect(loadSettings(REPO)).rejects.toThrow(path);
  });
});

describe("saveSettings", () => {
  test("round trips, creating directories and leaving no temp file", async () => {
    const settings: StoredSettings = { branch: "develop", merge: "review", maxRounds: 5, review: true, models: { small: "anthropic/s", big: "anthropic/x", reviewer: "openai/y" } };
    await saveSettings(REPO, settings);
    expect(await loadSettings(REPO)).toEqual(settings);
    expect(await readdir(dirname(settingsPath()))).toEqual([REPO_FILE]);
  });

  test("drops unknown keys before writing", async () => {
    await saveSettings(REPO, { review: true, extra: "x" } as StoredSettings);
    expect(await readFile(settingsPath(), "utf8")).not.toContain("extra");
    expect(await loadSettings(REPO)).toEqual({ review: true });
  });

  test("refuses invalid settings and writes nothing", async () => {
    await expect(saveSettings(REPO, { maxRounds: 30 })).rejects.toThrow(`${settingsPath()}: maxRounds`);
    await expect(saveSettings(REPO, { models: { big: "bare" } })).rejects.toThrow("models.big");
    expect(await loadSettings(REPO)).toEqual({});
  });

  test("two concurrent saves leave one valid file", async () => {
    const first: StoredSettings = { merge: "review", maxRounds: 3, models: { big: "a/one" } };
    const second: StoredSettings = { merge: "auto", maxRounds: 7, review: true, models: { reviewer: "b/two" } };
    await Promise.all([saveSettings(REPO, first), saveSettings(REPO, second)]);
    expect([first, second]).toContainEqual(await loadSettings(REPO));
    expect(await readdir(dirname(settingsPath()))).toEqual([REPO_FILE]);
  });
});

describe("the defaults", () => {
  test("defaults.yaml at the package root names small and big; defaultModels reads it", async () => {
    expect(DEFAULTS_PATH).toBe(join(import.meta.dirname, "..", "defaults.yaml"));
    const raw = Bun.YAML.parse(await readFile(DEFAULTS_PATH, "utf8")) as { models: { small: string; big: string } };
    expect(defaultModels()).toEqual({ small: raw.models.small, big: raw.models.big });
    expect(loadDefaults()).toEqual(defaultModels());
  });

  test("a missing or broken file throws naming its path", async () => {
    const path = join(agentDir, "defaults.yaml");
    expect(() => loadDefaults(path)).toThrow(`the factory's defaults ${path}: `);
    await writeFile(path, "models: [\n");
    expect(() => loadDefaults(path)).toThrow(path);
    await writeFile(path, "models:\n  big: a/b\n");
    expect(() => loadDefaults(path)).toThrow(`${path}: models.small must be "provider/model"`);
    await writeFile(path, "models:\n  small: a/s\n  big: opus\n");
    expect(() => loadDefaults(path)).toThrow(`${path}: models.big must be "provider/model"`);
    await writeFile(path, "- a/b\n");
    expect(() => loadDefaults(path)).toThrow(path);
    await writeFile(path, "models:\n  small: a/s\n  big: a/b\n");
    expect(loadDefaults(path)).toEqual({ small: "a/s", big: "a/b" });
  });
});

describe("resolveSettings", () => {
  test("defaults when nothing is stored or overridden: the models of defaults.yaml under all four names", () => {
    expect(resolveSettings({}, {}, "main")).toEqual({ ...DEFAULTS, branch: "main" });
  });

  test("defaults < stored < overrides, models merged per name", () => {
    const stored: StoredSettings = { branch: "develop", merge: "review", maxRounds: 4, models: { small: "s/small", big: "s/big", reviewer: "s/reviewer" } };
    const overrides: StoredSettings = { maxRounds: 9, review: true, models: { reviewer: "o/reviewer", big: undefined } };
    const storedCopy = structuredClone(stored);
    const overridesCopy = structuredClone(overrides);
    expect(resolveSettings(stored, overrides, "main")).toEqual({
      branch: "develop",
      merge: "review",
      maxRounds: 9,
      review: true,
      models: { small: "s/small", big: "s/big", coder: "s/big", reviewer: "o/reviewer" },
    });
    expect(resolveSettings(stored, { branch: "release" }, "main").branch).toBe("release");
    expect(resolveSettings({ models: { big: "s/big" } }, {}, "main").models).toEqual({ small: SMALL, big: "s/big", coder: "s/big", reviewer: "s/big" });
    expect(stored).toEqual(storedCopy);
    expect(overrides).toEqual(overridesCopy);
  });

  test("size small runs the coder on the small model; the reviewer stays big", () => {
    expect(resolveSettings({ models: { small: "s/small", big: "s/big" } }, {}, "main", "small").models).toEqual({ small: "s/small", big: "s/big", coder: "s/small", reviewer: "s/big" });
    expect(resolveSettings({}, {}, "main", "small").models).toEqual({ small: SMALL, big: BIG, coder: SMALL, reviewer: BIG });
  });

  test("preview is stored and passed through, false by default; resolveSettings leaves it out", async () => {
    await saveSettings(REPO, { preview: true });
    expect(await loadSettings(REPO)).toEqual({ preview: true });
    expect(resolveRepoSettings({ preview: true }, {}, "main")).toEqual({ ...DEFAULTS, branch: "main", preview: true, remote: false });
    expect(resolveRepoSettings({}, {}, "main").preview).toBe(false);
    expect(resolveSettings({ preview: true }, {}, "main")).toEqual({ ...DEFAULTS, branch: "main" });
  });

  test("remote is stored, false by default, an override wins; resolveSettings leaves it out", async () => {
    await saveSettings(REPO, { remote: true });
    expect(await loadSettings(REPO)).toEqual({ remote: true });
    expect(resolveRepoSettings({ remote: true }, {}, "main").remote).toBe(true);
    expect(resolveRepoSettings({ remote: true }, { remote: false }, "main").remote).toBe(false);
    expect(resolveRepoSettings({}, {}, "main").remote).toBe(false);
    expect(resolveSettings({ remote: true }, {}, "main")).toEqual({ ...DEFAULTS, branch: "main" });
    expect(() => parseStoredSettings({ remote: "yes" })).toThrow("remote must be a boolean");
  });

  test("the result does not share the models object of an input", () => {
    const stored: StoredSettings = { models: { big: "s/big" } };
    const resolved = resolveSettings(stored, {}, "main");
    resolved.models.reviewer = "x/y";
    expect(stored.models).toEqual({ big: "s/big" });
    expect(resolveSettings({}, {}, "main").models).toEqual(DEFAULTS.models);
  });
});
