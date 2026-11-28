/**
 * The `factory` tool in Pi: every core action for an agent, one tool call per action. Its name, description, schema
 * and answer come from `factory-tool.ts`, which the MCP server shares.
 * - Sequential: one call at a time. Every failure is an `isError` result without details
 * - In a task session only the actions with `mutates: false` are offered
 * - A call passes the session's id as `origin`: `tasks.start` and `waves.start` record it, notifications go there
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { actionView, callFactoryTool, FACTORY_TOOL_DESCRIPTION, FACTORY_TOOL_NAME, factoryToolError, factoryToolParameters } from "../factory-tool.ts";
import { TASK_SESSION_ENV } from "../runner.ts";
import type { ScoutTracker } from "./scout-tool.ts";
import { factoryToolRenderers, type CardSwitch } from "./cards-tui.ts";

/** A Pi tool's text result, and its error form. */
export const toolText = (text: string, details: unknown = undefined) => ({ content: [{ type: "text" as const, text }], details });
export const toolError = (text: string) => ({ ...toolText(text), isError: true });

/** Whether the tool runs in a factory task's session: Pi started by the runner, or a session branch holding a `factory-task` entry. */
export function isTaskSession(branch: Iterable<{ type: string }>): boolean {
  if (process.env[TASK_SESSION_ENV] === "1") return true;
  for (const entry of branch) if (entry.type === "custom" && (entry as { customType?: unknown }).customType === "factory-task") return true;
  return false;
}

/** `view`: the session's card switch (`registerCardRenderers`), shared with the notices. */
export function registerFactoryTool(pi: ExtensionAPI, scouts?: ScoutTracker, view: CardSwitch = { agentText: false }): void {
  pi.registerTool({
    name: FACTORY_TOOL_NAME,
    label: "Factory",
    description: FACTORY_TOOL_DESCRIPTION,
    promptSnippet: "Run a self-contained coding task in the background in a git repo with a factory.yaml; wait for it with tasks.wait or check it with tasks.get",
    // The runner's environment is known at load; a session that gets its task later is checked per call.
    parameters: factoryToolParameters(process.env[TASK_SESSION_ENV] === "1"),
    executionMode: "sequential",
    ...factoryToolRenderers(view),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const { action, ...rest } = params as Record<string, unknown>;
        if (scouts !== undefined && action === "scouts.start" && !isTaskSession(ctx.sessionManager.getBranch())) {
          const { text, result } = await scouts.call(rest, signal, ctx);
          return toolText(text, { result, card: actionView("scouts.start", rest, result).card });
        }
        const { text, result, card } = await callFactoryTool(params, isTaskSession(ctx.sessionManager.getBranch()), {
          cwd: ctx.cwd,
          signal,
          // The declaring session of a wave (`waves.start`): Pi's public session id.
          origin: ctx.sessionManager.getSessionId(),
        });
        return toolText(text, { result, card });
      } catch (error) {
        return toolError(factoryToolError(error));
      }
    },
  });
}
