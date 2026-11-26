import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGateStep } from "./flaky-rerun.ts";
import { type CommandResult, runCommand } from "./run.ts";
import { type SlotPool, slotCount, slotEnv, slotPool, slotWaiting, takeSlot } from "./test-slots.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function pool(count: number, extra: Partial<SlotPool> = {}): SlotPool {
  const dir = mkdtempSync(join(tmpdir(), "factory-slots-"));
  dirs.push(dir);
  return { dir: join(dir, "slots"), count, cores: 8, held: false, jobs: null, pollMs: 20, ...extra };
}

const OK: CommandResult = { exitCode: 0, killed: false, timedOut: false, durationMs: 1, stdout: "", stdoutTruncated: false, output: "" };

async function until(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}

describe("test slots", () => {
  test("K is FACTORY_SLOTS, else a quarter of the cores, at least 1; jobs are cores / K", () => {
    expect(slotCount({}, 8)).toBe(2);
    expect(slotCount({}, 3)).toBe(1);
    expect(slotCount({ FACTORY_SLOTS: "3" }, 8)).toBe(3);
    expect(slotCount({ FACTORY_SLOTS: "0" }, 8)).toBe(2);
    expect(slotEnv(pool(3))).toEqual({ FACTORY_TEST_JOBS: "2", FACTORY_SLOT_HELD: "1" });
    expect(slotEnv(pool(16))).toEqual({ FACTORY_TEST_JOBS: "1", FACTORY_SLOT_HELD: "1" });
    expect(slotEnv(pool(2, { jobs: "5" }))).toEqual({ FACTORY_SLOT_HELD: "1" });
    expect(slotPool({ FACTORY_SLOT_HELD: "1", FACTORY_TEST_JOBS: "5" }, 8)).toMatchObject({ held: true, jobs: "5", count: 2 });
  });

  test("K+1 gate runs: one waits, shown as waiting, and runs when a slot frees", async () => {
    const slots = pool(2);
    const started: number[] = [];
    const gates = [0, 1, 2].map(() => Promise.withResolvers<void>());
    const steps = [0, 1, 2].map((index) =>
      runGateStep(["gate", String(index)], async () => {
        started.push(index);
        await gates[index].promise;
        return OK;
      }, () => false, slots),
    );
    await until(() => started.length === 2);
    await until(() => slotWaiting([process.pid], slots.dir));
    await Bun.sleep(100);
    expect(started.length).toBe(2);
    const waiting = [0, 1, 2].find((index) => !started.includes(index))!;
    gates[started[0]].resolve();
    await until(() => started.length === 3);
    expect(started[2]).toBe(waiting);
    expect(await slotWaiting([process.pid], slots.dir)).toBe(false);
    for (const gate of gates) gate.resolve();
    for (const step of await Promise.all(steps)) expect(step.result.exitCode).toBe(0);
  });

  test("a killed holder frees its slot", async () => {
    const slots = pool(1);
    const script = `import { takeSlot } from ${JSON.stringify(join(import.meta.dir, "test-slots.ts"))};
await takeSlot(${JSON.stringify(slots)}); console.log("held"); await Bun.sleep(60_000);`;
    const holder = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "inherit" });
    const reader = holder.stdout.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("held");
    let ran = false;
    const step = runGateStep(["gate"], async () => {
      ran = true;
      return OK;
    }, () => false, slots);
    await until(() => slotWaiting([process.pid], slots.dir));
    expect(ran).toBe(false);
    holder.kill("SIGKILL");
    await holder.exited;
    expect((await step).result.exitCode).toBe(0);
    expect(ran).toBe(true);
  });

  test("a cancel ends the wait as a killed run, the command never starts", async () => {
    const slots = pool(1);
    const release = await takeSlot(slots);
    let cancelled = false;
    let ran = false;
    const step = runGateStep(["gate"], async () => {
      ran = true;
      return OK;
    }, () => cancelled, slots);
    await until(() => slotWaiting([process.pid], slots.dir));
    cancelled = true;
    const { result, flaky } = await step;
    expect(result.killed).toBe(true);
    expect(flaky).toBeNull();
    expect(ran).toBe(false);
    expect(await slotWaiting([process.pid], slots.dir)).toBe(false);
    await release!();
  });

  test("a waiting marker whose process is gone is ignored and removed", async () => {
    const slots = pool(1);
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    mkdirSync(join(slots.dir, "waiting"), { recursive: true });
    const marker = join(slots.dir, "waiting", `${dead.pid}.${crypto.randomUUID()}`);
    writeFileSync(marker, "");
    expect(await slotWaiting([dead.pid], slots.dir)).toBe(false);
    expect(existsSync(marker)).toBe(false);
    // A live one's marker counts and stays.
    const live = join(slots.dir, "waiting", `${process.pid}.${crypto.randomUUID()}`);
    writeFileSync(live, "");
    expect(await slotWaiting([dead.pid, process.pid], slots.dir)).toBe(true);
    expect(existsSync(live)).toBe(true);
  });

  test("a waiting marker older than the start of the process that has its pid now is stale: ignored and removed", async () => {
    const slots = pool(1);
    mkdirSync(join(slots.dir, "waiting"), { recursive: true });
    // A marker left by an earlier process of this pid: written before this process started.
    const old = join(slots.dir, "waiting", `${process.pid}.${crypto.randomUUID()}`);
    writeFileSync(old, "");
    utimesSync(old, new Date("2000-01-01T00:00:00Z"), new Date("2000-01-01T00:00:00Z"));
    expect(await slotWaiting([process.pid], slots.dir)).toBe(false);
    expect(existsSync(old)).toBe(false);
  });

  test("FACTORY_TEST_JOBS and FACTORY_SLOT_HELD reach the command", async () => {
    const cwd = tmpdir();
    const echo = ["sh", "-c", "echo $FACTORY_TEST_JOBS $FACTORY_SLOT_HELD"];
    const step = await runGateStep(echo, (env) => runCommand(echo, { cwd, env: { ...env, FACTORY_TEST_JOBS: env.FACTORY_TEST_JOBS ?? "unset" } }), () => false, pool(2));
    expect(step.result.output.trim()).toBe("4 1");
  });
});

describe("factory slot", () => {
  const cli = join(import.meta.dir, "cli.ts");

  function env(agent: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
    const base: Record<string, string | undefined> = { ...process.env, PI_CODING_AGENT_DIR: agent, FACTORY_SLOTS: "1", ...extra };
    if (!("FACTORY_SLOT_HELD" in extra)) delete base.FACTORY_SLOT_HELD;
    if (!("FACTORY_TEST_JOBS" in extra)) delete base.FACTORY_TEST_JOBS;
    return base;
  }

  test("passes the exit code through, the command holding a slot", async () => {
    const agent = mkdtempSync(join(tmpdir(), "factory-slot-cli-"));
    dirs.push(agent);
    const child = Bun.spawn(["bun", cli, "slot", "--", "sh", "-c", "echo $FACTORY_TEST_JOBS $FACTORY_SLOT_HELD; exit 7"], { env: env(agent), stdout: "pipe", stderr: "inherit" });
    expect(await child.exited).toBe(7);
    expect((await new Response(child.stdout).text()).trim()).toBe(`${navigator.hardwareConcurrency} 1`);
  });

  test("with FACTORY_SLOT_HELD set it takes no second slot", async () => {
    const agent = mkdtempSync(join(tmpdir(), "factory-slot-cli-"));
    dirs.push(agent);
    const release = await takeSlot({ dir: join(agent, "factory", "slots"), count: 1, cores: 8, held: false, jobs: null, pollMs: 20 });
    const child = Bun.spawn(["bun", cli, "slot", "--", "sh", "-c", "exit 3"], { env: env(agent, { FACTORY_SLOT_HELD: "1" }), stdout: "ignore", stderr: "inherit" });
    expect(await child.exited).toBe(3);
    await release!();
  });
});
