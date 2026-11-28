/**
 * The `factory-mcp` binary over stdio against a temp agent dir (`PI_CODING_AGENT_DIR`); the tool's behaviour itself:
 * `pi/tool.test.ts`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { actionView } from "./factory-tool.ts";
import { TASK_SESSION_ENV } from "./runner.ts";
import { restoreEnv } from "./core-test-kit.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "factory-mcp-test-")));
const agent = join(scratch, "agent");
const savedEnv = { ...process.env };
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

beforeEach(() => {
  rmSync(agent, { recursive: true, force: true });
  mkdirSync(join(agent, "factory"), { recursive: true });
  writeFileSync(join(agent, "factory", "models.yaml"), "- a/b\n");
  process.env.PI_CODING_AGENT_DIR = agent;
});

afterEach(() => restoreEnv(savedEnv));

const text = (result: unknown) => ((result as CallToolResult).content[0] as { text: string }).text;

describe("factory-mcp", () => {
  test("the factory-mcp binary serves the tool over stdio; an unknown tool is an error result", async () => {
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
    expect(text(added)).toBe(actionView("repos.add", {}, { repo, repos: [repo] }).text);
    expect((await client.callTool({ name: "nope", arguments: { action: "models.get" } })).isError).toBe(true);
    await client.close();
  });
});
