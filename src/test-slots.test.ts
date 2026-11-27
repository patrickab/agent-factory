import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGateStep } from "./flaky-rerun.ts";
import { type CommandResult, runCommand } from "./run.ts";
import { type SlotPool, slotWaiting, takeSlot } from "./test-slots.ts";
import { procStart } from "./lock.ts";

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

  test("a waiting marker whose process is gone, or whose pid another process has now, is ignored and removed", async () => {
    const slots = pool(1);
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    mkdirSync(join(slots.dir, "waiting"), { recursive: true });
    const marker = (pid: number, start: string | null) => join(slots.dir, "waiting", `${pid}-${start}-${crypto.randomUUID()}`);
    const stale = [marker(dead.pid, "1"), marker(process.pid, "1")];
    for (const path of stale) writeFileSync(path, "");
    expect(await slotWaiting([dead.pid, process.pid], slots.dir)).toBe(false);
    for (const path of stale) expect(existsSync(path)).toBe(false);
    // A live one's marker counts and stays.
    const live = marker(process.pid, await procStart(process.pid));
    writeFileSync(live, "");
    expect(await slotWaiting([dead.pid, process.pid], slots.dir)).toBe(true);
    expect(existsSync(live)).toBe(true);
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
