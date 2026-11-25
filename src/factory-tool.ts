/**
 * The `factory` tool as every harness offers it (the Pi extension's `pi/tool.ts`, the MCP server `mcp.ts`): its name,
 * description and JSON schema, built from `ACTIONS`, so the harnesses cannot drift apart.
 *
 * - `agentActions`: every `ACTIONS` name but the `hostOnly` ones; in a task session only those with `mutates: false`
 * - `factoryToolParameters`: `action` (one of them) plus the union of their params
 * - `callFactoryTool`: one tool call, `{action, ...params}`, refusing an action the agent is not offered
 */
import { ACTIONS, callAction, FactoryError, type ActionName, type CallOptions } from "./core.ts";
import { isRecord } from "./util.ts";

type Schema = Record<string, unknown>;

export const FACTORY_TOOL_NAME = "factory";

export const FACTORY_TOOL_DESCRIPTION =
  'Hand a self-contained coding task to a background factory run: it codes in its own git worktree, runs the repo\'s gates and merges when they pass. Use it in a git repository whose target branch has a committed factory.yaml; "tasks.start" returns at once with the task. Give related tasks one tag (path segments like "plugin/m1/w1"; default the system user) and filter "tasks.list" by a tag or its prefix. Instead of polling "tasks.get", block on "tasks.wait" (ids or tag): it answers once every watched task rests or one needs attention (waiting for approve or for an answer, blocked, cancelled, interrupted), or at its timeout. For a planned set of tasks declare a wave once: "waves.start" (repo, tag, title, request = the reviewer\'s instructions, tasks [{key, title, request, after: keys}]) creates the wave\'s branch off the target, starts each task once those it waits for are done, then reviews the whole branch and merges it into the target (its stage: building, reviewing, rejected, merging, waiting_approve, merged, blocked, cancelled); "waves.add" adds tasks (a rejected wave builds again), "waves.get", "waves.list" (by tag prefix) and "waves.timeline" show it. Use tasks.approve, tasks.retry, tasks.cancel, tasks.message and tasks.remove as a task\'s state asks.';

/** The actions an agent may call: every one but the `hostOnly` ones; in a task session only those with `mutates: false`. */
export function agentActions(taskSession = false): ActionName[] {
  return (Object.keys(ACTIONS) as ActionName[]).filter((name) => !ACTIONS[name].hostOnly && !(taskSession && ACTIONS[name].mutates));
}

/** `action` and the union of the actions' params. A param several actions share names each of them in its description. */
export function factoryToolParameters(taskSession = false): { type: "object"; required: ["action"]; properties: Record<string, Schema> } {
  const names = agentActions(taskSession);
  const shared = new Map<string, { schema: Schema; uses: { action: ActionName; description: unknown }[] }>();
  for (const name of names) {
    for (const [key, schema] of Object.entries(ACTIONS[name].params.properties as Record<string, Schema>)) {
      const entry = shared.get(key) ?? { schema, uses: [] };
      entry.uses.push({ action: name, description: schema.description });
      shared.set(key, entry);
    }
  }
  const properties: Record<string, Schema> = {
    action: { type: "string", enum: names, description: names.map((name) => `${name}: ${ACTIONS[name].summary}`).join(". ") },
  };
  for (const [key, { schema, uses }] of shared) {
    const descriptions = new Set(uses.map((use) => use.description));
    const description =
      descriptions.size === 1 && uses[0].description !== undefined
        ? `${uses.map((use) => use.action).join(", ")}: ${String(uses[0].description)}`
        : uses.map((use) => (use.description === undefined ? use.action : `${use.action}: ${String(use.description)}`)).join(". ");
    properties[key] = { ...schema, description };
  }
  return { type: "object", required: ["action"], properties };
}

/** Runs one `factory` tool call. A host-only action, or a mutating one in a task session, is as unknown as a made-up one. */
export async function callFactoryTool(params: unknown, taskSession: boolean, options: CallOptions): Promise<unknown> {
  const { action, ...rest } = isRecord(params) ? params : {};
  const name = String(action);
  if (!(agentActions(taskSession) as string[]).includes(name)) throw new FactoryError("invalid", `unknown action "${name}"`);
  return callAction(name, rest, options);
}
