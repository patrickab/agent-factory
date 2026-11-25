/**
 * The `factory` tool in Pi: every core action (`core.ts`) for an agent, one tool call per action. Its name, description
 * and schema come from `factory-tool.ts`, which the MCP server (`mcp.ts`) shares.
 *
 * - Provides `registerFactoryTool` (sequential: one call at a time): the answer is the action's result as JSON text
 *   and as `details`; every failure is an `isError` result of one sentence starting `factory: `
 * - In a task session (`isTaskSession`: Pi started by the runner, or a session holding a `factory-task` entry) only the
 *   actions with `mutates: false` are offered; a mutating one answers as unknown. A task's coder starts a task only
 *   through `factory_new_task` (`followup.ts`)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { callFactoryTool, FACTORY_TOOL_DESCRIPTION, FACTORY_TOOL_NAME, factoryToolParameters } from "../factory-tool.ts";
import { TASK_SESSION_ENV } from "../runner.ts";
import { errorText } from "../util.ts";

/** Whether the tool runs in a factory task's session: Pi started by the runner, or a session branch holding a `factory-task` entry. */
export function isTaskSession(branch: Iterable<{ type: string }>): boolean {
  if (process.env[TASK_SESSION_ENV] === "1") return true;
  for (const entry of branch) if (entry.type === "custom" && (entry as { customType?: unknown }).customType === "factory-task") return true;
  return false;
}

export function registerFactoryTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: FACTORY_TOOL_NAME,
    label: "Factory",
    description: FACTORY_TOOL_DESCRIPTION,
    promptSnippet: "Run a self-contained coding task in the background in a git repo with a factory.yaml; wait for it with tasks.wait or check it with tasks.get",
    // The runner's environment is known at load; a session that gets its task later is checked per call.
    parameters: factoryToolParameters(process.env[TASK_SESSION_ENV] === "1"),
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const result = await callFactoryTool(params, isTaskSession(ctx.sessionManager.getBranch()), { cwd: ctx.cwd, signal });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
      } catch (error) {
        return { content: [{ type: "text", text: `factory: ${errorText(error)}` }], details: undefined, isError: true };
      }
    },
  });
}
