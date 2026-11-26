/** Models, repositories, branches, settings and factory.yaml (`core-settings.ts`). */
import { SETTINGS_HANDLERS } from "./core-settings.ts";
import { card, type CardRow } from "./cards.ts";
import { plural } from "./agent-view.ts";
import type { Params } from "./core-shared.ts";
import { feature, REMOTE, REPO, SETTINGS_PROPERTIES, spec } from "./feature.ts";
import type { Handlers } from "./feature.ts";

type SettingsAnswer = { stored: Record<string, unknown>; resolved: Record<string, unknown>; defaults: Record<string, unknown> };

/** The lines of `settingsLines` as card rows: `key: value` split at the first `: `. */
function settingsRows(lines: string[]): CardRow[] {
  return lines.map((line) => {
    const at = line.indexOf(": ");
    return at < 0 ? { label: line, text: "" } : { label: line.slice(0, at), text: line.slice(at + 2) };
  });
}

const fencedYaml = (text: string | null): string | undefined => (text === null || text.trim() === "" ? undefined : `\`\`\`yaml\n${text.trimEnd()}\n\`\`\``);

/** `key: value`, `models.coder: x`; `(default)` after a value not stored. */
function settingsLines(answer: SettingsAnswer, only?: Set<string>): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(answer.resolved)) {
    if (only !== undefined && !only.has(key)) continue;
    if (value !== null && typeof value === "object") {
      const stored = (answer.stored[key] ?? {}) as Record<string, unknown>;
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) lines.push(`${key}: none${key in answer.stored ? "" : " (default)"}`);
      for (const [inner, innerValue] of entries) {
        // `big` only repeats `coder` (its alias).
        if (key === "models" && inner === "big") continue;
        lines.push(`${key}.${inner}: ${String(innerValue)}${inner in stored ? "" : " (default)"}`);
      }
      continue;
    }
    lines.push(`${key}: ${String(value)}${key in answer.stored ? "" : " (default)"}`);
  }
  return lines;
}

export const SETTINGS = feature({
  name: "settings",
  actions: {
    "models.get": spec("The factory models: the provider/model ids tasks and repository settings may use", {}, [], false),
    "models.set": spec(
      "Replace the factory models",
      { models: { type: "array", items: { type: "string" }, description: "provider/model ids" } },
      ["models"],
      true,
    ),
    "repos.list": spec("The registered repositories (those with a settings file)", {}, [], false),
    "repos.add": spec("Register a repository: give it a settings file", { repo: REPO }, ["repo"], true),
    "repos.remove": spec("Unregister a repository: remove its settings file", { repo: REPO }, ["repo"], true),
    "branches.list": spec("The repository's local branches, its default one and which hold a committed factory.yaml", { repo: REPO }, ["repo"], false),
    "settings.get": spec("The repository's stored settings, them resolved over the defaults, and the defaults", { repo: REPO }, ["repo"], false),
    "settings.set": spec(
      "Replace the repository's stored settings",
      { repo: REPO, settings: { type: "object", description: "The stored settings", properties: { ...SETTINGS_PROPERTIES, preview: { type: "boolean" }, remote: REMOTE } } },
      ["repo", "settings"],
      true,
    ),
    "config.get": spec(
      "The repository's factory.yaml (the working copy, or committed on branch) and a draft when it has none",
      { repo: REPO, branch: { type: "string", description: "Read factory.yaml as committed on this branch" } },
      ["repo"],
      false,
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
    ),
  },
  get handlers(): Handlers {
    return SETTINGS_HANDLERS;
  },
  renderers: {
    "models.get": (_params, result: { models: string[] }) => (result.models.length === 0 ? "no models set (models.set)" : result.models.join("\n")),
    "models.set": (_params, result: { models: string[] }) => `${plural(result.models.length, "model")} set`,
    "repos.list": (_params, result: { repos: string[] }) => (result.repos.length === 0 ? "no repositories registered (repos.add)" : result.repos.join("\n")),
    "repos.add": (_params, result: { repo: string }) => `registered ${result.repo}`,
    "repos.remove": (params) => `unregistered ${String(params.repo)}`,
    "branches.list": (_params, result: { branches: { name: string; default: boolean; hasConfig: boolean }[] }) =>
      result.branches.length === 0
        ? "no branches"
        : result.branches
            .map((branch) => {
              const marks = [branch.default ? "default" : null, branch.hasConfig ? "factory.yaml" : null].filter((mark) => mark !== null);
              return marks.length === 0 ? branch.name : `${branch.name} (${marks.join(", ")})`;
            })
            .join(" · "),
    "settings.get": (_params, result: SettingsAnswer) => settingsLines(result).join("\n"),
    "settings.set": (params, result: SettingsAnswer) => {
      const changed = new Set(Object.keys((params.settings ?? {}) as Params));
      const lines = settingsLines(result, changed);
      return lines.length === 0 ? "settings set: every value is the default" : ["settings set:", ...lines.map((line) => `  ${line}`)].join("\n");
    },
    "config.get": (params, result: { exists: boolean; text: string | null; draft: string | null; source: string[] }) => {
      if (result.exists) {
        const where = typeof params.branch === "string" ? `committed on ${params.branch}` : "working copy";
        return `factory.yaml (${where})\n${(result.text ?? "").trimEnd()}`;
      }
      const from = result.source.length > 0 ? `, a draft from ${result.source.join(", ")}` : ", a draft";
      return `no factory.yaml${from}:\n${(result.draft ?? "").trimEnd()}`;
    },
    "config.write": () => "wrote factory.yaml (not committed)",
  },
  cards: {
    "models.get": (_params, result: { models: string[] }) => card("action", "quiet", result.models.length === 0 ? "no models set" : "models", { rows: result.models.map((model) => ({ label: "model", text: model })) }),
    "models.set": (_params, result: { models: string[] }) => card("action", "quiet", `${plural(result.models.length, "model")} set`, { rows: result.models.map((model) => ({ label: "model", text: model })) }),
    "repos.list": (_params, result: { repos: string[] }) =>
      card("action", "quiet", result.repos.length === 0 ? "no repositories registered" : (result.repos.length === 1 ? "1 repository" : `${result.repos.length} repositories`), { rows: result.repos.map((repo) => ({ label: "repository", text: repo })) }),
    "repos.add": (_params, result: { repo: string }) => card("action", "quiet", `registered ${result.repo}`),
    "repos.remove": (params) => card("action", "quiet", `unregistered ${String(params.repo)}`),
    "branches.list": (_params, result: { branches: { name: string; default: boolean; hasConfig: boolean }[] }) =>
      card("action", "quiet", result.branches.length === 0 ? "no branches" : (result.branches.length === 1 ? "1 branch" : `${result.branches.length} branches`), {
        rows: result.branches.map((branch) => ({ label: branch.name, text: [branch.default ? "default" : null, branch.hasConfig ? "factory.yaml" : null].filter((mark) => mark !== null).join(", ") || "-" })),
      }),
    "settings.get": (_params, result: SettingsAnswer) => card("action", "quiet", "settings", { rows: settingsRows(settingsLines(result)) }),
    "settings.set": (params, result: SettingsAnswer) => {
      const rows = settingsRows(settingsLines(result, new Set(Object.keys((params.settings ?? {}) as Params))));
      return card("action", "quiet", rows.length === 0 ? "settings set: every value is the default" : "settings set", { rows });
    },
    "config.get": (params, result: { exists: boolean; text: string | null; draft: string | null; source: string[] }) =>
      result.exists
        ? card("action", "quiet", "factory.yaml", { rows: [{ label: "from", text: typeof params.branch === "string" ? `committed on ${params.branch}` : "working copy" }], text: fencedYaml(result.text) })
        : card("action", "quiet", "no factory.yaml: a draft", { rows: result.source.length > 0 ? [{ label: "from", text: result.source.join(", ") }] : [], text: fencedYaml(result.draft) }),
    "config.write": () => card("action", "quiet", "wrote factory.yaml (not committed)"),
  },
});
