/**
 * The `factory` CLI as a subprocess against a temp agent dir (`PI_CODING_AGENT_DIR`) and throwaway git repos.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentActions, agentError, agentView } from "./agent-view.ts";
import { ACTIONS, callAction } from "./core.ts";

const CLI = join(import.meta.dirname, "cli.ts");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "factory-cli-test-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;

/** A fresh agent dir per case, so no case sees another's models or repos. */
function agentDir(): string {
  counter += 1;
  const dir = join(scratch, `agent-${counter}`);
  mkdirSync(dir);
  return dir;
}

function makeRepo(): string {
  counter += 1;
  const repo = join(scratch, `repo-${counter}`);
  mkdirSync(repo);
  execFileSync("git", ["init", "--quiet", "-b", "main", repo]);
  return repo;
}

const cliEnv = (agent: string) => ({ ...process.env, PI_CODING_AGENT_DIR: agent, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" });

function factory(args: string[], options: { agent: string; cwd?: string; stdin?: string }) {
  const result = Bun.spawnSync(["bun", CLI, ...args], {
    cwd: options.cwd ?? scratch,
    env: cliEnv(options.agent),
    stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
  });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

describe("factory <action>", () => {
  test("params given as an argument run the action; it prints the agent view; no params mean {}", () => {
    const agent = agentDir();
    const set = factory(["models.set", '{"models":["a/b","c/d"]}'], { agent });
    expect(set).toEqual({ code: 0, stdout: "2 models set\n", stderr: "" });
    const get = factory(["models.get"], { agent });
    expect(get).toEqual({ code: 0, stdout: `${agentView("models.get", {}, { models: ["a/b", "c/d"] })}\n`, stderr: "" });
    expect(get.stdout).toBe("a/b\nc/d\n");
  });

  test("--json, anywhere after the action, prints the full view: callAction's result as JSON", async () => {
    const agent = agentDir();
    const set = factory(["models.set", "--json", '{"models":["a/b","c/d"]}'], { agent });
    expect(set).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(set.stdout)).toEqual({ models: ["a/b", "c/d"] });
    const get = factory(["models.get", "--json"], { agent });
    expect(get.code).toBe(0);
    const saved = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agent;
    try {
      expect(JSON.parse(get.stdout)).toEqual(await callAction("models.get", {}));
    } finally {
      process.env.PI_CODING_AGENT_DIR = saved;
    }
    const after = factory(["models.get", "{}", "--json"], { agent });
    expect(JSON.parse(after.stdout)).toEqual({ models: ["a/b", "c/d"] });
  });

  test("- reads the params from stdin", () => {
    const agent = agentDir();
    const set = factory(["models.set", "-", "--json"], { agent, stdin: '{"models":["x/y"]}\n' });
    expect(set.code).toBe(0);
    expect(JSON.parse(set.stdout)).toEqual({ models: ["x/y"] });
  });

  test("the repo defaults to the caller's directory", () => {
    const agent = agentDir();
    const repo = makeRepo();
    const added = factory(["repos.add", "--json"], { agent, cwd: repo });
    expect(added.code).toBe(0);
    expect(JSON.parse(added.stdout)).toEqual({ repo, repos: [repo] });
    expect(factory(["repos.list"], { agent }).stdout).toBe(`${agentView("repos.list", {}, { repos: [repo] })}\n`);
  });

  test("invalid JSON params exit 2 with an invalid error on stderr", () => {
    const result = factory(["models.set", "{models"], { agent: agentDir() });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toStartWith("factory: invalid: params are not valid JSON");
  });

  test("an unknown action exits 2; the agent view's error names the way out, --json gives code and message only", () => {
    const result = factory(["tasks.nope"], { agent: agentDir() });
    expect(result).toEqual({ code: 2, stdout: "", stderr: `factory: ${agentError({ code: "invalid", message: 'unknown action "tasks.nope"' })}\n` });
    const json = factory(["tasks.nope", "--json"], { agent: agentDir() });
    expect(json).toEqual({ code: 2, stdout: "", stderr: 'factory: invalid: unknown action "tasks.nope"\n' });
  });

  test("a FactoryError other than invalid exits 1 with its code and message on stderr", () => {
    const params = JSON.stringify({ id: "00000000" });
    const result = factory(["tasks.get", params, "--json"], { agent: agentDir() });
    expect([result.code, result.stdout, result.stderr.startsWith("factory: not_found: ")]).toEqual([1, "", true]);
    const agentResult = factory(["tasks.get", params], { agent: agentDir() });
    expect([agentResult.code, agentResult.stderr.includes(" · next: ")]).toEqual([1, true]);
  });

  test("more than one params argument is a usage error", () => {
    const result = factory(["models.get", "{}", "{}"], { agent: agentDir() });
    expect(result.code).toBe(2);
    expect(result.stderr).toStartWith("usage: factory");
  });
});

describe("factory commands", () => {
  test("actions prints one line per action; actions <name> one action in full; --json the ACTIONS map", () => {
    const list = factory(["actions"], { agent: agentDir() });
    expect(list).toEqual({ code: 0, stdout: `${agentActions(ACTIONS)}\n`, stderr: "" });
    expect(list.stdout.trim().split("\n")).toHaveLength(Object.keys(ACTIONS).length);
    const one = factory(["actions", "tasks.start"], { agent: agentDir() });
    expect(one).toEqual({ code: 0, stdout: `${agentActions(ACTIONS, "tasks.start")}\n`, stderr: "" });
    const unknown = factory(["actions", "tasks.nope"], { agent: agentDir() });
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toStartWith("factory: not_found: no action tasks.nope");
    const json = factory(["actions", "--json"], { agent: agentDir() });
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual(JSON.parse(JSON.stringify(ACTIONS)));
  });

  test("--core-path prints an existing file whose import exports ACTIONS", async () => {
    const result = factory(["--core-path"], { agent: agentDir() });
    expect(result.code).toBe(0);
    const path = result.stdout.trim();
    expect(result.stdout).toBe(`${path}\n`);
    expect(existsSync(path)).toBe(true);
    const core = (await import(path)) as { ACTIONS: unknown };
    expect(Object.keys(core.ACTIONS as object)).toEqual(Object.keys(ACTIONS));
  });

  test("--help prints one line per action with its summary", () => {
    const result = factory(["--help"], { agent: agentDir() });
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split("\n");
    for (const [name, spec] of Object.entries(ACTIONS)) expect(lines).toContain(`${name}  ${spec.summary}`);
  });
});

describe("factory as the host", () => {
  const ID = "11111111-2222-3333-4444-555555555555";

  /** A task record that never started: no runner, no state, so it never rests. */
  function writeRecord(agent: string): void {
    mkdirSync(join(agent, "factory", "tasks"), { recursive: true });
    const record = { id: ID, repo: scratch, worktree: join(scratch, "wt"), branch: "task", title: "t", sessionId: "test-session-s", sessionDir: join(scratch, "sessions"), createdAt: "2026-01-01T00:00:00.000Z", tag: "t", plan: null, wave: null, origin: null };
    writeFileSync(join(agent, "factory", "tasks", `${ID}.json`), JSON.stringify(record));
  }

  test("the timelines print JSON without --json: programs replay them", () => {
    const agent = agentDir();
    writeRecord(agent);
    const timeline = factory(["tasks.timeline", JSON.stringify({ id: ID })], { agent });
    expect(timeline).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(timeline.stdout)).toEqual({ entries: [], next: 0 });
  });

  test("SIGINT aborts a blocking tasks.wait: exit 1, failed", async () => {
    const agent = agentDir();
    writeRecord(agent);
    const wait = Bun.spawn(["bun", CLI, "tasks.wait", JSON.stringify({ ids: [ID] }), "--json"], { cwd: scratch, env: cliEnv(agent), stdout: "pipe", stderr: "pipe" });
    await Bun.sleep(1000);
    expect(wait.exitCode).toBeNull();
    wait.kill("SIGINT");
    expect(await wait.exited).toBe(1);
    expect(await new Response(wait.stdout).text()).toBe("");
    expect(await new Response(wait.stderr).text()).toBe("factory: failed: tasks.wait was aborted\n");
  });
});
