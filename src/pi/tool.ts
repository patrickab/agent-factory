/**
 * The `factory` tool in Pi: every core action (`core.ts`) for an agent, one tool call per action. Its name, description
 * and schema come from `factory-tool.ts`, which the MCP server (`mcp.ts`) shares.
 *
 * - Provides `registerFactoryTool` (sequential: one call at a time): the answer is the agent view (`agent-view.ts`) as
 *   text, `details` `{result: the full view, card}` (contract `cards`); every failure is an `isError` result, the
 *   agent view's one line (`agentError`), without details
 * - In a task session (`isTaskSession`: Pi started by the runner, or a session holding a `factory-task` entry) only the
 *   actions with `mutates: false` are offered; a mutating one answers as unknown. A task's coder starts a task only
 *   through `factory_new_task` (`followup.ts`)
 * - `scouts.start` takes the `scout` tool's path (`scout-tool.ts`): its report reaches the session once
 * - A call passes the session's id as `origin`: `tasks.start` and `waves.start` record it, notifications go there
 * - Drawn in the TUI as its card (`cards-tui.ts`), the agent's text with the session's switch
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { callFactoryTool, factoryCard, FACTORY_TOOL_DESCRIPTION, FACTORY_TOOL_NAME, factoryToolError, factoryToolParameters } from "../factory-tool.ts";
import { TASK_SESSION_ENV } from "../runner.ts";
import type { ScoutTracker } from "./scout-tool.ts";
import { factoryToolRenderers, type CardSwitch } from "./cards-tui.ts";

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
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const { action, ...rest } = params as Record<string, unknown>;
        if (scouts !== undefined && action === "scouts.start" && !isTaskSession(ctx.sessionManager.getBranch())) {
          const { text, result } = await scouts.call(rest, signal, ctx);
          return { content: [{ type: "text", text }], details: { result, card: factoryCard("scouts.start", rest, result) } };
        }
        const { text, result, card } = await callFactoryTool(params, isTaskSession(ctx.sessionManager.getBranch()), {
          cwd: ctx.cwd,
          signal,
          // The declaring session of a wave (`waves.start`): Pi's public session id.
          origin: ctx.sessionManager.getSessionId(),
          // The key of a decision in the session's log (`decisions.list`): its tool call.
          callId: toolCallId,
        });
        return { content: [{ type: "text", text }], details: { result, card } };
      } catch (error) {
        return { content: [{ type: "text", text: factoryToolError(error) }], details: undefined, isError: true };
      }
    },
  });
}
