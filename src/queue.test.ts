import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { joinQueue, leaveQueue, procAlive, queueAhead } from "./queue.ts";

const scratch = mkdtempSync(join(tmpdir(), "factory-queue-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The pid of a process that ran and has exited. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn(["true"]);
  await child.exited;
  return child.pid;
}

test.if(existsSync("/proc/self/stat"))("a pid is alive only with the ticket's start time: a reused pid is dead", async () => {
  const start = readFileSync(`/proc/${process.pid}/stat`, "utf8").split(") ")[1]!.split(" ")[19]!;
  expect(await procAlive(process.pid, start)).toBe(true);
  expect(await procAlive(process.pid, "1")).toBe(false);
  expect(await procAlive(await deadPid(), start)).toBe(false);
});

test("a dead holder's ticket is dropped, a live one counts until it leaves", async () => {
  const gitDir = mkdtempSync(join(scratch, "q-"));
  const dir = join(gitDir, "factory-merge-queue");
  const ahead = await joinQueue(gitDir);
  await Bun.sleep(2);
  const mine = await joinQueue(gitDir);
  const dead = `000000000000001-${await deadPid()}-0-dead`;
  writeFileSync(join(dir, dead), "");
  expect(await queueAhead(mine)).toBe(1);
  expect(readdirSync(dir)).not.toContain(dead);
  await leaveQueue(ahead);
  expect(await queueAhead(mine)).toBe(0);
});
