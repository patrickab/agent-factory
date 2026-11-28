/** The factory models list in a scratch agent dir. */
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadModels, modelsPath, requireModels, saveModels } from "./models.ts";
import { restoreEnv } from "./core-test-kit.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "factory-models-test-")));
const savedEnv = { ...process.env };
let caseCount = 0;
beforeEach(() => {
  process.env.PI_CODING_AGENT_DIR = join(scratch, `case-${++caseCount}`, "agent");
});
afterEach(() => restoreEnv(savedEnv));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("missing reads as []; saveModels writes the list deduplicated, atomically; an invalid id or file is refused and the old list stays", async () => {
  expect(await loadModels()).toEqual([]);
  await saveModels(["a/b", "c/d-1:x", "a/b"]);
  expect(await loadModels()).toEqual(["a/b", "c/d-1:x"]);
  expect(readdirSync(dirname(modelsPath()))).toEqual(["models.yaml"]);
  for (const id of ["sonnet", "/b", "a/", "a b/c", ""]) await expect(saveModels([id])).rejects.toThrow();
  expect(await loadModels()).toEqual(["a/b", "c/d-1:x"]);
  writeFileSync(modelsPath(), "- a/b\n- bare\n");
  await expect(loadModels()).rejects.toThrow();
});

test("requireModels: an empty list is refused; a model on the list and an unset role pass; one not on it is refused", async () => {
  await expect(requireModels({})).rejects.toThrow();
  await saveModels(["a/b", "c/d"]);
  await requireModels({ coder: undefined, reviewer: "c/d" });
  await expect(requireModels({ coder: "a/b", reviewer: "x/y" })).rejects.toThrow();
});
