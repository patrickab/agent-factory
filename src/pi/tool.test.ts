/**
 * The `factory` tool: its schema comes from `ACTIONS`, a call goes through `callAction` and answers the agent view, a
 * failure is an `isError` result. The actions themselves are tested in `core.test.ts`, the views in `agent-view.test.ts`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentError, agentView } from "../agent-view.ts";
import { actionCard } from "../cards.ts";
import { ACTIONS } from "../core.ts";
import { TASK_SESSION_ENV } from "../runner.ts";
import { agentActions, factoryToolParameters } from "../factory-tool.ts";
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

describe("factoryToolParameters", () => {
  test("action is the enum of the ACTIONS that are not a timeline, every param of those is a property", () => {
    const parameters = factoryToolParameters();
    expect(parameters.required).toEqual(["action"]);
    const offered = (Object.keys(ACTIONS) as (keyof typeof ACTIONS)[]).filter((name) => !name.endsWith(".timeline"));
    expect(parameters.properties.action.enum).toEqual(offered);
    expect(parameters.properties.record).toBeUndefined();
    for (const name of offered) {
      for (const key of Object.keys(ACTIONS[name as keyof typeof ACTIONS].params.properties)) expect(parameters.properties[key]).toBeDefined();
    }
    expect(parameters.properties.force.type).toBe("boolean");
    expect(parameters.properties.overrides.properties).toBeDefined();
  });

  test("the timelines are not offered: not in the enum, nor their since param, nor the description", () => {
    for (const taskSession of [false, true]) {
      const { properties } = factoryToolParameters(taskSession);
      expect(properties.action.enum).not.toContain("tasks.timeline");
      expect(String(properties.action.description)).not.toContain("timeline");
      expect(properties.since).toBeUndefined();
    }
    expect(registered().description).not.toContain("timeline");
  });

  test("the tool describes tags and tasks.wait", () => {
    const tool = registered();
    expect(tool.description).toContain("tasks.wait");
    expect(tool.description).toContain("tag");
    expect(tool.promptSnippet).toContain("tasks.wait");
    const { properties } = factoryToolParameters();
    expect(String(properties.tag.description)).toContain("tasks.wait: ");
    expect(properties.timeoutMs.maximum).toBe(3_600_000);
  });

  test("a param several actions share names them; one with different meanings names each", () => {
    const { properties } = factoryToolParameters();
    expect(String(properties.force.description)).toBe("tasks.remove, waves.remove: Also drop commits its target branch lacks and uncommitted changes");
    // Task ids and wave ids mean different things: each action is named.
    expect(String(properties.id.description)).toContain("tasks.get: The task id");
    expect(String(properties.id.description)).toContain("waves.get: The wave id");
    expect(String(properties.text.description)).toContain("config.write: The factory.yaml text");
    expect(String(properties.text.description)).toContain("tasks.message: The message");
  });
});

describe("registerFactoryTool", () => {
  test("the tool factory, sequential, with the parameters from ACTIONS", () => {
    const tool = registered();
    expect(tool.name).toBe("factory");
    expect(tool.parameters).toEqual(factoryToolParameters());
    expect(tool.executionMode).toBe("sequential");
  });

  test("a result is the agent view as text, {result: the full view, card} as details", async () => {
    const result = await registered().execute("call-1", { action: "repos.list" }, undefined, undefined, ctx());
    expect(result).toEqual({
      content: [{ type: "text", text: agentView("repos.list", {}, { repos: [] }) }],
      details: { result: { repos: [] }, card: actionCard("repos.list", {}, { repos: [] }) },
    });
    expect(result.content[0].text).toBe("no repositories registered (repos.add)");
    expect(result.details.card).toEqual({ v: 1, kind: "action", tone: "quiet", title: "no repositories registered" });
  });

  test("a caller error is an isError result, the agent view's one line, not a throw", async () => {
    const tool = registered();
    const result = await tool.execute("call-2", { action: "tasks.get", id: "nothing" }, undefined, undefined, ctx());
    const text = agentError({ code: "not_found", message: 'no task has an id starting with "nothing"' });
    expect(text).toBe('not_found: no task has an id starting with "nothing" · next: tasks.list');
    expect(result).toEqual({ content: [{ type: "text", text }], details: undefined, isError: true });
    const unknown = await tool.execute("call-3", { action: "status" }, undefined, undefined, ctx());
    expect(unknown.content[0].text).toBe(agentError({ code: "invalid", message: 'unknown action "status"' }));
  });

  test("the timeline is unknown to the agent", async () => {
    const result = await registered().execute("call-10", { action: "tasks.timeline", id: "x" }, undefined, undefined, ctx());
    expect(result.isError).toBe(true);
  });

  test("models.get and models.set reach the core through the tool; models is an array of strings", async () => {
    const tool = registered();
    expect(tool.parameters.properties.models.type).toBe("array");
    const set = await tool.execute("call-5", { action: "models.set", models: ["a/b", "a/b"] }, undefined, undefined, ctx());
    expect(set.details.result).toEqual({ models: ["a/b"] });
    const get = await tool.execute("call-6", { action: "models.get" }, undefined, undefined, ctx());
    expect(get.details.result).toEqual({ models: ["a/b"] });
    expect(get.details.card).toEqual({ v: 1, kind: "action", tone: "quiet", title: "models", rows: [{ label: "model", text: "a/b" }] });
    expect(get.content[0].text).toBe("a/b");
    const bad = await tool.execute("call-7", { action: "models.set", models: ["bare"] }, undefined, undefined, ctx());
    expect(bad).toEqual({ content: [{ type: "text", text: agentError({ code: "invalid", message: 'models.set: "bare" is not a provider/model id' }) }], details: undefined, isError: true });
  });
});

describe("the factory tool in a task session", () => {
  const taskBranch = [{ type: "custom", customType: "factory-task", data: {} }];
  const readOnly = (Object.keys(ACTIONS) as (keyof typeof ACTIONS)[]).filter((name) => !ACTIONS[name].mutates && !name.endsWith(".timeline"));

  test("a session holding a factory-task entry, or Pi started by the runner, is a task session", () => {
    expect(isTaskSession([])).toBe(false);
    expect(isTaskSession(taskBranch)).toBe(true);
    process.env[TASK_SESSION_ENV] = "1";
    try {
      expect(isTaskSession([])).toBe(true);
    } finally {
      delete process.env[TASK_SESSION_ENV];
    }
  });

  test("offers only the actions with mutates: false", () => {
    expect(agentActions(true)).toEqual(readOnly);
    expect(factoryToolParameters(true).properties.action.enum).toEqual(readOnly);
    expect(readOnly).toContain("tasks.get");
    expect(readOnly).toContain("tasks.wait");
    expect(readOnly).not.toContain("tasks.start");
  });

  test("Pi started by the runner registers the tool with the read-only actions", () => {
    process.env[TASK_SESSION_ENV] = "1";
    try {
      expect(registered().parameters.properties.action.enum).toEqual(readOnly);
    } finally {
      delete process.env[TASK_SESSION_ENV];
    }
  });

  test("a mutating action answers as unknown, a reading one works", async () => {
    const tool = registered();
    for (const action of ["tasks.start", "models.set", "tasks.message"]) {
      const result = await tool.execute("call-8", { action, repo: scratch, title: "t", request: "r", models: ["a/b"] }, undefined, undefined, ctx(taskBranch));
      expect(result).toEqual({ content: [{ type: "text", text: agentError({ code: "invalid", message: `unknown action "${action}"` }) }], details: undefined, isError: true });
    }
    const list = await tool.execute("call-9", { action: "repos.list" }, undefined, undefined, ctx(taskBranch));
    expect(list.isError).toBeUndefined();
  });
});
