/**
 * Loaded before every test file (`bunfig.toml`): a `systemd-run` first on PATH that runs its command as it is, so no
 * test starts a real systemd scope while every runner it spawns still goes through the scope wrapping.
 * - An agent dir of its own (`PI_CODING_AGENT_DIR`) as the default of every file: a test, hook or leftover of a timed
 *   out one that restores the environment it started with never lists, nor stops, the real factory's tasks and waves
 * - A random `FACTORY_MARKER` per test run (invariant 16): every runner this run spawns carries it, and this run sees
 *   and signals only those, never a runner of the real factory (no marker) or of another test run
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = mkdtempSync(join(tmpdir(), "factory-test-bin-"));
const fake = join(bin, "systemd-run");
writeFileSync(fake, '#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\n[ "$#" -gt 0 ] && shift\nexec "$@"\n');
chmodSync(fake, 0o755);
process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
process.env.PI_CODING_AGENT_DIR = join(bin, "agent");
process.env.FACTORY_MARKER = `test-${crypto.randomUUID()}`;
process.on("exit", () => rmSync(bin, { recursive: true, force: true }));
