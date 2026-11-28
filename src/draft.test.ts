import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFactoryConfig } from "./config.ts";
import { fill, initDraft } from "./draft.ts";

const root = mkdtempSync(join(tmpdir(), "factory-draft-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("the draft is the template, filled with the gates of factory/gates.sh when the checkout has it", () => {
  const plain = initDraft(root);
  expect(plain.source).toBe("");
  expect(parseFactoryConfig(Bun.YAML.parse(plain.text)).gates).toEqual([]);
  mkdirSync(join(root, "factory"));
  writeFileSync(join(root, "factory/gates.sh"), "");
  const filled = initDraft(root);
  expect(filled.source).toBe("factory/gates.sh");
  const config = parseFactoryConfig(Bun.YAML.parse(filled.text));
  expect(config.gates).toEqual([["bash", "factory/gates.sh", "--changed", "--reuse", "lint", "types"]]);
  expect(config.merge_gates).toEqual([["bash", "factory/gates.sh", "--changed", "--reuse"]]);
});

test("fill fills the key it is given, whatever the order of the template", () => {
  const text = fill("merge_gates: []\ngates: []\n", "gates", ["a"]);
  expect(Bun.YAML.parse(text)).toEqual({ merge_gates: [], gates: [["a"]] });
});
