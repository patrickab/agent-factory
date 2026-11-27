/**
 * The MCP server against a temp agent dir (`PI_CODING_AGENT_DIR`): an in-process client for the tool's behaviour, and
 * one stdio subprocess for the `factory-mcp` binary.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { agentView } from "./agent-view.ts";
import { factoryToolParameters } from "./factory-tool.ts";
import { factoryMcpServer } from "./mcp.ts";
import { TASK_SESSION_ENV } from "./runner.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "factory-mcp-test-")));
const agent = join(scratch, "agent");
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

beforeEach(() => {
  rmSync(agent, { recursive: true, force: true });
  mkdirSync(join(agent, "factory"), { recursive: true });
  writeFileSync(join(agent, "factory", "models.yaml"), "- a/b\n");
  process.env.PI_CODING_AGENT_DIR = agent;
});

afterEach(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

async function connected(taskSession = false): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await factoryMcpServer({ cwd: scratch, taskSession }).connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

const text = (result: unknown) => ((result as CallToolResult).content[0] as { text: string }).text;

describe("factory-mcp", () => {
  test("lists the one tool factory; a read answers the agent view; a refusal, or a mutation in a task session, is an error result", async () => {
    const client = await connected();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["factory"]);
    expect(tools[0].inputSchema).toEqual(factoryToolParameters());
    const read = await client.callTool({ name: "factory", arguments: { action: "models.get" } });
    expect([Boolean(read.isError), text(read)]).toEqual([false, agentView("models.get", {}, { models: ["a/b"] })]);
    expect((await client.callTool({ name: "factory", arguments: { action: "repos.add", repo: scratch } })).isError).toBe(true);
    expect((await client.callTool({ name: "nope", arguments: { action: "models.get" } })).isError).toBe(true);
    await client.close();

    const taskSession = await connected(true);
    expect((await taskSession.callTool({ name: "factory", arguments: { action: "models.set", models: [] } })).isError).toBe(true);
    await taskSession.close();
  });

  test("the factory-mcp binary serves the tool over stdio", async () => {
    const repo = join(scratch, "repo");
    execFileSync("git", ["init", "--quiet", "-b", "main", repo]);
    const transport = new StdioClientTransport({
      command: "bun",
      args: [join(import.meta.dirname, "mcp.ts")],
      cwd: repo,
      // Not a task session, even when a coder runs this from its task's Pi (the gates no longer inherit the variable).
      env: { ...(process.env as Record<string, string>), [TASK_SESSION_ENV]: "", PI_CODING_AGENT_DIR: agent, GIT_CONFIG_GLOBAL: "/dev/null" },
      stderr: "pipe",
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["factory"]);
    // No repo given: the server's directory is the repo.
    const added = await client.callTool({ name: "factory", arguments: { action: "repos.add" } });
    expect(text(added)).toBe(agentView("repos.add", {}, { repo, repos: [repo] }));
    await client.close();
  });
});
