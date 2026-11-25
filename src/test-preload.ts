/**
 * Loaded before every test file (`bunfig.toml`): a `systemd-run` first on PATH that runs its command as it is, so no
 * test starts a real systemd scope while every runner it spawns still goes through the scope wrapping.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = mkdtempSync(join(tmpdir(), "factory-test-bin-"));
const fake = join(bin, "systemd-run");
writeFileSync(fake, '#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\n[ "$#" -gt 0 ] && shift\nexec "$@"\n');
chmodSync(fake, 0o755);
process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
process.on("exit", () => rmSync(bin, { recursive: true, force: true }));
