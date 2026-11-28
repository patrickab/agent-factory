/**
 * The `scout` tool on the real core, the scout's child the fake `pi` of `core-test-kit.ts`: a report reaches a coder or
 * a supervisor exactly once.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { callAction } from "../core.ts";
import { caseDir, makeRepo, until, useCoreFixture } from "../core-test-kit.ts";
import { writeFakeMemoryStore, writeStore } from "../fake-memory-store.ts";
import { readDelivered } from "../notified.ts";
import { pendingNotices, scoutNoticeKey } from "../notify.ts";
import type { ScoutView } from "../scouts.ts";
import { createScoutTracker } from "./scout-tool.ts";

useCoreFixture();

const STORE = "team/plan";
let ctx: ExtensionContext;

beforeEach(() => {
  writeFakeMemoryStore(join(caseDir, "bin"));
  Object.assign(process.env, { PATH: `${join(caseDir, "bin")}:${process.env.PATH}`, FAKE_STORE_ROOT: join(caseDir, "stores") });
  writeStore(join(caseDir, "stores"), STORE, { memories: {}, docs: {}, dirs: ["plan"] });
  ctx = { cwd: makeRepo(), sessionManager: { getSessionId: () => "supervisor-session" } } as unknown as ExtensionContext;
});

const scoutNow = async (id: string) => ((await callAction("scouts.get", { id })) as { scout: ScoutView }).scout;

describe("a coder's scouts", () => {
  test("a report arrives once: held until the turn end, or answered by a wait and not repeated", async () => {
    const tracker = createScoutTracker({ isCoder: () => true });
    const { result } = await tracker.call({ concern: "how a works", store: STORE }, undefined, ctx);
    const reports = await tracker.held(() => false);
    expect(reports.map((report) => report.details.scout)).toEqual([result.scout.id]);
    expect(reports[0].content).toContain("KEY FACTS");
    expect(await tracker.held(() => false)).toEqual([]);
    const waited = await tracker.call({ concern: "how a works", store: STORE, wait: true }, undefined, ctx);
    expect(waited.result).toMatchObject({ timedOut: false, scout: { state: "done" } });
    expect(await tracker.held(() => false)).toEqual([]);
  });
});

describe("a supervisor's scouts", () => {
  test("wait: false answers at once and owes the coder path nothing: the factory report delivers it", async () => {
    const tracker = createScoutTracker({ isCoder: () => false });
    const { result } = await tracker.call({ concern: "how a works", store: STORE }, undefined, ctx);
    expect(await tracker.held(() => false)).toEqual([]);
    await until(async () => (await scoutNow(result.scout.id)).state === "done");
    const notices = pendingNotices([], [], await readDelivered(), { scouts: [await scoutNow(result.scout.id)] });
    expect(notices.map((notice) => [notice.key, notice.origin])).toEqual([[scoutNoticeKey(result.scout.id), "supervisor-session"]]);
  });

  test("wait: true answers the report and claims its notice, so no factory report repeats it", async () => {
    const tracker = createScoutTracker({ isCoder: () => false });
    const { result } = await tracker.call({ concern: "how a works", store: STORE, wait: true }, undefined, ctx);
    expect(result).toMatchObject({ timedOut: false, scout: { state: "done" } });
    const delivered = await readDelivered();
    expect(delivered.has(scoutNoticeKey(result.scout.id))).toBe(true);
    expect(pendingNotices([], [], delivered, { scouts: [await scoutNow(result.scout.id)] })).toEqual([]);
  });
});
