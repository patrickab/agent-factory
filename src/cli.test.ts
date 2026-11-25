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

describe("factory as the host", () => {
  const ID = "11111111-2222-3333-4444-555555555555";

  /** A task record of a linked worktree that never started: no runner, no state, so it never rests. */
  function importableRecord() {
    const repo = makeRepo();
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--allow-empty", "-m", "init"]);
    const worktree = join(scratch, `wt-${counter}`);
    execFileSync("git", ["-C", repo, "worktree", "add", "--quiet", "-b", "task", worktree]);
    return { id: ID, repo, worktree, branch: "task", title: "t", sessionId: "test-session-s", sessionDir: join(scratch, `sessions-${counter}`), createdAt: "2026-01-01T00:00:00.000Z" };
  }

  test("runs the hostOnly tasks.import: refuses a record whose worktree is the primary checkout, registers a linked one", () => {
    const agent = agentDir();
    const record = importableRecord();
    const refused = factory(["tasks.import", JSON.stringify({ record: { ...record, worktree: record.repo, branch: "main" } })], { agent });
    expect(refused).toEqual({ code: 1, stdout: "", stderr: `factory: refused: tasks.import: ${record.repo} is not a linked worktree of ${record.repo}\n` });
    const imported = factory(["tasks.import", JSON.stringify({ record })], { agent });
    expect(imported.code).toBe(0);
    expect(JSON.parse(imported.stdout)).toMatchObject({ id: ID, state: null });
  });

  test("SIGINT aborts a blocking tasks.wait: exit 1, failed", async () => {
    const agent = agentDir();
    expect(factory(["tasks.import", JSON.stringify({ record: importableRecord() })], { agent }).code).toBe(0);
    const wait = Bun.spawn(["bun", CLI, "tasks.wait", JSON.stringify({ ids: [ID] })], { cwd: scratch, env: cliEnv(agent), stdout: "pipe", stderr: "pipe" });
    await Bun.sleep(1000);
    expect(wait.exitCode).toBeNull();
    wait.kill("SIGINT");
    expect(await wait.exited).toBe(1);
    expect(await new Response(wait.stdout).text()).toBe("");
    expect(await new Response(wait.stderr).text()).toBe("factory: failed: tasks.wait was aborted\n");
  });
});
