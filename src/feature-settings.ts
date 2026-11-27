/** Models, repositories, branches, settings and factory.yaml (`core-settings.ts`). */
import { SETTINGS_HANDLERS } from "./core-settings.ts";
import { card, fenced, type CardRow } from "./cards.ts";
import { plural } from "./agent-view.ts";
import type { Params } from "./core-shared.ts";
import { feature, REPO, spec } from "./feature.ts";
import { schemaOf } from "./settings.ts";
import type { Handlers } from "./feature.ts";

type SettingsAnswer = { stored: Record<string, unknown>; resolved: Record<string, unknown>; defaults: Record<string, unknown> };

/** `key: value`, `models.big: x`; `(default)` after a value not stored. */
function settingsRows(answer: SettingsAnswer, only?: Set<string>): CardRow[] {
  const rows: CardRow[] = [];
  const add = (label: string, value: unknown, stored: boolean) => rows.push({ label, text: `${String(value)}${stored ? "" : " (default)"}` });
  for (const [key, value] of Object.entries(answer.resolved)) {
    if (only !== undefined && !only.has(key)) continue;
    if (value === null || typeof value !== "object") {
      add(key, value, key in answer.stored);
      continue;
    }
    const stored = (answer.stored[key] ?? {}) as Record<string, unknown>;
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) add(key, "none", key in answer.stored);
    for (const [inner, innerValue] of entries) add(`${key}.${inner}`, innerValue, inner in stored);
  }
  return rows;
}

export const SETTINGS = feature({
  name: "settings",
  actions: {
    "models.get": spec("The factory models: the provider/model ids tasks and repository settings may use", {}, [], false, (_params, result: { models: string[] }) =>
      card("action", "quiet", result.models.length === 0 ? "no models set" : "models", { rows: result.models.map((model) => ({ label: "model", text: model })) }),
    ),
    "models.set": spec(
      "Replace the factory models",
      { models: { type: "array", items: { type: "string" }, description: "provider/model ids" } },
      ["models"],
      true,
      (_params, result: { models: string[] }) => card("action", "quiet", `${plural(result.models.length, "model")} set`, { rows: result.models.map((model) => ({ label: "model", text: model })) }),
    ),
    "repos.list": spec("The registered repositories (those with a settings file)", {}, [], false, (_params, result: { repos: string[] }) =>
      card("action", "quiet", result.repos.length === 0 ? "no repositories registered" : (result.repos.length === 1 ? "1 repository" : `${result.repos.length} repositories`), { rows: result.repos.map((repo) => ({ label: "repository", text: repo })) }),
    ),
    "repos.add": spec("Register a repository: give it a settings file", { repo: REPO }, ["repo"], true, (_params, result: { repo: string }) => card("action", "quiet", `registered ${result.repo}`)),
    "branches.list": spec("The repository's local branches", { repo: REPO }, ["repo"], false, (_params, result: { branches: { name: string }[] }) =>
      card("action", "quiet", result.branches.length === 0 ? "no branches" : (result.branches.length === 1 ? "1 branch" : `${result.branches.length} branches`), {
        rows: result.branches.map((branch) => ({ label: "branch", text: branch.name })),
      }),
    ),
    "settings.get": spec("The repository's stored settings, them resolved over the defaults, and the defaults", { repo: REPO }, ["repo"], false, (_params, result: SettingsAnswer) =>
      card("action", "quiet", "settings", { rows: settingsRows(result) }),
    ),
    "settings.set": spec(
      "Replace the repository's stored settings",
      { repo: REPO, settings: { type: "object", description: "The stored settings", properties: schemaOf("repo") } },
      ["repo", "settings"],
      true,
      (params, result: SettingsAnswer) => {
        const rows = settingsRows(result, new Set(Object.keys((params.settings ?? {}) as Params)));
        return card("action", "quiet", rows.length === 0 ? "settings set: every value is the default" : "settings set", { rows });
      },
    ),
    "config.get": spec(
      "The repository's factory.yaml (the working copy) and a draft when it has none",
      { repo: REPO },
      ["repo"],
      false,
      (_params, result: { exists: boolean; text: string | null; draft: string | null; source: string[] }) =>
        result.exists
          ? card("action", "quiet", "factory.yaml", { rows: [{ label: "from", text: "working copy" }], text: fenced(result.text, "yaml") })
          : card("action", "quiet", "no factory.yaml: a draft", { rows: result.source.length > 0 ? [{ label: "from", text: result.source.join(", ") }] : [], text: fenced(result.draft, "yaml") }),
    ),
    "config.write": spec(
      "Check factory.yaml text and write it into a registered repository's checkout (not committed)",
      {
        repo: REPO,
        text: { type: "string", description: "The factory.yaml text" },
        overwrite: { type: "boolean", description: "Replace an existing factory.yaml" },
      },
      ["repo", "text"],
      true,
      () => card("action", "quiet", "wrote factory.yaml (not committed)"),
    ),
  },
  get handlers(): Handlers {
    return SETTINGS_HANDLERS;
  },
});
