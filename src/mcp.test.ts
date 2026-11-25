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
import { agentError, agentView } from "./agent-view.ts";
import { ACTIONS } from "./core.ts";
import { agentActions, FACTORY_TOOL_DESCRIPTION, factoryToolParameters } from "./factory-tool.ts";
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
  test("lists the one tool factory with the Pi tool's description and schema, hostOnly actions absent", async () => {
    const client = await connected();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["factory"]);
    expect(tools[0].description).toBe(FACTORY_TOOL_DESCRIPTION);
    expect(tools[0].inputSchema).toEqual(factoryToolParameters());
    const offered = (tools[0].inputSchema.properties as { action: { enum: string[] } }).action.enum;
    const hostOnly = Object.entries(ACTIONS).filter(([, spec]) => spec.hostOnly).map(([name]) => name);
    expect(hostOnly.length).toBeGreaterThan(0);
    for (const name of hostOnly) expect(offered).not.toContain(name);
    // The timelines dump a log: programs replay it through the core or the CLI, an agent never calls them.
    expect(offered).not.toContain("tasks.timeline");
    expect(offered).not.toContain("waves.timeline");
    expect((tools[0].inputSchema.properties as Record<string, unknown>).since).toBeUndefined();
    await client.close();
  });

  test("names itself with the package's name and version", async () => {
    const client = await connected();
    const manifest = (await Bun.file(join(import.meta.dirname, "..", "package.json")).json()) as { name: string; version: string };
    expect(client.getServerVersion()).toMatchObject({ name: manifest.name, version: manifest.version });
    await client.close();
  });

  test("a call to a tool other than factory is an error result", async () => {
    const client = await connected();
    const result = await client.callTool({ name: "nope", arguments: { action: "models.get" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(agentError({ code: "invalid", message: 'unknown tool "nope"' }));
    await client.close();
  });

  test("a read action answers the agent view", async () => {
    const client = await connected();
    const result = await client.callTool({ name: "factory", arguments: { action: "models.get" } });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toBe("a/b");
    await client.close();
  });

  test("a timeline is refused as unknown", async () => {
    const client = await connected();
    for (const action of ["tasks.timeline", "waves.timeline"]) {
      const result = await client.callTool({ name: "factory", arguments: { action, id: "x" } });
      expect(result.isError).toBe(true);
      expect(text(result)).toBe(agentError({ code: "invalid", message: `unknown action "${action}"` }));
    }
    await client.close();
  });

  test("a refused call (a FactoryError) is an error result", async () => {
    const client = await connected();
    const result = await client.callTool({ name: "factory", arguments: { action: "repos.remove", repo: scratch } });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(agentError({ code: "not_found", message: `${scratch} is not inside a git repository` }));
    await client.close();
  });

  test("a hostOnly action, or a mutating one in a task session, is refused as unknown", async () => {
    const hostOnly = await connected();
    const imported = await hostOnly.callTool({ name: "factory", arguments: { action: "tasks.import" } });
    expect(imported).toMatchObject({ isError: true });
    expect(text(imported)).toBe(agentError({ code: "invalid", message: 'unknown action "tasks.import"' }));
    await hostOnly.close();

    const taskSession = await connected(true);
    const { tools } = await taskSession.listTools();
    expect((tools[0].inputSchema.properties as { action: { enum: string[] } }).action.enum).toEqual(agentActions(true));
    const set = await taskSession.callTool({ name: "factory", arguments: { action: "models.set", models: [] } });
    expect(text(set)).toBe(agentError({ code: "invalid", message: 'unknown action "models.set"' }));
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
