/**
 * The core's actions on what a repository is set up with (`core.ts` maps them): the factory models (`models.*`), the
 * registered repositories (`repos.*`), their branches, stored settings (`settings.*`) and `factory.yaml` (`config.*`).
 *
 * - The models a task or repository may use are one user-level list (`models.ts`): `models.get`/`models.set`.
 *   `settings.set` refuses a model not on it, and anything while it is empty (`requireFactoryModels`, which
 *   `tasks.start` and the wave actions use too); reads never check it
 * - `settingsOf`: the stored settings, them resolved over the defaults, and the defaults, the branch resolved from the
 *   repository's default one
 * - `config.get` reads the working copy or a branch's committed `factory.yaml`, a draft when there is none;
 *   `config.write` checks the text before it writes it (never commits)
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFactoryYaml } from "./config.ts";
import { FactoryError, primaryOf, repoPath, type Handler } from "./core-shared.ts";
import { initDraft } from "./draft.ts";
import { git } from "./git.ts";
import { defaultBranch, localBranchExists } from "./launch.ts";
import { loadModels, requireModels, saveModels } from "./models.ts";
import { runCommand } from "./run.ts";
import {
  DEFAULT_SETTINGS,
  defaultModels,
  loadSettings,
  parseStoredSettings,
  registeredRepos,
  resolveRepoSettings,
  saveSettings,
  unregisterRepo,
  type ResolvedModels,
  type ResolvedSettings,
  type StoredSettings,
} from "./settings.ts";
import { errorText } from "./util.ts";
import type { WaveTaskEntry } from "./waves.ts";

export async function branchHasConfig(repo: string, branch: string): Promise<boolean> {
  return (await runCommand(["git", "cat-file", "-e", `refs/heads/${branch}:factory.yaml`], { cwd: repo })).exitCode === 0;
}

/** The blob `object` (`<ref>:<path>`) as git stores it, not trimmed. */
async function committedText(repo: string, object: string): Promise<string> {
  const result = await runCommand(["git", "cat-file", "blob", object], { cwd: repo, maxStdoutChars: 4_000_000 });
  if (result.exitCode !== 0 || result.killed || result.stdoutTruncated) throw new Error(`git cat-file blob ${object} failed (exit ${result.exitCode})`);
  return result.stdout;
}

async function settingsOf(repo: string): Promise<{ stored: StoredSettings; resolved: ResolvedSettings; defaults: ResolvedSettings }> {
  const stored = await loadSettings(repo);
  const fallback = await defaultBranch(repo).catch(() => undefined);
  const branch = stored.branch ?? fallback;
  if (branch === undefined) throw new FactoryError("refused", `${repo} has no default branch (origin/HEAD, main and master do not exist locally)`);
  return { stored, resolved: resolveRepoSettings(stored, {}, branch), defaults: { ...DEFAULT_SETTINGS, models: {}, branch: fallback ?? branch } };
}

/** The models a wave's `specs` run with that a setting names: `big` for coders and the reviewer, `small` only when a task asks for it. */
export function wantedModels(models: ResolvedModels, specs: readonly WaveTaskEntry[]): Record<string, string | undefined> {
  const { coder, reviewer, small } = models;
  return specs.some((spec) => spec.model === "small") ? { coder, reviewer, small } : { coder, reviewer };
}

/**
 * The `small` model a wave's task runs with where no setting names one: `defaults.yaml`'s, when it is on the factory
 * models list; else none (Pi's session model). Never a refusal.
 */
export async function defaultSmallModel(): Promise<string | undefined> {
  const { small } = defaultModels();
  return (await loadModels()).includes(small) ? small : undefined;
}

/** `requireModels` as a `refused` error. */
export async function requireFactoryModels(models: Record<string, string | undefined>): Promise<void> {
  try {
    await requireModels(models);
  } catch (error) {
    throw new FactoryError("refused", errorText(error));
  }
}

function storedSettingsParam(raw: unknown, prefix: string): StoredSettings {
  try {
    return parseStoredSettings(raw);
  } catch (error) {
    throw new FactoryError("invalid", `${prefix}${errorText(error)}`);
  }
}

export const SETTINGS_HANDLERS = {
  "models.get": async () => ({ models: await loadModels() }),

  "models.set": async (params) => {
    try {
      await saveModels(params.models as string[]);
    } catch (error) {
      // A file system error (it has a code) is `failed`; a wrong id is the caller's.
      if ((error as NodeJS.ErrnoException).code !== undefined) throw error;
      throw new FactoryError("invalid", `models.set: ${errorText(error)}`);
    }
    return { models: await loadModels() };
  },

  "repos.list": async () => ({ repos: await registeredRepos() }),

  "repos.add": async (params, { cwd }) => {
    const repo = await primaryOf(params.repo as string, cwd);
    if (!(await registeredRepos()).includes(repo)) await saveSettings(repo, {});
    return { repo, repos: await registeredRepos() };
  },

  "repos.remove": async (params, { cwd }) => {
    // A registered path is removed as it is: the repository may be gone from disk.
    const path = repoPath(params.repo as string, cwd);
    const repo = (await registeredRepos()).includes(path) ? path : await primaryOf(path, cwd);
    if (!(await unregisterRepo(repo))) throw new FactoryError("not_found", `${repo} is not registered`);
    return { repos: await registeredRepos() };
  },

  "branches.list": async (params, { cwd }) => {
    const repo = await primaryOf(params.repo as string, cwd);
    const refs = (await git(runCommand, repo, ["for-each-ref", "--format=%(refname)", "refs/heads"])).split("\n").filter((ref) => ref !== "");
    const fallback = await defaultBranch(repo).catch(() => undefined);
    const branches = [];
    for (const ref of refs) {
      const name = ref.slice("refs/heads/".length);
      branches.push({ name, default: name === fallback, hasConfig: await branchHasConfig(repo, name) });
    }
    return { branches };
  },

  "settings.get": async (params, { cwd }) => settingsOf(await primaryOf(params.repo as string, cwd)),

  "settings.set": async (params, { cwd }) => {
    const repo = await primaryOf(params.repo as string, cwd);
    const settings = storedSettingsParam(params.settings, "settings.");
    await requireFactoryModels(settings.models ?? {});
    await saveSettings(repo, settings);
    return settingsOf(repo);
  },

  "config.get": async (params, { cwd }) => {
    const repo = await primaryOf(params.repo as string, cwd);
    const branch = params.branch as string | undefined;
    let text: string | null;
    if (branch !== undefined) {
      if (!(await localBranchExists(repo, branch))) throw new FactoryError("not_found", `${repo} has no local branch ${branch}`);
      text = (await branchHasConfig(repo, branch)) ? await committedText(repo, `refs/heads/${branch}:factory.yaml`) : null;
    } else {
      text = await readFile(join(repo, "factory.yaml"), "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
    }
    if (text !== null) return { exists: true, text, draft: null, source: [] };
    const draft = initDraft(repo);
    return { exists: false, text: null, draft: draft.text, source: draft.source === "" ? [] : draft.source.split(", ") };
  },

  "config.write": async (params, { cwd }) => {
    const repo = await primaryOf(params.repo as string, cwd);
    if (!(await registeredRepos()).includes(repo)) throw new FactoryError("not_found", `${repo} is not registered, add it with repos.add first`);
    const text = params.text as string;
    try {
      parseFactoryYaml(text);
    } catch (error) {
      throw new FactoryError("invalid", errorText(error));
    }
    const path = join(repo, "factory.yaml");
    if (params.overwrite !== true && existsSync(path)) throw new FactoryError("refused", `${path} exists, give overwrite: true to replace it`);
    await writeFile(path, text, "utf8");
    return { path };
  },
} satisfies Record<string, Handler>;
