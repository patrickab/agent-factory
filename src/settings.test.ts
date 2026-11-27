import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadSettings, resolveSettings, saveSettings, taskModels, type StoredSettings } from "./settings.ts";

const REPO = "/home/someone/git/project";
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

const settingsPath = () => join(agentDir, "factory", "repos", `${encodeURIComponent(REPO)}.yaml`);

test("an invalid settings file throws naming the file and the key", async () => {
  const invalid: [string, string][] = [
    ["merge: [\n", ""],
    ["- 1\n", ""],
    ['branch: ""\n', "branch"],
    ["merge: later\n", "merge"],
    ["maxRounds: 21\n", "maxRounds"],
    ["maxRounds: 1.5\n", "maxRounds"],
    ["review: yes please\n", "review"],
    ["models:\n  big: sonnet\n", "models.big"],
    ["preview: 1\n", "preview"],
    ["squash: yes\n", "squash"],
  ];
  await mkdir(dirname(settingsPath()), { recursive: true });
  for (const [text, key] of invalid) {
    await writeFile(settingsPath(), text);
    const error = (await loadSettings(REPO).then(() => undefined, (caught: unknown) => caught)) as Error;
    expect(error.message).toContain(settingsPath());
    expect(error.message).toContain(key);
  }
});

test("defaults < stored < overrides, models merged per name; a task's coder runs its size's model, big where no small is named", () => {
  const stored: StoredSettings = { branch: "develop", merge: "review", maxRounds: 4, squash: true, models: { small: "s/small", big: "s/big", reviewer: "s/reviewer" } };
  const overrides: StoredSettings = { maxRounds: 9, review: true, squash: false, models: { reviewer: "o/reviewer" } };
  const models = { small: "s/small", big: "s/big", reviewer: "o/reviewer" };
  expect(resolveSettings([stored, overrides], "main")).toEqual({ branch: "develop", merge: "review", maxRounds: 9, review: true, preview: false, squash: false, models });
  expect(resolveSettings([{ preview: true }], "main")).toEqual({ branch: "main", merge: "auto", maxRounds: 2, review: false, preview: true, squash: false, models: {} });
  expect([taskModels(models, "small"), taskModels(models), taskModels({ big: "s/big" }, "small"), taskModels({})]).toEqual([
    { coder: "s/small", reviewer: "o/reviewer" },
    { coder: "s/big", reviewer: "o/reviewer" },
    { coder: "s/big" },
    {},
  ]);
});

test("two concurrent saves leave one valid file; repos differing only in / and - have their own", async () => {
  const first: StoredSettings = { merge: "review", maxRounds: 3 };
  const second: StoredSettings = { merge: "auto", maxRounds: 7, review: true };
  await Promise.all([saveSettings(REPO, first), saveSettings(REPO, second)]);
  expect([first, second]).toContainEqual(await loadSettings(REPO));
  expect(await readdir(dirname(settingsPath()))).toEqual([`${encodeURIComponent(REPO)}.yaml`]);
  await saveSettings("/a/b-c", { merge: "review" });
  expect(await loadSettings("/a-b/c")).toEqual({});
  expect(await loadSettings("/a/b-c")).toEqual({ merge: "review" });
});
