/**
 * The core's actions on what a repository is set up with: models, repositories, branches, settings, `factory.yaml`.
 * - `settings.set` refuses a model not on the factory models list, and anything while it is empty; reads never check it
 * - `config.write` checks the text before it writes it, and never commits
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFactoryYaml } from "./config.ts";
import { primaryOf, type Handler } from "./core-shared.ts";
import { initDraft } from "./draft.ts";
import { git } from "./git.ts";
import { defaultBranch, targetOf } from "./launch.ts";
import { loadModels, requireModels, saveModels } from "./models.ts";
import { runCommand } from "./run.ts";
import { checkSettings, defaultModels, loadSettings, registeredRepos, resolveSettings, saveSettings, type ResolvedSettings, type SizeModels, type StoredSettings } from "./settings.ts";
import { errorText, FactoryError, ifMissing } from "./util.ts";
import type { WaveTaskEntry } from "./waves.ts";

async function settingsOf(repo: string): Promise<{ stored: StoredSettings; resolved: ResolvedSettings; defaults: ResolvedSettings }> {
  const stored = await loadSettings(repo);
  const fallback = await defaultBranch(repo).catch(() => undefined);
  const branch = await targetOf(repo, undefined, { config: false });
  return { stored, resolved: resolveSettings([stored], branch), defaults: resolveSettings([], fallback ?? branch) };
}

/** The models a wave's `specs` run with that a setting names: `big` for coders and the reviewer, `small` only when a task asks for it. */
export function wantedModels(models: SizeModels, specs: readonly WaveTaskEntry[]): Record<string, string | undefined> {
  const { big, reviewer, small } = models;
  return specs.some((spec) => spec.model === "small") ? { big, reviewer, small } : { big, reviewer };
}

/**
 * The `small` model a wave's task runs with where no setting names one: `defaults.yaml`'s, when it is on the factory
 * models list; else none (Pi's session model). Never a refusal.
 */
export async function defaultSmallModel(): Promise<string | undefined> {
  const { small } = defaultModels();
  return (await loadModels()).includes(small) ? small : undefined;
}

export const SETTINGS_HANDLERS = {
  "models.get": async () => ({ models: await loadModels() }),

  "models.set": async (params) => {
    await saveModels(params.models as string[]);
    return { models: await loadModels() };
  },

  "repos.list": async () => ({ repos: await registeredRepos() }),

  "repos.add": async (params, { cwd }) => {
    const repo = await primaryOf(params.repo as string, cwd);
    if (!(await registeredRepos()).includes(repo)) await saveSettings(repo, {});
    return { repo, repos: await registeredRepos() };
  },

  "branches.list": async (params, { cwd }) => {
    const repo = await primaryOf(params.repo as string, cwd);
    const refs = (await git(runCommand, repo, ["for-each-ref", "--format=%(refname)", "refs/heads"])).split("\n").filter((ref) => ref !== "");
    return { branches: refs.map((ref) => ({ name: ref.slice("refs/heads/".length) })) };
  },

  "settings.get": async (params, { cwd }) => settingsOf(await primaryOf(params.repo as string, cwd)),

  "settings.set": async (params, { cwd }) => {
    const repo = await primaryOf(params.repo as string, cwd);
    const settings = checkSettings(params.settings, "repo", "settings.");
    await requireModels(settings.models ?? {});
    await saveSettings(repo, settings);
    return settingsOf(repo);
  },

  "config.get": async (params, { cwd }) => {
    const repo = await primaryOf(params.repo as string, cwd);
    const text = await ifMissing(readFile(join(repo, "factory.yaml"), "utf8"), null);
    if (text !== null) return { exists: true, text, draft: null, source: [] };
    const draft = initDraft(repo);
    return { exists: false, text: null, draft: draft.text, source: draft.source === "" ? [] : [draft.source] };
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
