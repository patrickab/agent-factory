/**
 * package.json is what `bun link`, Pi and importers read: a typo in a target would pass every other test.
 */
import { describe, expect, test } from "bun:test";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name: string;
  version: string;
  exports: Record<string, string>;
  bin: Record<string, string>;
  pi: { extensions: string[] };
};

describe("package.json", () => {
  test("names the package agent-factory with a semver version", () => {
    expect(manifest.name).toBe("agent-factory");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("exports, bin and pi.extensions point at existing files", () => {
    expect(manifest.exports).toEqual({ ".": "./src/core.ts" });
    expect(Object.keys(manifest.bin).sort()).toEqual(["factory", "factory-mcp"]);
    expect(manifest.pi.extensions.length).toBeGreaterThan(0);
    for (const target of [...Object.values(manifest.exports), ...Object.values(manifest.bin), ...manifest.pi.extensions]) {
      expect(existsSync(join(root, target))).toBe(true);
    }
  });

  test("each bin is executable and starts with the bun shebang", () => {
    for (const target of Object.values(manifest.bin)) {
      const path = join(root, target);
      expect(() => accessSync(path, constants.X_OK)).not.toThrow();
      expect(readFileSync(path, "utf8").split("\n")[0]).toBe("#!/usr/bin/env bun");
    }
  });
});
