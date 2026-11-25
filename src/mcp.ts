#!/usr/bin/env bun
/**
 * `factory-mcp`: the `factory` tool (`factory-tool.ts`, the one the Pi extension offers) over MCP on stdio, so other
 * harnesses reach the factory without Pi. It holds no factory logic: a call goes through `callFactoryTool`.
 *
 * - The answer is the agent view (`agent-view.ts`) as text; a failure is an error result, the agent view's one line
 * - Started by a task's runner (`TASK_SESSION_ENV`), it offers only the actions with `mutates: false`, as the Pi tool does
 * - `cwd` of a call is the server's directory, the harness's working directory
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { callFactoryTool, FACTORY_TOOL_DESCRIPTION, FACTORY_TOOL_NAME, factoryToolError, factoryToolParameters } from "./factory-tool.ts";
import { FactoryError } from "./core.ts";
import { TASK_SESSION_ENV } from "./runner.ts";
import manifest from "../package.json" with { type: "json" };

/** The MCP server with the `factory` tool; `cwd` is where a call's repo defaults to. */
export function factoryMcpServer(options: { cwd: string; taskSession: boolean }): Server {
  const server = new Server({ name: manifest.name, version: manifest.version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [{ name: FACTORY_TOOL_NAME, description: FACTORY_TOOL_DESCRIPTION, inputSchema: factoryToolParameters(options.taskSession) }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    try {
      if (request.params.name !== FACTORY_TOOL_NAME) throw new FactoryError("invalid", `unknown tool "${request.params.name}"`);
      const { text } = await callFactoryTool(request.params.arguments ?? {}, options.taskSession, { cwd: options.cwd, signal: extra.signal });
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { content: [{ type: "text", text: factoryToolError(error) }], isError: true };
    }
  });
  return server;
}

if (import.meta.main) {
  await factoryMcpServer({ cwd: process.cwd(), taskSession: process.env[TASK_SESSION_ENV] === "1" }).connect(new StdioServerTransport());
}
