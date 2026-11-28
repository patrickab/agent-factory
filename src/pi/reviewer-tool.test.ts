/**
 * The tools of a wave's reviewer (`reviewer-tool.ts`): `feedback`, `notify_supervisor` and `start_fix` against a wave
 * written into the core fixture. None ends the review.
 */
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { callAction, noticeInputs } from "../core.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { REVIEWER_FIX_CAP } from "../core-waves.ts";
import { caseDir, makeRepo, useCoreFixture } from "../core-test-kit.ts";
import { writeFakeMemoryStore, writeStore } from "../fake-memory-store.ts";
import { pendingNotices } from "../notify.ts";
import { lockFile, unlockFile } from "../lock.ts";
import { waveLockPath } from "../wave-poke.ts";
import { createWave, readWave, type WaveView } from "../waves.ts";
import defaultExtension, { FIX_TOOL, NOTIFY_TOOL, registerReviewerTools, type ReviewerIds } from "./reviewer-tool.ts";

useCoreFixture();

type Result = { isError?: boolean; terminate?: boolean; content: { text: string }[]; details: unknown };
type Execute = (id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: ExtensionContext) => Promise<Result>;

function tools(ids: ReviewerIds): Map<string, { execute: Execute; parameters: { properties: Record<string, unknown> } }> {
  const registered = new Map();
  const pi = { registerTool: (tool: { name: string }) => registered.set(tool.name, tool) };
  registerReviewerTools(pi as unknown as ExtensionAPI, ids);
  return registered;
}

const ctx = { cwd: "/reviews", sessionManager: { getSessionId: () => "reviewer-session" } } as unknown as ExtensionContext;
const call = (tool: { execute: Execute } | undefined, params: unknown) => tool!.execute("call", params, undefined, undefined, ctx);

const ORIGIN = "supervisor-of-reviewer-test";

/** A wave declared by `ORIGIN` on a real repo, its runner's lock held as while its reviewer runs (no runner starts). */
async function heldWave(): Promise<{ id: string; release: () => Promise<void> }> {
  const id = crypto.randomUUID();
  const repo = makeRepo();
  await createWave({ id, repo, tag: "rt/w1", plan: null, title: "wave", request: "r", branch: "main-rt-w1", target: "main", base: "abc", origin: ORIGIN, createdAt: new Date().toISOString(), overrides: {} });
  await lockFile(waveLockPath(id), "held by the test");
  return { id, release: () => unlockFile(waveLockPath(id)) };
}

describe("reviewer tools", () => {
  test("only a wave's reviewer gets them", () => {
    const names = (env: Record<string, string>) => {
      const saved = { ...process.env };
      Object.assign(process.env, env);
      const registered: string[] = [];
      try {
        defaultExtension({ registerTool: (tool: { name: string }) => registered.push(tool.name), on: () => {} } as unknown as ExtensionAPI);
      } finally {
        for (const key of Object.keys(env)) {
          if (saved[key] === undefined) delete process.env[key];
          else process.env[key] = saved[key];
        }
      }
      return registered;
    };
    expect(names({})).toEqual(["submit_verdict"]);
    expect(names({ FACTORY_REVIEW_WAVE: crypto.randomUUID(), FACTORY_REVIEW_TASK: "t" })).toEqual(["submit_verdict", "scout", "feedback", NOTIFY_TOOL, FIX_TOOL]);
  });

  test("feedback in the fit pass (no task) is the wave's: stored with task null and listed by waves.get", async () => {
    const bin = join(caseDir, "store-bin");
    const root = join(caseDir, "stores");
    writeFakeMemoryStore(bin);
    writeStore(root, "plan-rt", { memories: {}, docs: {}, dirs: ["run"] });
    Object.assign(process.env, { PATH: `${bin}:${process.env.PATH ?? ""}`, FAKE_STORE_ROOT: root });
    const id = crypto.randomUUID();
    await createWave({ id, repo: makeRepo(), tag: "rt/fb", plan: "plan-rt", title: "wave", request: "r", branch: "main-rt-fb", target: "main", base: "abc", origin: null, createdAt: new Date().toISOString(), overrides: {} });
    const feedback = tools({ wave: id, task: null, plan: "plan-rt" }).get("feedback")!;
    const result = await call(feedback, { kind: "context", what: "the fit pass read every task's diff again" });
    expect(result.isError).toBeUndefined();
    const { wave } = (await callAction("waves.get", { id })) as { wave: WaveView };
    expect(wave.feedback).toEqual([{ kind: "context", what: "the fit pass read every task's diff again", cost: null, suggestion: null, task: null, wave: id, role: "reviewer" }]);
  });

  test("notify_supervisor sends one quiet notice to the wave's origin and the review goes on", async () => {
    const { id, release } = await heldWave();
    try {
      const notify = tools({ wave: id, task: "4ae7325b-task", plan: null }).get(NOTIFY_TOOL)!;
      const result = await call(notify, { text: "contract api lacks the error case" });
      expect([result.isError, result.terminate]).toEqual([undefined, undefined]);
      const { tasks, waves } = await noticeInputs(ORIGIN);
      // Only the note: the wave's other notice (interrupted: no runner drives it in this test) is not the reviewer's.
      const notices = pendingNotices(tasks, waves, new Set()).filter((notice) => notice.key.includes(":note:"));
      expect(notices.map((notice) => [notice.origin, notice.card.tone])).toEqual([[ORIGIN, "quiet"]]);
      // Delivered once, it is not pending again.
      expect(pendingNotices(tasks, waves, new Set([notices[0].key])).filter((notice) => notice.key.includes(":note:"))).toEqual([]);
      expect((await call(notify, { text: " " })).isError).toBe(true);
    } finally {
      await release();
    }
  });

  test("start_fix adds fix: tasks to the wave, the fourth is refused with the hint to notify the supervisor", async () => {
    const { id, release } = await heldWave();
    try {
      const fix = tools({ wave: id, task: null, plan: null }).get(FIX_TOOL)!;
      for (let n = 1; n <= REVIEWER_FIX_CAP; n++) {
        const result = await call(fix, { title: `repair ${n}`, request: `do ${n}` });
        expect([result.isError, result.terminate, result.details]).toEqual([undefined, undefined, { key: `fix-${n}` }]);
      }
      const refused = await call(fix, { title: "one more", request: "do 4" });
      expect(refused.isError).toBe(true);
      const { fold } = await readWave(id);
      expect(fold.fixes).toBe(REVIEWER_FIX_CAP);
      expect(fold.tasks.map((task) => task.key)).toEqual(["fix-1", "fix-2", "fix-3"]);
      // Each started fix reaches the supervisor as information.
      const { tasks, waves } = await noticeInputs(ORIGIN);
      const notices = pendingNotices(tasks, waves, new Set());
      expect(notices.filter((notice) => notice.key.includes(":fix:")).map((notice) => notice.card.tone)).toEqual(["quiet", "quiet", "quiet"]);
    } finally {
      await release();
    }
  });
});
