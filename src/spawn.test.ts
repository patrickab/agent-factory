import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnDetached } from "./spawn.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(systemdRunBody: string): { dir: string; systemdRun: string; marker: string; command: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "factory-spawn-"));
  dirs.push(dir);
  const systemdRun = join(dir, "systemd-run");
  writeFileSync(systemdRun, `#!/bin/sh\n${systemdRunBody}\n`);
  chmodSync(systemdRun, 0o755);
  const marker = join(dir, "ran");
  return { dir, systemdRun, marker, command: ["sh", "-c", `echo ran >> '${marker}'`] };
}

async function lines(path: string): Promise<string[]> {
  for (let tries = 0; tries < 50; tries++) {
    try {
      return readFileSync(path, "utf8").trim().split("\n");
    } catch {
      await Bun.sleep(20);
    }
  }
  return [];
}

describe("spawnDetached", () => {
  test("a systemd-run that fails at once (no user manager) falls back to the plain detached spawn", async () => {
    const { dir, systemdRun, marker, command } = fixture("echo 'Failed to connect to bus' >&2; exit 1");
    const pid = await spawnDetached(command, { ...process.env, XDG_RUNTIME_DIR: dir }, join(dir, "log"), dir, systemdRun);
    expect(pid).toBeNumber();
    expect(await lines(marker)).toEqual(["ran"]);
    expect(readFileSync(join(dir, "log"), "utf8")).toContain("Failed to connect to bus");
  });

  test("a working scope runs the command once", async () => {
    const { dir, systemdRun, marker, command } = fixture('while [ "$1" != "--" ]; do shift; done; shift; exec "$@"');
    await spawnDetached(command, { ...process.env, XDG_RUNTIME_DIR: dir }, join(dir, "log"), dir, systemdRun);
    await Bun.sleep(300);
    expect(await lines(marker)).toEqual(["ran"]);
  });
});
