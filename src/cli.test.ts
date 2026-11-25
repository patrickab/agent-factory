/**
 * The `factory` CLI as a subprocess against a temp agent dir (`PI_CODING_AGENT_DIR`) and throwaway git repos.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTIONS } from "./core.ts";

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

function factory(args: string[], options: { agent: string; cwd?: string; stdin?: string }) {
  const result = Bun.spawnSync(["bun", CLI, ...args], {
    cwd: options.cwd ?? scratch,
    env: { ...process.env, PI_CODING_AGENT_DIR: options.agent, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
  });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

describe("factory <action>", () => {
  test("params given as an argument run the action and print its result as JSON; no params mean {}", () => {
    const agent = agentDir();
    const set = factory(["models.set", '{"models":["a/b","c/d"]}'], { agent });
    expect(set).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(set.stdout)).toEqual({ models: ["a/b", "c/d"] });
    const get = factory(["models.get"], { agent });
    expect(get.code).toBe(0);
    expect(JSON.parse(get.stdout)).toEqual({ models: ["a/b", "c/d"] });
  });

  test("- reads the params from stdin", () => {
    const agent = agentDir();
    const set = factory(["models.set", "-"], { agent, stdin: '{"models":["x/y"]}\n' });
    expect(set.code).toBe(0);
    expect(JSON.parse(set.stdout)).toEqual({ models: ["x/y"] });
  });

  test("the repo defaults to the caller's directory", () => {
    const agent = agentDir();
    const repo = makeRepo();
    const added = factory(["repos.add"], { agent, cwd: repo });
    expect(added.code).toBe(0);
    expect(JSON.parse(added.stdout)).toEqual({ repo, repos: [repo] });
  });

  test("invalid JSON params exit 2 with an invalid error on stderr", () => {
    const result = factory(["models.set", "{models"], { agent: agentDir() });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toStartWith("factory: invalid: params are not valid JSON");
  });

  test("an unknown action exits 2", () => {
    const result = factory(["tasks.nope"], { agent: agentDir() });
    expect(result).toEqual({ code: 2, stdout: "", stderr: 'factory: invalid: unknown action "tasks.nope"\n' });
  });

  test("a FactoryError other than invalid exits 1 with its code and message on stderr", () => {
    const repo = makeRepo();
    const result = factory(["repos.remove"], { agent: agentDir(), cwd: repo });
    expect(result).toEqual({ code: 1, stdout: "", stderr: `factory: not_found: ${repo} is not registered\n` });
  });

  test("more than one params argument is a usage error", () => {
    const result = factory(["models.get", "{}", "{}"], { agent: agentDir() });
    expect(result.code).toBe(2);
    expect(result.stderr).toStartWith("usage: factory");
  });
});

describe("factory commands", () => {
  test("actions prints the ACTIONS map as JSON", () => {
    const result = factory(["actions"], { agent: agentDir() });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(JSON.parse(JSON.stringify(ACTIONS)));
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
