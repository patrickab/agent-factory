/**
 * The `factory` tool: its schema comes from `ACTIONS`, a call goes through `callAction` and answers the agent view, a
 * failure is an `isError` result. The actions themselves are tested in `core.test.ts`, the views in `agent-view.test.ts`.
 */
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ACTIONS } from "../core.ts";
import { TASK_SESSION_ENV } from "../runner.ts";
import { isTaskSession, registerFactoryTool } from "./tool.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "factory-tool-test-")));
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
// A coder runs these tests from its task's Pi, which has the task-session variable (the gates no longer inherit it).
const savedTaskSession = process.env[TASK_SESSION_ENV];

beforeEach(() => {
  process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
  delete process.env[TASK_SESSION_ENV];
});

afterEach(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  if (savedTaskSession === undefined) delete process.env[TASK_SESSION_ENV];
  else process.env[TASK_SESSION_ENV] = savedTaskSession;
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The tool call context: `branch` = the session's entries. */
function ctx(branch: { type: string; customType?: string; data?: unknown }[] = []) {
  return { cwd: scratch, sessionManager: { getBranch: () => branch, getSessionId: () => "session-1" } };
}

function registered() {
  let tool: any;
  registerFactoryTool({ registerTool: (definition: unknown) => (tool = definition) } as unknown as ExtensionAPI);
  return tool;
}

test("the schema is ACTIONS without the timelines, every param of those a property", () => {
  const parameters = registered().parameters;
  const offered = (Object.keys(ACTIONS) as (keyof typeof ACTIONS)[]).filter((name) => !name.endsWith(".timeline"));
  expect(parameters.properties.action.enum).toEqual(offered);
  for (const name of offered) {
    for (const key of Object.keys(ACTIONS[name].params.properties)) expect(parameters.properties[key]).toBeDefined();
  }
});

test("a caller error, an unknown action or a timeline is an isError result, not a throw", async () => {
  const tool = registered();
  for (const params of [{ action: "tasks.get", id: "nothing" }, { action: "status" }, { action: "tasks.timeline", id: "x" }]) {
    expect((await tool.execute("call", params, undefined, undefined, ctx())).isError).toBe(true);
  }
});

test("a task session, by its factory-task entry or the runner's variable, offers and answers only the read-only actions", async () => {
  const taskBranch = [{ type: "custom", customType: "factory-task", data: {} }];
  const readOnly = (Object.keys(ACTIONS) as (keyof typeof ACTIONS)[]).filter((name) => !ACTIONS[name].mutates && !name.endsWith(".timeline"));
  expect(isTaskSession([])).toBe(false);
  expect(isTaskSession(taskBranch)).toBe(true);
  const tool = registered();
  for (const action of ["tasks.start", "models.set", "tasks.message"]) {
    const result = await tool.execute("call", { action, repo: scratch, title: "t", request: "r", models: ["a/b"] }, undefined, undefined, ctx(taskBranch));
    expect(result.isError).toBe(true);
  }
  expect((await tool.execute("call", { action: "repos.list" }, undefined, undefined, ctx(taskBranch))).isError).toBeUndefined();
  process.env[TASK_SESSION_ENV] = "1";
  expect(registered().parameters.properties.action.enum).toEqual(readOnly);
});
