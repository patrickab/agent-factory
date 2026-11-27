import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFactoryConfig } from "./config.ts";
import { initDraft } from "./draft.ts";

const root = mkdtempSync(join(tmpdir(), "factory-draft-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("the template and a draft filled from the repo's targets parse as a factory config", () => {
  expect(parseFactoryConfig(Bun.YAML.parse(initDraft(root).text)).gates).toEqual([]);
  writeFileSync(join(root, "Makefile"), "lint:\n\tx\ntest:\n\ty\n");
  expect(parseFactoryConfig(Bun.YAML.parse(initDraft(root).text)).merge_gates).toEqual([["make", "lint"], ["make", "test"]]);
});
