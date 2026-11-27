import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callFactoryTool } from "./factory-tool.ts";
import { loadModels } from "./models.ts";

let dir: string;
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.PI_CODING_AGENT_DIR;
  dir = mkdtempSync(join(tmpdir(), "factory-tool-"));
  process.env.PI_CODING_AGENT_DIR = dir;
});

afterEach(() => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

test("a view that fails to render after a mutating action succeeded is a receipt, not a failure", async () => {
  const broken = () => {
    throw new Error("unexpected shape\nmore");
  };
  const { text, result } = await callFactoryTool({ action: "models.set", models: ["a/b"] }, false, {}, broken);
  expect(await loadModels()).toEqual(["a/b"]);
  expect(result).toEqual({ models: ["a/b"] });
  expect(text).toStartWith("models.set done");
});
