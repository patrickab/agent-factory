/** The `factory` CLI as a subprocess against a temp agent dir (`PI_CODING_AGENT_DIR`). */
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionView } from "./factory-tool.ts";
import { ACTIONS } from "./core.ts";

const CLI = join(import.meta.dirname, "cli.ts");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "factory-cli-test-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function factory(args: string[], stdin?: string) {
  const env = { ...process.env, PI_CODING_AGENT_DIR: scratch, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  const result = Bun.spawnSync(["bun", CLI, ...args], { cwd: scratch, env, stdin: stdin === undefined ? "ignore" : Buffer.from(stdin) });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

test("params run the action and print the agent view, --json the full view; invalid input exits 2, a failure 1", () => {
  expect(JSON.parse(factory(["models.set", "-", "--json"], '{"models":["a/b","c/d"]}').stdout)).toEqual({ models: ["a/b", "c/d"] });
  expect(factory(["models.get"])).toEqual({ code: 0, stdout: `${actionView("models.get", {}, { models: ["a/b", "c/d"] }).text}\n`, stderr: "" });
  expect(JSON.parse(factory(["models.get", "{}", "--json"]).stdout)).toEqual({ models: ["a/b", "c/d"] });
  for (const args of [["tasks.nope"], ["models.set", "{models"], ["models.get", "{}", "{}"]]) expect(factory(args)).toMatchObject({ code: 2, stdout: "" });
  expect(factory(["tasks.get", '{"id":"00000000"}', "--json"])).toMatchObject({ code: 1, stdout: "" });
});

test("--help names every action with its summary; --core-path is a file exporting ACTIONS", async () => {
  const help = factory(["--help"]).stdout.split("\n");
  for (const [name, spec] of Object.entries(ACTIONS)) expect(help).toContain(`${name}  ${spec.summary}`);
  const path = factory(["--core-path"]).stdout.trim();
  expect(existsSync(path)).toBe(true);
  expect(Object.keys(((await import(path)) as { ACTIONS: object }).ACTIONS)).toEqual(Object.keys(ACTIONS));
});
