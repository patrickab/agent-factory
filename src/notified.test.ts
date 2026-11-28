import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimNotices, notifiedPath, readDelivered } from "./notified.ts";
import { restoreEnv } from "./core-test-kit.ts";

const scratch = mkdtempSync(join(tmpdir(), "factory-notified-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const savedEnv = { ...process.env };
afterAll(() => restoreEnv(savedEnv));
let counter = 0;

beforeEach(() => {
  counter += 1;
  process.env.PI_CODING_AGENT_DIR = join(scratch, `agent-${counter}`);
});

const notice = (key: string) => ({ key, origin: "session-1", text: `factory: ${key}` });

describe("claimNotices", () => {
  test("claims a notice once and remembers it in notified.jsonl", async () => {
    expect(await claimNotices([notice("a"), notice("b")])).toEqual([notice("a"), notice("b")]);
    expect(await claimNotices([notice("a"), notice("c")])).toEqual([notice("c")]);
    expect([...(await readDelivered())].sort()).toEqual(["a", "b", "c"]);
    expect(readFileSync(notifiedPath(), "utf8").trim().split("\n")).toHaveLength(3);
  });

  test("two processes racing claim each notice once", async () => {
    const script = `import { claimNotices } from ${JSON.stringify(join(import.meta.dir, "notified.ts"))};
const keys = Array.from({ length: 30 }, (_, i) => ({ key: "p" + i, origin: "s", text: "t" }));
console.log(JSON.stringify((await claimNotices(keys)).map((n) => n.key)));`;
    const run = () => promisify(execFile)(process.execPath, ["-e", script], { env: { ...process.env }, encoding: "utf8" });
    const outputs = (await Promise.all([run(), run(), run()])).map((result) => result.stdout);
    const claimed = outputs.flatMap((output) => JSON.parse(output) as string[]);
    expect(claimed.sort()).toEqual(Array.from({ length: 30 }, (_, i) => `p${i}`).sort());
  });

  test("a line a crash cut short is skipped and does not swallow the next", async () => {
    await claimNotices([notice("a")]);
    const { appendFileSync } = await import("node:fs");
    appendFileSync(notifiedPath(), '{"key":"b');
    expect(await claimNotices([notice("b")])).toEqual([notice("b")]);
    expect([...(await readDelivered())].sort()).toEqual(["a", "b"]);
  });
});
