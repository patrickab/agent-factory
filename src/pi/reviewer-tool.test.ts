/**
 * The tools of a wave's reviewer (`reviewer-tool.ts`): `scout` (a fake scout core), `feedback`, `notify_supervisor`
 * and `start_fix` against a wave written into the core fixture. None ends the review.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { agentView } from "../agent-view.ts";
import { callAction, noticeInputs } from "../core.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { noteToSupervisor, REVIEWER_FIX_CAP, startReviewerFix } from "../core-waves.ts";
import { caseDir, makeRepo, useCoreFixture } from "../core-test-kit.ts";
import { pendingNotices } from "../notify.ts";
import type { ScoutView } from "../scouts.ts";
import { lockFile, unlockFile } from "../tasks.ts";
import { waveLockPath } from "../wave-poke.ts";
import { createWave, foldWave, readWave, type WaveView } from "../waves.ts";
import defaultExtension, { FIX_TOOL, NOTIFY_TOOL, registerReviewerTools, type ReviewerCore, type ReviewerIds } from "./reviewer-tool.ts";

useCoreFixture();

type Result = { isError?: boolean; terminate?: boolean; content: { text: string }[]; details: unknown };
type Execute = (id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: ExtensionContext) => Promise<Result>;

function tools(ids: ReviewerIds, core?: ReviewerCore): Map<string, { execute: Execute; parameters: { properties: Record<string, unknown> } }> {
  const registered = new Map();
  const pi = { registerTool: (tool: { name: string }) => registered.set(tool.name, tool) };
  registerReviewerTools(pi as unknown as ExtensionAPI, ids, core);
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

const fakeCore = (overrides: Partial<ReviewerCore> = {}): ReviewerCore => ({
  fix: async () => "fix-1",
  note: async () => {},
  scoutDir: async () => "/worktrees/task-1",
  ...overrides,
});

describe("reviewer tools", () => {
  test("only a wave's reviewer gets them", () => {
    const names = (env: Record<string, string>) => {
      const saved = { ...process.env };
      Object.assign(process.env, env);
      const registered: string[] = [];
      defaultExtension({ registerTool: (tool: { name: string }) => registered.push(tool.name) } as unknown as ExtensionAPI);
      for (const key of Object.keys(env)) if (saved[key] === undefined) delete process.env[key];
      return registered;
    };
    expect(names({})).toEqual(["submit_verdict"]);
    expect(names({ FACTORY_REVIEW_WAVE: crypto.randomUUID(), FACTORY_REVIEW_TASK: "t" })).toEqual(["submit_verdict", "scout", "feedback", NOTIFY_TOOL, FIX_TOOL]);
  });

  test("scout always waits, explores the task's worktree and returns the report", async () => {
    const started: Record<string, unknown>[] = [];
    let reads = 0;
    const view = (state: ScoutView["state"]): ScoutView => ({
      id: "5c0a0000-reviewer-scout",
      caller: { kind: "task", id: "task-1" },
      repo: "/repo",
      concern: "how a works",
      questions: [],
      store: "app/plan",
      commit: "abc",
      model: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      state,
      error: null,
      running: state !== "done",
      interrupted: false,
      usage: null,
      report: state === "done" ? "KEY FACTS\n- a.ts:1 holds a" : null,
      reportPath: null,
      written: [],
    });
    const scouts = { start: async (params: Record<string, unknown>) => (started.push(params), view("queued")), get: async () => view(++reads >= 2 ? "done" : "running") };
    const scout = tools({ wave: "w", task: "task-1", plan: null }, fakeCore({ scouts: scouts, scoutPollMs: 1 })).get("scout")!;
    expect(Object.keys(scout.parameters.properties)).not.toContain("wait");
    expect(Object.keys(scout.parameters.properties)).not.toContain("repo");
    const result = await call(scout, { concern: "how a works", wait: false, repo: "/elsewhere" });
    expect(started).toEqual([{ concern: "how a works", wait: true, repo: "/worktrees/task-1" }]);
    expect(result.isError).toBeUndefined();
    expect(result.terminate).toBeUndefined();
    expect(result.content[0].text).toContain("a.ts:1 holds a");
  });

  test("feedback is the reviewer's, with its task and wave", async () => {
    const feedback = tools({ wave: "wave-9", task: "task-9", plan: null }, fakeCore()).get("feedback")!;
    const result = await call(feedback, { kind: "context", what: "the diff held a lockfile" });
    expect([result.isError, result.terminate]).toEqual([undefined, undefined]);
    expect(result.details).toMatchObject({ role: "reviewer", task: "task-9", wave: "wave-9", what: "the diff held a lockfile" });
    expect((await call(tools({ wave: "", task: null, plan: null }, fakeCore()).get("feedback"), { kind: "context", what: "x" })).isError).toBe(true);
  });

  test("feedback in the fit pass (no task) is the wave's: stored with task null and listed by waves.get", async () => {
    const bin = join(caseDir, "store-bin");
    const root = join(caseDir, "stores");
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(root, "plan-rt"), { recursive: true });
    // ls: the store exists; apply: appends the op's text; read: "- [n] text", newest first.
    writeFileSync(
      join(bin, "memory-store"),
      `#!/bin/sh
dir="${root}/$2"
case "$1" in
  ls) [ -d "$dir" ] || exit 1;;
  create) mkdir -p "$dir";;
  apply) printf '%s\\n' "$4" | bun -e 'const ops=JSON.parse(require("fs").readFileSync(0,"utf8"));require("fs").appendFileSync(process.argv[1],ops.map((o)=>o.text).join("\\n")+"\\n")' "$dir/log";;
  read) [ -f "$dir/log" ] || exit 0; n=0; tac "$dir/log" | while read -r line; do n=$((n+1)); echo "- [f$n] $line"; done;;
esac
`,
    );
    chmodSync(join(bin, "memory-store"), 0o755);
    process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
    const id = crypto.randomUUID();
    await createWave({ id, repo: makeRepo(), tag: "rt/fb", plan: "plan-rt", title: "wave", request: "r", branch: "main-rt-fb", target: "main", base: "abc", origin: null, createdAt: new Date().toISOString(), overrides: {} });
    const feedback = tools({ wave: id, task: null, plan: "plan-rt" }, fakeCore()).get("feedback")!;
    const result = await call(feedback, { kind: "context", what: "the fit pass read every task's diff again" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe("Feedback recorded.");
    const { wave } = (await callAction("waves.get", { id })) as { wave: WaveView };
    expect(wave.feedback).toEqual([{ kind: "context", what: "the fit pass read every task's diff again", cost: null, suggestion: null, task: null, wave: id, role: "reviewer" }]);
    expect(agentView("waves.get", {}, { wave })).toContain("context (reviewer, the wave): the fit pass read every task's diff again");
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
      expect(notices).toEqual([
        { key: expect.stringMatching(new RegExp(`^wave:${id}:note:\\d+$`)), origin: ORIGIN, text: "factory: the reviewer of wave rt/w1 notes (reviewing task 4ae7325b): contract api lacks the error case", card: expect.objectContaining({ kind: "wave", tone: "quiet", tag: "rt/w1", text: "contract api lacks the error case" }) },
      ]);
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
        const result = await call(fix, { title: n === 1 ? "fix(api): handle empty input" : `repair ${n}`, request: `do ${n}` });
        expect([result.isError, result.terminate, result.details]).toEqual([undefined, undefined, { key: `fix-${n}` }]);
      }
      const refused = await call(fix, { title: "one more", request: "do 4" });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain(NOTIFY_TOOL);
      const { declaration, events } = await readWave(id);
      const fold = foldWave(declaration, events);
      expect(fold.fixes).toBe(REVIEWER_FIX_CAP);
      expect(fold.tasks.map((task) => [task.key, task.title, task.request])).toEqual([
        ["fix-1", "fix: fix(api): handle empty input", "do 1"],
        ["fix-2", "fix: repair 2", "do 2"],
        ["fix-3", "fix: repair 3", "do 3"],
      ]);
      // Each started fix reaches the supervisor as information.
      const { tasks, waves } = await noticeInputs(ORIGIN);
      const notices = pendingNotices(tasks, waves, new Set());
      expect(notices.filter((notice) => notice.key.includes(":fix:")).map((notice) => [notice.text, notice.card.tone])).toEqual([
        ['factory: the reviewer of wave rt/w1 started fix-1 "fix: fix(api): handle empty input"', "quiet"],
        ['factory: the reviewer of wave rt/w1 started fix-2 "fix: repair 2"', "quiet"],
        ['factory: the reviewer of wave rt/w1 started fix-3 "fix: repair 3"', "quiet"],
      ]);
    } finally {
      await release();
    }
  });

  test("the core refuses empty fixes and notes", async () => {
    const { id, release } = await heldWave();
    try {
      await expect(startReviewerFix(id, { title: "fix: ", request: "r" })).rejects.toThrow("needs a title");
      await expect(noteToSupervisor(id, " ", null)).rejects.toThrow("needs a text");
    } finally {
      await release();
    }
  });
});
