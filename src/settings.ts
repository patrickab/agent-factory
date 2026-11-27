/**
 * Per-repository task settings the plugin owns, so a task can start without a caller supplying them.
 *
 * - Provides `factoryHome` (the plugin's data directory under Pi's agent dir, found without Pi: `PI_CODING_AGENT_DIR`,
 *   else `~/.pi/agent`, as Pi's `getAgentDir` does)
 * - Provides `SETTINGS`, the one table of the settings: per key its schema (which `checkSettings` checks and the action
 *   schemas show, `schemaOf`), its default and the scopes it may be given in: `repo` (stored), `task` and `wave`
 *   (overrides). `preview` the plugin stores for its clients and never acts on; `squash`: a wave lands as one commit
 *   (`merge.ts`; stored in the wave's declaration only when on). Models name sizes: `big`, `small` (a wave's easy
 *   tasks), `reviewer`; a task's record names roles (`taskModels`). `extensions`: the coder's Pi extensions (`runner.ts`)
 * - Provides the settings of a repository, one YAML file per repository named after its URI-encoded path, read and
 *   written (`loadSettings`, `saveSettings`). The file is the repository's registration (`registeredRepos`)
 * - Provides the default models, `defaults.yaml` at the package root (`loadDefaults`, `defaultModels`): a broken or
 *   missing file throws naming its path. Only a wave's task that asks for `small` where nothing names one reads it
 *   (`core.ts`); no setting resolves over it, so nothing stored still means Pi's session model
 * - Provides `resolveSettings`: the table's defaults < each layer, models merged per name
 */
import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Schema } from "./feature.ts";
import type { Settings } from "./state.ts";
import { errorText, FactoryError, ifMissing, isRecord, writeAtomic } from "./util.ts";

/** The highest `maxRounds` a task may run with. */
export const MAX_ROUNDS_LIMIT = 20;
/** The two models a project names: `big` for coders, `small` for a wave's easy tasks. */
export const MODEL_SIZES = ["small", "big"] as const;
export type ModelSize = (typeof MODEL_SIZES)[number];

export type Scope = "repo" | "task" | "wave";
const MODEL: Schema = { type: "string", pattern: "^[^/\\s]+/\\S+$", description: "provider/model; absent: Pi's session model" };
const ALL: Scope[] = ["repo", "task", "wave"];

/** Every setting, once: its schema, its default (none: resolved elsewhere), the scopes that take it. */
export const SETTINGS: Record<string, { schema: Schema; default?: unknown; scopes: Scope[] }> = {
  branch: { schema: { type: "string", description: "The branch the task starts from and merges into" }, scopes: ALL },
  merge: { schema: { type: "string", enum: ["auto", "review"], description: "auto: merge a passed round. review: wait for approve" }, default: "auto", scopes: ALL },
  maxRounds: { schema: { type: "integer", minimum: 1, maximum: MAX_ROUNDS_LIMIT }, default: 2, scopes: ALL },
  review: { schema: { type: "boolean", description: "Run the reviewer on every round" }, default: false, scopes: ALL },
  models: {
    schema: { type: "object", properties: { big: MODEL, small: { ...MODEL, description: "provider/model for a wave's easy tasks (model small)" }, reviewer: MODEL } },
    default: {},
    scopes: ALL,
  },
  preview: { schema: { type: "boolean" }, default: false, scopes: ["repo"] },
  squash: {
    schema: { type: "boolean", description: "Land a wave as one commit (its title, its commits' subjects), its task commits kept under refs/factory/waves/<tag>-<id>" },
    default: false,
    scopes: ["repo", "wave"],
  },
  extensions: {
    schema: {
      type: "array",
      items: { type: "string" },
      description:
        "Extension sources the coder's Pi loads, as Pi's -e takes them (npm:pi-lens, a path, builtin:codemode). Absent: every user extension. Set, an empty list too: Pi starts with -ne, the factory's plugin and these; -ne also turns off Pi's built-in extensions (mcp, llama.cpp, codemode, tool-search) unless listed as builtin:<name>",
    },
    scopes: ["repo"],
  },
};

export type SizeModels = Partial<Record<ModelSize | "reviewer", string>>;
/** Settings as stored or given: every key optional, `branch` absent = the repository's default branch. */
export type StoredSettings = Partial<Omit<Settings, "models">> & { models?: SizeModels; preview?: boolean; squash?: boolean; extensions?: string[] };
export type ResolvedSettings = Required<Omit<StoredSettings, "extensions">> & Pick<StoredSettings, "extensions">;

/** The table's schemas of `scope`, for an action's parameters. */
export function schemaOf(scope: Scope): Record<string, Schema> {
  return Object.fromEntries(Object.entries(SETTINGS).flatMap(([key, row]) => (row.scopes.includes(scope) ? [[key, row.schema]] : [])));
}

/** `value` checked against `schema` (the kinds the table uses); an object loses unknown and absent keys. Throws `invalid` naming `name`. */
export function checkValue(schema: Schema, value: unknown, name: string): unknown {
  const fail = (what: string): never => {
    throw new FactoryError("invalid", `${name} must be ${what}`);
  };
  if (schema.type === "boolean" && typeof value !== "boolean") fail("a boolean");
  if (schema.type === "integer" && (typeof value !== "number" || !Number.isInteger(value) || value < (schema.minimum as number) || value > (schema.maximum as number))) {
    fail(`an integer from ${schema.minimum} to ${schema.maximum}`);
  }
  if (schema.type === "string") {
    const allowed = schema.enum as string[] | undefined;
    if (allowed !== undefined && !allowed.includes(value as string)) fail(allowed.map((one) => JSON.stringify(one)).join(" or "));
    if (typeof value !== "string" || value.trim() === "") fail("a non-empty string");
    // The table's only pattern is a model's.
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value as string)) fail('"provider/model"');
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) fail("a list");
    return (value as unknown[]).map((item, index) => checkValue(schema.items as Schema, item, `${name}[${index}]`));
  }
  if (schema.type !== "object") return value;
  if (!isRecord(value)) return fail("a mapping");
  const checked: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(schema.properties as Record<string, Schema>)) {
    if (value[key] !== undefined) checked[key] = checkValue(inner, value[key], `${name}.${key}`);
  }
  return checked;
}

/** The keys of `raw` that `scope` takes, checked; others dropped. Nothing is `{}`. `prefix` goes before a wrong key's name. */
export function checkSettings(raw: unknown, scope: Scope, prefix = ""): StoredSettings {
  if (raw === null || raw === undefined) return {};
  const keys = Object.keys(SETTINGS).filter((key) => SETTINGS[key].scopes.includes(scope));
  const schema = { type: "object", properties: Object.fromEntries(keys.map((key) => [key, SETTINGS[key].schema])) };
  return checkValue(schema, raw, prefix === "" ? "settings" : prefix.slice(0, -1)) as StoredSettings;
}

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
      models[size] = checkValue(MODEL, raw.models[size], `models.${size}`) as string;
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

/** The repositories that have a settings file, sorted. */
export async function registeredRepos(): Promise<string[]> {
  return (await ifMissing(readdir(reposDir()), []))
    .filter((name) => name.endsWith(".yaml"))
    .map((name) => decodeURIComponent(name.slice(0, -".yaml".length)))
    .sort();
}

/** A missing file is `{}`. An invalid file throws an `Error` naming the file and the wrong key. */
export async function loadSettings(repo: string): Promise<StoredSettings> {
  const path = settingsPath(repo);
  const text = await ifMissing(readFile(path, "utf8"), "");
  try {
    return checkSettings(Bun.YAML.parse(text), "repo");
  } catch (error) {
    throw new Error(`${path}: ${errorText(error)}`);
  }
}

/** Checks `settings` like `loadSettings`, drops unknown keys, writes atomically (temp file in the same dir + rename). */
export async function saveSettings(repo: string, settings: StoredSettings): Promise<void> {
  const path = settingsPath(repo);
  let checked: StoredSettings;
  try {
    checked = checkSettings(settings, "repo");
  } catch (error) {
    throw new Error(`${path}: ${errorText(error)}`);
  }
  await writeAtomic(path, `${Bun.YAML.stringify(checked, null, 2).trimEnd()}\n`);
}

/** Each key: the last layer that sets it, else the table's default; `branch` when none sets one. Models merged per name. */
export function resolveSettings(layers: readonly StoredSettings[], branch: string): ResolvedSettings {
  const resolved: Record<string, unknown> = { branch };
  for (const [key, row] of Object.entries(SETTINGS)) {
    if ("default" in row) resolved[key] = row.default;
    for (const layer of layers as Record<string, unknown>[]) {
      if (layer[key] !== undefined) resolved[key] = key === "models" ? { ...(resolved.models as object), ...(layer.models as object) } : layer[key];
    }
  }
  return resolved as ResolvedSettings;
}

/** The one rule from sizes to roles: the coder runs `size`'s model (`small` where none is named: `big`), the reviewer its own. */
export function taskModels(models: SizeModels, size: ModelSize = "big"): Settings["models"] {
  const coder = (size === "small" ? models.small : undefined) ?? models.big;
  return { ...(coder === undefined ? {} : { coder }), ...(models.reviewer === undefined ? {} : { reviewer: models.reviewer }) };
}
