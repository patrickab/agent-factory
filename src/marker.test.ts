/**
 * Invariant 16: a factory process sees and signals only the runners that carry its own `FACTORY_MARKER`; the real
 * factory (no marker) sees only unmarked ones. Runner stand-ins here are plain scripts named like the runners.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveRunners, stopRunners } from "./launch.ts";
import { MARKER_ENV, spawnDetached } from "./spawn.ts";
import { liveWaveRunners, stopWaveRunners } from "./wave-poke.ts";

const ownMarker = process.env[MARKER_ENV];
const dir = mkdtempSync(join(tmpdir(), "factory-marker-test-"));
const taskRunner = join(dir, "runner.ts");
const waveRunner = join(dir, "wave-runner.ts");
for (const path of [taskRunner, waveRunner]) writeFileSync(path, "setInterval(() => {}, 1000);\n");

const children: ReturnType<typeof Bun.spawn>[] = [];
afterEach(async () => {
  process.env[MARKER_ENV] = ownMarker;
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
    await child.exited;
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Starts a stand-in `script <id>` with `marker` (none when undefined); resolves once its command line is the script's. */
async function standIn(script: string, id: string, marker: string | undefined): Promise<ReturnType<typeof Bun.spawn>> {
  const env: Record<string, string | undefined> = { ...process.env, [MARKER_ENV]: marker };
  if (marker === undefined) delete env[MARKER_ENV];
  const child = Bun.spawn(["bun", script, id], { env });
  children.push(child);
  for (let tries = 0; tries < 200; tries++) {
    const cmdline = (() => {
      try {
        return readFileSync(`/proc/${child.pid}/cmdline`, "utf8");
      } catch {
        return "";
      }
    })();
    if (cmdline.includes(script)) return child;
    await Bun.sleep(10);
  }
  throw new Error(`stand-in ${script} did not start`);
}

const alive = (child: ReturnType<typeof Bun.spawn>) => child.exitCode === null && child.signalCode === null;

test("task runners: ours is listed and stopped, one with another marker is neither listed nor signalled", async () => {
  const [ownId, otherId] = [crypto.randomUUID(), crypto.randomUUID()];
  const own = await standIn(taskRunner, ownId, ownMarker);
  const other = await standIn(taskRunner, otherId, `test-${crypto.randomUUID()}`);
  expect(await liveRunners({ sessionId: otherId })).toEqual([]);
  await stopRunners({ sessionId: otherId });
  expect(await liveRunners({ sessionId: ownId })).toEqual([own.pid]);
  await stopRunners({ sessionId: ownId });
  await own.exited;
  expect(alive(other)).toBe(true);
});

test("wave runners: an unmarked one is invisible to a marked caller, a marked one to an unmarked caller", async () => {
  const unmarkedId = crypto.randomUUID();
  const markedId = crypto.randomUUID();
  const unmarked = await standIn(waveRunner, unmarkedId, undefined);
  const marked = await standIn(waveRunner, markedId, ownMarker);
  expect(await liveWaveRunners(unmarkedId)).toEqual([]);
  expect(await liveWaveRunners(markedId)).toEqual([marked.pid]);
  delete process.env[MARKER_ENV];
  expect(await liveWaveRunners(markedId)).toEqual([]);
  expect(await liveWaveRunners(unmarkedId)).toEqual([unmarked.pid]);
  await stopWaveRunners(markedId);
  await Bun.sleep(200);
  expect(alive(marked)).toBe(true);
});

describe("spawnDetached", () => {
  test("a runner carries the spawning process's marker, whatever marker the given env holds; none when it has none", async () => {
    const command = ["sh", "-c", `printf '%s\\n' "\${${MARKER_ENV}-unset}"`];
    const marked = join(dir, "marked.log");
    await spawnDetached(command, { PATH: process.env.PATH, [MARKER_ENV]: "foreign" }, marked, dir, null);
    delete process.env[MARKER_ENV];
    const unmarked = join(dir, "unmarked.log");
    await spawnDetached(command, { PATH: process.env.PATH, [MARKER_ENV]: "foreign" }, unmarked, dir, null);
    const read = async (path: string) => {
      for (let tries = 0; tries < 100; tries++) {
        const text = (() => {
          try {
            return readFileSync(path, "utf8");
          } catch {
            return "";
          }
        })();
        if (text !== "") return text.trim();
        await Bun.sleep(20);
      }
      return "";
    };
    expect(await read(marked)).toBe(ownMarker!);
    expect(await read(unmarked)).toBe("unset");
  });
});
