/** The draft `factory.yaml`: the shipped template, its gates filled from `factory/gates.sh` when the checkout has it. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const GATES_SCRIPT = "factory/gates.sh";
export const TEMPLATE_PATH = join(import.meta.dirname, "factory.template.yaml");

/** Fills the empty list of `key` (a whole line, so `gates` never matches inside `merge_gates`). */
export const fill = (text: string, key: string, argv: string[]) => text.replace(new RegExp(`^${key}: \\[\\]$`, "m"), `${key}:\n  - ${JSON.stringify(argv)}`);

/** `source` is the script the gates come from, empty when the template is left as it is. */
export function initDraft(root: string): { text: string; source: string } {
  const template = readFileSync(TEMPLATE_PATH, "utf-8");
  if (!existsSync(join(root, GATES_SCRIPT))) return { text: template, source: "" };
  const base = ["bash", GATES_SCRIPT, "--changed", "--reuse"];
  const filled = fill(fill(template, "gates", [...base, "lint", "types"]), "merge_gates", base);
  return { text: `# Drafted from ${GATES_SCRIPT}. Review it, then commit it.\n${filled}`, source: GATES_SCRIPT };
}
