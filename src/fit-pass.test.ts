/**
 * The end-of-wave fit pass of a `reviewEach` wave (review/1): `merge_gates`, then the wave's reviewer session passes
 * once on how the tasks fit together. Real git repos, the core kit's fake `pi` for the tasks, a fake reviewer
 * (`--mode json`) in front of it that answers `$FAKE_FIT_VERDICT` and notes its argv, a detached wave runner.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { REVIEWER_FIX_CAP, reviewerFixEvents } from "./core-waves.ts";
import { caseDir, fakeBin, git, makeRepo, RUN, scratch, until, useCoreFixture, writeSession } from "./core-test-kit.ts";
import { listTasks, writeTask, type TaskRecord } from "./tasks.ts";
import { pokeWave } from "./wave-poke.ts";
import { afterFit } from "./wave-runner.ts";
import { appendWaveEvent, createWave, foldWave, readWave, type StartedWaveFold } from "./waves.ts";

useCoreFixture();

const WAVE = `32000000-${RUN}-4000-8000-000000000001`;
const BRANCH = "main-factory-fit";
const reviewerCalls = () => join(caseDir, "reviewer-calls.jsonl");

beforeEach(() => {
  const bin = join(scratch, "fit-reviewer-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "reviewer.ts"),
    `import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const dir = args[args.indexOf("--session-dir") + 1];
const id = args.includes("--session-id") ? args[args.indexOf("--session-id") + 1] : "11111111-2222-4333-8444-555555555555";
mkdirSync(dir, { recursive: true });
if (!readdirSync(dir).some((name) => name.endsWith("_" + id + ".jsonl"))) writeFileSync(join(dir, "2026-01-01T00-00-00-000Z_" + id + ".jsonl"), JSON.stringify({ type: "session", version: 3, id }) + "\\n");
appendFileSync(process.env.FAKE_REVIEWER_CALLS, JSON.stringify({ args, task: process.env.FACTORY_REVIEW_TASK ?? null, diff: process.env.FACTORY_REVIEW_DIFF ?? null }) + "\\n");
const findings = process.env.FAKE_FIT_VERDICT === "reject" ? [{ file: "b.txt", line: 1, severity: "major", text: "b does not fit a" }, { file: "b.txt", line: null, severity: "minor", text: "style" }] : [];
const emit = (record) => console.log(JSON.stringify(record));
emit({ type: "session", id });
emit({ type: "tool_execution_end", toolName: "submit_verdict", isError: false, result: { details: { findings } } });
emit({ type: "message_end", message: { role: "assistant", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
`,
  );
  writeFileSync(join(bin, "pi"), `#!/bin/sh\ncase " $* " in *" json "*) exec bun ${join(bin, "reviewer.ts")} "$@";; esac\nexec ${join(fakeBin, "pi")} "$@"\n`);
  chmodSync(join(bin, "pi"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  process.env.FAKE_PI_HOLD = "1";
  process.env.FAKE_REVIEWER_CALLS = reviewerCalls();
});

const fold = async () => {
  const file = await readWave(WAVE);
  return foldWave(file.declaration, file.events);
};

const calls = (): { args: string[]; task: string | null; diff: string | null }[] =>
  existsSync(reviewerCalls()) ? readFileSync(reviewerCalls(), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

/**
 * A repo whose `reviewEach` wave holds the done tasks `keys` (a commit on the wave's branch each); `fixes` of them
 * were started by the reviewer (`fix-<n>`).
 */
async function doneWave(keys: string[], fixes: string[] = []): Promise<string> {
  const repo = makeRepo();
  const base = git(repo, "rev-parse", "main");
  git(repo, "branch", BRANCH);
  const work = join(caseDir, "work");
  git(repo, "worktree", "add", "--quiet", work, BRANCH);
  for (const key of [...keys, ...fixes]) {
    writeFileSync(join(work, `${key}.txt`), `${key} done\n`);
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", `feat: ${key}`);
  }
  git(repo, "worktree", "remove", work);
  await createWave({ id: WAVE, repo, tag: "factory/fit", plan: null, title: "Fit wave", request: "Check the fit.", branch: BRANCH, target: "main", base, origin: null, createdAt: "2026-01-01T00:00:00.000Z", overrides: {}, reviewEach: true });
  await appendWaveEvent(WAVE, { kind: "tasks", tasks: keys.map((key) => ({ key, title: `Add ${key}`, request: `add ${key}.txt`, after: [] })) });
  if (fixes.length > 0) await appendWaveEvent(WAVE, { kind: "tasks", tasks: fixes.map((key) => ({ key, title: `fix: ${key}`, request: `fix ${key}`, after: [] })), by: "reviewer" });
  for (const [index, key] of [...keys, ...fixes].entries()) {
    const record: TaskRecord = { id: `42000000-${RUN}-4000-8000-00000000000${index}`, repo, worktree: join(caseDir, `task-${key}`), branch: `task-${key}`, title: `Add ${key}`, sessionId: `session-${RUN}-fit-${key}`, sessionDir: join(caseDir, "sessions"), createdAt: `2026-01-01T00:00:0${index}.000Z`, tag: "factory/fit", plan: null, wave: WAVE, origin: null };
    await writeTask(record);
    writeSession(record, [{ type: "custom", customType: "factory-state", data: { state: "done", round: 1, reason: "merged" } }]);
    await appendWaveEvent(WAVE, { kind: "task", key, taskId: record.id, sessionId: record.sessionId });
  }
  return repo;
}

describe("the fit pass of a reviewEach wave", () => {
  test("approved: the wave merges; the pass resumes the wave's reviewer session on the wave's whole diff", async () => {
    const repo = await doneWave(["a", "b"]);
    await pokeWave(WAVE);
    await until(async () => (await fold()).stage === "merged", 20_000);
    expect(git(repo, "show", "main:b.txt")).toBe("b done");
    const [call, ...rest] = calls();
    expect(rest).toEqual([]);
    expect(call!.args[call!.args.indexOf("--session-id") + 1]).toBe(WAVE);
    expect(call!.args.at(-1)).toContain("fit together");
    expect(call!.args.at(-1)).toContain("- b: Add b");
    expect(call!.task).toBeNull();
    // The same tools as every task's review (the prompt cache): `feedback` there is the wave's.
    expect(call!.args[call!.args.indexOf("--tools") + 1]).toBe("read,grep,find,ls,read_diff,scout,feedback,notify_supervisor,start_fix,submit_verdict");
    const diff = JSON.parse(readFileSync(call!.diff!, "utf8")) as { paths: string[] };
    expect(diff.paths).toEqual(["a.txt", "b.txt"]);
    const done = await fold();
    expect(done.reviews.map((review) => review.verdict)).toEqual(["approved"]);
    expect(done.tasks.map((task) => task.key)).toEqual(["a", "b"]);
  }, 60_000);

  test("a major finding starts a fix task and the wave builds again; minor findings start nothing", async () => {
    const repo = await doneWave(["a", "b"]);
    const main = git(repo, "rev-parse", "main");
    process.env.FAKE_FIT_VERDICT = "reject";
    await pokeWave(WAVE);
    await until(async () => (await fold()).tasks.some((task) => task.key === "fix-1" && task.taskId !== null), 20_000);
    const building = await fold();
    expect(building.stage).toBe("building");
    expect(building.detail).toBe("the pass on how the tasks fit together found 1 major: task fix-1 fixes it");
    expect(building.fixes).toBe(1);
    expect(building.reviews.map((review) => review.verdict)).toEqual(["rejected"]);
    const spec = building.tasks.find((task) => task.key === "fix-1");
    expect(spec?.title).toBe("fix: how the wave's tasks fit together (wave review round 1)");
    expect(spec?.request).toContain("- major b.txt:1: b does not fit a");
    expect(spec?.request).not.toContain("style");
    expect((await listTasks()).some((record) => record.id === spec?.taskId)).toBe(true);
    expect(git(repo, "rev-parse", "main")).toBe(main);
  }, 60_000);

  test("with the fix tasks used up a major finding rejects the wave to the supervisor", async () => {
    const fixes = Array.from({ length: REVIEWER_FIX_CAP }, (_, index) => `fix-${index + 1}`);
    const repo = await doneWave(["a"], fixes);
    const main = git(repo, "rev-parse", "main");
    process.env.FAKE_FIT_VERDICT = "reject";
    await pokeWave(WAVE);
    await until(async () => (await fold()).stage === "rejected", 20_000);
    const rejected = await fold();
    expect(rejected.detail).toBe(`the pass on how the tasks fit together found 1 major; the wave's ${REVIEWER_FIX_CAP} fix tasks are used up`);
    expect(rejected.tasks.map((task) => task.key)).toEqual(["a", ...fixes]);
    expect(rejected.fixes).toBe(REVIEWER_FIX_CAP);
    expect(git(repo, "rev-parse", "main")).toBe(main);
  }, 60_000);

  test("the fix task is chosen from the wave's log as it is when the stage moves: no duplicate key, no fix past the cap", async () => {
    await doneWave(["a"]);
    const before = (await fold()) as StartedWaveFold;
    const event: Parameters<typeof afterFit>[3] = { kind: "review", round: 1, sessionId: null, model: null, verdict: "rejected", status: "ok", findings: [{ severity: "major", file: "a.txt", line: null, text: "x" }], usage: null, wallMs: 0 };
    // A supervisor's task keyed `fix-1` lands before the pass: the reviewer's fix is fix-2.
    await appendWaveEvent(WAVE, { kind: "tasks", tasks: [{ key: "fix-1", title: "fix: by hand", request: "r", after: [] }] });
    const withSupervisorFix = (await fold()) as StartedWaveFold;
    const choice = afterFit(withSupervisorFix, withSupervisorFix, 1, event);
    expect(choice.detail).toEndWith("task fix-2 fixes it");
    expect(choice.events.flatMap((e) => (e.kind === "tasks" ? e.tasks.map((task) => task.key) : []))).toEqual(["fix-2"]);
    // A reviewer's fix runs on the small model; "big" when asked; the spec shows it.
    const small = reviewerFixEvents(await fold(), { title: "x", request: "r" })!.events[0]!;
    const big = reviewerFixEvents(await fold(), { title: "x", request: "r", model: "big" })!.events[0]!;
    expect(small.kind === "tasks" && small.tasks[0]!.model).toBe("small");
    expect(big.kind === "tasks" && big.tasks[0]!.model).toBe("big");
    // The fix slots used up meanwhile: rejected, no fourth fix.
    for (let n = 0; n < REVIEWER_FIX_CAP; n++) {
      const added = reviewerFixEvents(await fold(), { title: `fix ${n}`, request: "r" })!;
      for (const added_ of added.events) await appendWaveEvent(WAVE, added_);
    }
    const full = await fold();
    expect(full.fixes).toBe(REVIEWER_FIX_CAP);
    expect(afterFit(full as StartedWaveFold, full, 1, event).to).toBe("rejected");
    // Tasks added since the pass started (here every fix) build: none is keyed twice.
    const late = afterFit(before, full, 1, event);
    expect(late.to).toBe("building");
    expect(late.events).toEqual([event]);
  }, 60_000);
});

