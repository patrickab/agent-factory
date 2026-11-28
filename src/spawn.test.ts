import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { until } from "./core-test-kit.ts";
import { spawnDetached } from "./spawn.ts";

const savedPath = process.env.PATH;
const dirs: string[] = [];
afterEach(() => {
  process.env.PATH = savedPath;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Spawns a command that writes its pid, with a fake `systemd-run` first on PATH; resolves once the pid is written. */
async function spawnWith(systemdRunBody: string): Promise<{ pid: number | undefined; ran: string }> {
  const dir = mkdtempSync(join(tmpdir(), "factory-spawn-"));
  dirs.push(dir);
  writeFileSync(join(dir, "systemd-run"), `#!/bin/sh\n${systemdRunBody}\n`);
  chmodSync(join(dir, "systemd-run"), 0o755);
  process.env.PATH = `${dir}:${savedPath}`;
  const marker = join(dir, "ran");
  const ran = () => (existsSync(marker) ? readFileSync(marker, "utf8") : "");
  const pid = await spawnDetached(["sh", "-c", `echo $$ >> '${marker}'`], { ...process.env, XDG_RUNTIME_DIR: dir }, join(dir, "log"), dir);
  await until(() => ran() !== "");
  return { pid, ran: ran() };
}

describe("spawnDetached", () => {
  // The command writes its own pid: the runner is the pid answered, and nothing else ran it.
  test.each([
    ["a systemd-run that fails at once (no user manager) falls back to the plain detached spawn", "exit 1"],
    ["a working scope runs the command once", 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"'],
  ])("%s", async (_name, systemdRunBody) => {
    const { pid, ran } = await spawnWith(systemdRunBody);
    expect(ran).toBe(`${pid}\n`);
  });
});
