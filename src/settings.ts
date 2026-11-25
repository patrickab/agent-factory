/**
 * Per-repository task settings the plugin owns, so a task can start without a caller supplying them.
 *
 * - Provides `factoryHome` (the plugin's data directory under Pi's agent dir, found without Pi: `PI_CODING_AGENT_DIR`,
 *   else `~/.pi/agent`, as Pi's `getAgentDir` does)
 * - Provides the settings of a repository, one YAML file per repository named after its URI-encoded path, read and
 *   written (`loadSettings`, `saveSettings`) with the checks a `/factory start` payload has (`parseSettingsFields`)
 *   plus `preview`, a boolean the plugin stores for its clients and never acts on, and `remote`, whether a wave of the
 *   repository is shown on its forge (`remote.ts`; `waves.start` stores it resolved in the wave's declaration). The
 *   file is the repository's registration (`registeredRepos`, `unregisterRepo`)
 * - Provides the default models, `defaults.yaml` at the package root (`loadDefaults`, `defaultModels`): a broken or
 *   missing file throws naming its path. Only a wave's task that asks for `small` where nothing names one reads it
 *   (`core.ts`); no setting resolves over it, so nothing stored still means Pi's session model
 * - Provides `resolveSettings`: defaults < stored < overrides, models merged per name, answered with the names that
 *   are set of `small`, `big`, and the roles' `coder`, `reviewer`
 */
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MODEL_SIZES, normalizeModels, parseSettingsFields, type ModelChoice, type ModelSize, type Settings } from "./state.ts";
import { errorText, isRecord } from "./util.ts";

/**
 * `Settings` as stored or passed: every key optional, `branch` absent = the repository's default branch; `models` in
 * the new names only (`normalizeModels` reads the old ones).
 */
export type StoredSettings = Partial<Omit<Settings, "models">> & { models?: ModelChoice; preview?: boolean; remote?: boolean };

/** The project's `small` and `big` and the task's `coder` and `reviewer`, each only when set: an absent role runs with Pi's session model. */
export type ResolvedModels = Settings["models"];

/** The settings a task gets. */
export type TaskSettings = Settings;

/** The settings a repository's task gets, with `preview` (absent = `false`), which only clients read, and `remote` (absent = `false`). */
export type ResolvedSettings = TaskSettings & { preview: boolean; remote: boolean };

export const DEFAULT_SETTINGS: Readonly<Omit<ResolvedSettings, "branch" | "models">> = { merge: "auto", maxRounds: 2, review: false, preview: false, remote: false };

/** `defaults.yaml` at the root of the package. */
export const DEFAULTS_PATH = join(import.meta.dirname, "..", "defaults.yaml");

/** The project models every repository's settings resolve over. */
export type DefaultModels = { small: string; big: string };

/** Reads `models: {small, big}` from `path`; a missing or broken file throws an `Error` naming it. No cache. */
export function loadDefaults(path = DEFAULTS_PATH): DefaultModels {
  try {
    const raw: unknown = Bun.YAML.parse(readFileSync(path, "utf8"));
    if (!isRecord(raw) || !isRecord(raw.models)) throw new Error("models must be a mapping of small and big");
    const models: Partial<DefaultModels> = {};
    for (const size of MODEL_SIZES) {
      const model = raw.models[size];
      if (typeof model !== "string" || !/^[^/\s]+\/\S+$/.test(model)) throw new Error(`models.${size} must be "provider/model"`);
      models[size] = model;
    }
    return models as DefaultModels;
  } catch (error) {
    throw new Error(`the factory's defaults ${path}: ${errorText(error)}`);
  }
}

let cachedDefaults: DefaultModels | undefined;

/** `loadDefaults()`, read once per process. */
export function defaultModels(): DefaultModels {
  cachedDefaults ??= loadDefaults();
  return cachedDefaults;
}

/** Pi's agent dir: `PI_CODING_AGENT_DIR` (a leading `~` expanded), else `~/.pi/agent`. Read on every call. */
export function agentDir(): string {
  const dir = process.env.PI_CODING_AGENT_DIR;
  if (dir === undefined || dir === "") return join(homedir(), ".pi", "agent");
  if (dir === "~") return homedir();
  return dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir;
}

export function factoryHome(): string {
  return join(agentDir(), "factory");
}

function reposDir(): string {
  return join(factoryHome(), "repos");
}

/** `repo` is the primary checkout's absolute path. Encoded, so no two paths share a file. */
function settingsPath(repo: string): string {
  return join(reposDir(), `${encodeURIComponent(repo)}.yaml`);
}

/** Checks a stored settings value, drops unknown keys. Throws an `Error` naming the first wrong key. */
export function parseStoredSettings(raw: unknown): StoredSettings {
  if (raw === null || raw === undefined) return {};
  if (!isRecord(raw)) throw new Error("settings must be a mapping");
  const { models, ...fields } = parseSettingsFields(raw);
  const settings: StoredSettings = models === undefined ? fields : { ...fields, models: normalizeModels(models) };
  for (const key of ["preview", "remote"] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "boolean") throw new Error(`${key} must be a boolean`);
    settings[key] = raw[key];
  }
  return settings;
}

/** The repositories that have a settings file, sorted. */
export async function registeredRepos(): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(reposDir());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names
    .filter((name) => name.endsWith(".yaml"))
    .map((name) => decodeURIComponent(name.slice(0, -".yaml".length)))
    .sort();
}

/** Removes the repository's settings file; `false` when it had none. */
export async function unregisterRepo(repo: string): Promise<boolean> {
  try {
    await rm(settingsPath(repo));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** A missing file is `{}`. An invalid file throws an `Error` naming the file and the wrong key. */
export async function loadSettings(repo: string): Promise<StoredSettings> {
  const path = settingsPath(repo);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    return parseStoredSettings(Bun.YAML.parse(text));
  } catch (error) {
    throw new Error(`${path}: ${errorText(error)}`);
  }
}

/** Checks `settings` like `loadSettings`, drops unknown keys, writes atomically (temp file in the same dir + rename). */
export async function saveSettings(repo: string, settings: StoredSettings): Promise<void> {
  const path = settingsPath(repo);
  let checked: StoredSettings;
  try {
    checked = parseStoredSettings(settings);
  } catch (error) {
    throw new Error(`${path}: ${errorText(error)}`);
  }
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${Bun.YAML.stringify(checked, null, 2).trimEnd()}\n`, "utf8");
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** `resolveSettings` with the stored `preview` and `remote`. */
export function resolveRepoSettings(stored: StoredSettings, overrides: StoredSettings, branch: string): ResolvedSettings {
  return {
    ...resolveSettings(stored, overrides, branch),
    preview: stored.preview ?? DEFAULT_SETTINGS.preview,
    remote: overrides.remote ?? stored.remote ?? DEFAULT_SETTINGS.remote,
  };
}

/**
 * Defaults < stored < overrides; models merged per name (`resolveModels`). `branch` is used when neither sets one.
 * `size` picks the coder's model (default `big`); the reviewer's is the explicit one, else `big`. Mutates nothing.
 */
export function resolveSettings(stored: StoredSettings, overrides: StoredSettings, branch: string, size: ModelSize = "big"): TaskSettings {
  return {
    branch: overrides.branch ?? stored.branch ?? branch,
    merge: overrides.merge ?? stored.merge ?? DEFAULT_SETTINGS.merge,
    maxRounds: overrides.maxRounds ?? stored.maxRounds ?? DEFAULT_SETTINGS.maxRounds,
    review: overrides.review ?? stored.review ?? DEFAULT_SETTINGS.review,
    models: resolveModels([stored.models, overrides.models], size),
  };
}

/**
 * `layers` merged per name, lowest first; `coder` = the model of `size`, `reviewer` = its own, else `big`. A name no
 * layer sets stays absent (Pi's session model): `defaults.yaml` is never read here.
 */
export function resolveModels(layers: readonly (ModelChoice | undefined)[], size: ModelSize = "big"): ResolvedModels {
  const merged: ModelChoice = {};
  for (const layer of layers) {
    for (const name of ["small", "big", "reviewer"] as const) {
      const model = layer?.[name];
      if (model !== undefined) merged[name] = model;
    }
  }
  const resolved: ResolvedModels = { ...merged };
  const coder = size === "small" ? merged.small : merged.big;
  if (coder !== undefined) resolved.coder = coder;
  const reviewer = merged.reviewer ?? merged.big;
  if (reviewer !== undefined) resolved.reviewer = reviewer;
  return resolved;
}

/** The stored form of resolved models: the sizes, and the reviewer only when it is not `big`. */
export function modelChoice(models: ResolvedModels): ModelChoice {
  return normalizeModels({ small: models.small, big: models.big, reviewer: models.reviewer });
}
