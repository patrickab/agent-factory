/**
 * Invariant 16: a factory process sees and signals only the runners that carry its own `FACTORY_MARKER`; the real
 * factory (no marker) sees only unmarked ones. Runner stand-ins here are plain scripts named like the runners.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveRunners, stopRunners } from "./launch.ts";
import { MARKER_ENV, ownRunner, spawnDetached } from "./spawn.ts";
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

describe("ownRunner", () => {
  test("the test run has a marker of its own", () => {
    expect(ownMarker).toMatch(/^test-/);
  });

  test("same marker: ours; another marker or none: not ours; a pid that does not run: not ours", async () => {
    const same = await standIn(taskRunner, crypto.randomUUID(), ownMarker);
    const other = await standIn(taskRunner, crypto.randomUUID(), `test-${crypto.randomUUID()}`);
    const none = await standIn(taskRunner, crypto.randomUUID(), undefined);
    expect(await ownRunner(same.pid)).toBe(true);
    expect(await ownRunner(other.pid)).toBe(false);
    expect(await ownRunner(none.pid)).toBe(false);
    expect(await ownRunner(2 ** 22 + 1)).toBe(false);
  });
});

describe("task runners", () => {
  test("a runner with another marker is neither listed nor signalled", async () => {
    const id = crypto.randomUUID();
    const other = await standIn(taskRunner, id, `test-${crypto.randomUUID()}`);
    expect(await liveRunners({ sessionId: id })).toEqual([]);
    await stopRunners({ sessionId: id });
    await Bun.sleep(200);
    expect(alive(other)).toBe(true);
  });

  test("a runner with our marker is listed and stopped", async () => {
    const id = crypto.randomUUID();
    const own = await standIn(taskRunner, id, ownMarker);
    expect(await liveRunners({ sessionId: id })).toEqual([own.pid]);
    await stopRunners({ sessionId: id });
    await own.exited;
    expect(alive(own)).toBe(false);
  });

  test("an unmarked runner is invisible to a marked caller, and a marked one to an unmarked caller", async () => {
    const unmarkedId = crypto.randomUUID();
    const markedId = crypto.randomUUID();
    const unmarked = await standIn(taskRunner, unmarkedId, undefined);
    const marked = await standIn(taskRunner, markedId, ownMarker);
    expect(await liveRunners({ sessionId: unmarkedId })).toEqual([]);
    delete process.env[MARKER_ENV];
    expect(await liveRunners({ sessionId: markedId })).toEqual([]);
    expect(await liveRunners({ sessionId: unmarkedId })).toEqual([unmarked.pid]);
    await stopRunners({ sessionId: markedId });
    await Bun.sleep(200);
    expect(alive(marked)).toBe(true);
  });
});

describe("wave runners", () => {
  test("a runner with another marker is neither listed nor signalled", async () => {
    const id = crypto.randomUUID();
    const other = await standIn(waveRunner, id, `test-${crypto.randomUUID()}`);
    expect(await liveWaveRunners(id)).toEqual([]);
    await stopWaveRunners(id);
    await Bun.sleep(200);
    expect(alive(other)).toBe(true);
  });

  test("an unmarked runner is invisible to a marked caller, and a marked one to an unmarked caller", async () => {
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
