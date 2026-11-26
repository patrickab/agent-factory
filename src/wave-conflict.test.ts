/**
 * The conflict task (throughput/1): a wave whose rebase onto its target conflicts (not additions-only) builds again
 * with a task whose worktree holds the markers. Real git repos, the core kit's fake `pi` for the task, a fake reviewer
 * (`--mode json`) in front of it, a detached wave runner.
 */
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { callAction } from "./core.ts";
import { caseDir, fakeBin, git, makeRepo, RUN, scratch, until, useCoreFixture, writeSession } from "./core-test-kit.ts";
import { stopRunners } from "./launch.ts";
import { listTasks, writeTask, type TaskRecord } from "./tasks.ts";
import { pokeWave } from "./wave-poke.ts";
import { appendWaveEvent, createWave, foldWave, readWave, type WaveOverrides } from "./waves.ts";

useCoreFixture();

const WAVE = `31000000-${RUN}-4000-8000-000000000001`;
const BRANCH = "main-factory-w1";

beforeEach(() => {
  // The wave's reviewer approves; everything else goes to the kit's fake pi.
  const bin = join(scratch, "reviewer-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "reviewer.ts"),
    `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const dir = args[args.indexOf("--session-dir") + 1];
const id = "11111111-2222-4333-8444-555555555555";
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "2026-01-01T00-00-00-000Z_" + id + ".jsonl"), JSON.stringify({ type: "session", id }) + "\\n");
const emit = (record) => console.log(JSON.stringify(record));
emit({ type: "session", id });
emit({ type: "tool_execution_end", toolName: "submit_verdict", isError: false, result: { details: { findings: [] } } });
emit({ type: "message_end", message: { role: "assistant", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
`,
  );
  writeFileSync(join(bin, "pi"), `#!/bin/sh\ncase " $* " in *" json "*) exec bun ${join(bin, "reviewer.ts")} "$@";; esac\nexec ${join(fakeBin, "pi")} "$@"\n`);
  chmodSync(join(bin, "pi"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  process.env.FAKE_PI_HOLD = "1";
});

function commit(cwd: string, file: string, text: string, message: string): string {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", "-A");
  git(cwd, "commit", "--quiet", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

const fold = async () => {
  const file = await readWave(WAVE);
  return foldWave(file.declaration, file.events);
};

/** Appends a `factory-state` entry to the session of `record` (the fake pi's session file). */
function markState(record: TaskRecord, state: string, reason: string): void {
  appendFileSync(join(record.sessionDir, `2026-01-01T00-00-00-000Z_${record.sessionId}.jsonl`), `${JSON.stringify({ type: "custom", customType: "factory-state", data: { state, round: 1, reason } })}\n`);
}

type WaveSetup = {
  /** What main commits after the wave branched off; default: it changes the line of a.txt the wave changes. Returns main's tip. */
  main?: (repo: string) => string;
  overrides?: WaveOverrides;
  /** Committed before the wave branches off. */
  files?: Record<string, string>;
};

/** A repo whose wave (one done task) changed the line of a.txt that main changed too (or what `setup.main` does). */
async function conflictingWave(setup: WaveSetup = {}): Promise<{ repo: string; wave: string; main: string }> {
  const repo = makeRepo();
  if (setup.files !== undefined) {
    for (const [file, text] of Object.entries(setup.files)) writeFileSync(join(repo, file), text);
    git(repo, "add", "-A");
    git(repo, "commit", "--quiet", "-m", "more files");
  }
  const base = git(repo, "rev-parse", "main");
  git(repo, "branch", BRANCH);
  const work = join(caseDir, "work");
  git(repo, "worktree", "add", "--quiet", work, BRANCH);
  const wave = commit(work, "a.txt", "wave's a\n", "feat: change a");
  git(repo, "worktree", "remove", work);
  const main = setup.main === undefined ? commit(repo, "a.txt", "main's a\n", "main: change a") : setup.main(repo);
  await createWave({ id: WAVE, repo, tag: "factory/w1", plan: null, title: "Wave one", request: "Check a.", branch: BRANCH, target: "main", base, origin: null, createdAt: "2026-01-01T00:00:00.000Z", overrides: setup.overrides ?? {} });
  await appendWaveEvent(WAVE, { kind: "tasks", tasks: [{ key: "a", title: "Change a", request: "change a", after: [] }] });
  const record: TaskRecord = { id: `41000000-${RUN}-4000-8000-000000000001`, repo, worktree: join(caseDir, "task-a"), branch: "task-a", title: "Change a", sessionId: `session-${RUN}-a`, sessionDir: join(caseDir, "sessions"), createdAt: "2026-01-01T00:00:01.000Z", tag: "factory/w1", plan: null, wave: WAVE, origin: null };
  await writeTask(record);
  writeSession(record, [{ type: "custom", customType: "factory-state", data: { state: "done", round: 1, reason: "merged" } }]);
  await appendWaveEvent(WAVE, { kind: "task", key: "a", taskId: record.id, sessionId: record.sessionId });
  return { repo, wave, main };
}

/** Waits for the wave's task `key` to start; its record. */
async function startedTask(key = "conflict-1"): Promise<TaskRecord> {
  await until(async () => (await fold()).tasks.some((task) => task.key === key && task.taskId !== null), 20_000);
  const taskId = (await fold()).tasks.find((task) => task.key === key)?.taskId;
  const record = (await listTasks()).find((task) => task.id === taskId);
  if (record === undefined) throw new Error(`no record of ${key}`);
  return record;
}

describe("a wave's rebase conflict", () => {
  test("becomes one task with the markers and both sides' subjects; its resolution lets the wave review and merge", async () => {
    const { repo, wave, main } = await conflictingWave();
    await pokeWave(WAVE);
    await until(async () => (await fold()).tasks.some((task) => task.key === "conflict-1" && task.taskId !== null), 20_000);
    const building = await fold();
    expect([building.stage, building.detail]).toEqual(["building", "the rebase onto main conflicts on a.txt: task conflict-1 resolves it"]);
    expect(building.conflicts).toEqual([{ at: expect.any(String), phase: "review", key: "conflict-1", head: wave, onto: main, files: ["a.txt"] }]);
    expect(building.tasks.map((task) => task.key)).toEqual(["a", "conflict-1"]);
    const spec = building.tasks[1];
    expect(spec.title).toBe("fix: resolve the conflict of factory/w1 with main");
    expect(spec.request).toContain("- a.txt");
    expect(spec.request).toContain("Commits of main on them since the wave branched off:\n- main: change a");
    expect(spec.request).toContain("Commits of the wave on them:\n- feat: change a");
    // The wave's branch on the target's tip; the task's worktree on it, the wave's change merged with the markers left.
    expect(git(repo, "rev-parse", BRANCH)).toBe(main);
    const record = (await listTasks()).find((task) => task.id === spec.taskId);
    if (record === undefined) throw new Error("no record of conflict-1");
    expect(git(record.worktree, "rev-parse", "HEAD")).toBe(main);
    expect(readFileSync(join(record.worktree, "a.txt"), "utf8")).toBe(`<<<<<<< ${main}\nmain's a\n=======\nwave's a\n>>>>>>> ${wave}\n`);

    // The coder resolves it and its merge lands on the wave's branch.
    await stopRunners(record);
    const resolved = commit(record.worktree, "a.txt", "both a\n", "fix: resolve the conflict of factory/w1 with main");
    git(repo, "update-ref", `refs/heads/${BRANCH}`, resolved, main);
    markState(record, "done", "merged");
    await pokeWave(WAVE);
    await until(async () => (await fold()).stage === "merged", 20_000);
    expect(git(repo, "show", "main:a.txt")).toBe("both a");
    expect((await fold()).tasks.map((task) => task.key)).toEqual(["a", "conflict-1"]);
  }, 60_000);

  test("a conflict task cancelled: the wave's branch goes back to its own head and the wave blocks, the target unchanged", async () => {
    const { repo, wave, main } = await conflictingWave();
    await pokeWave(WAVE);
    const record = await startedTask();
    expect(git(repo, "rev-parse", BRANCH)).toBe(main);
    await callAction("tasks.cancel", { id: record.id });
    await pokeWave(WAVE);
    await until(async () => (await fold()).stage === "blocked", 20_000);
    const blocked = await fold();
    expect(blocked.reason).toBe("conflict");
    expect(blocked.detail).toContain("its conflict task conflict-1 was cancelled");
    expect(git(repo, "rev-parse", BRANCH)).toBe(wave);
    expect(git(repo, "rev-parse", "main")).toBe(main);
  }, 60_000);

  test("waves.cancel while its conflict task runs: the wave's branch goes back to its own head", async () => {
    const { repo, wave, main } = await conflictingWave();
    await pokeWave(WAVE);
    await startedTask();
    expect(git(repo, "rev-parse", BRANCH)).toBe(main);
    await callAction("waves.cancel", { id: WAVE });
    expect((await fold()).stage).toBe("cancelled");
    expect(git(repo, "rev-parse", BRANCH)).toBe(wave);
    expect(git(repo, "rev-parse", "main")).toBe(main);
  }, 60_000);

  test("a conflict task that fails: the wave keeps building on the target's tip, nothing merges", async () => {
    const { repo, main } = await conflictingWave();
    await pokeWave(WAVE);
    const record = await startedTask();
    await stopRunners(record);
    markState(record, "blocked", "gates");
    await pokeWave(WAVE);
    await Bun.sleep(1_000);
    const building = await fold();
    expect(building.stage).toBe("building");
    expect(building.tasks.map((task) => task.key)).toEqual(["a", "conflict-1"]);
    expect(building.conflicts?.length).toBe(1);
    expect(git(repo, "rev-parse", BRANCH)).toBe(main);
    expect(git(repo, "rev-parse", "main")).toBe(main);
  }, 60_000);

  test("a conflict at the merge (the target moved after the review): a conflict task of the merge phase", async () => {
    const { repo, wave } = await conflictingWave({ main: (repo) => git(repo, "rev-parse", "main"), overrides: { merge: "review" } });
    await pokeWave(WAVE);
    await until(async () => (await fold()).stage === "waiting_approve", 20_000);
    expect(git(repo, "rev-parse", BRANCH)).toBe(wave);
    const main = commit(repo, "a.txt", "main's a\n", "main: change a");
    await appendWaveEvent(WAVE, { kind: "stage", stage: "merging", reason: null });
    await pokeWave(WAVE);
    const record = await startedTask();
    const building = await fold();
    expect(building.stage).toBe("building");
    expect(building.conflicts).toEqual([{ at: expect.any(String), phase: "merge", key: "conflict-1", head: wave, onto: main, files: ["a.txt"] }]);
    expect(git(repo, "rev-parse", BRANCH)).toBe(main);
    expect(git(repo, "rev-parse", "main")).toBe(main);
    expect(readFileSync(join(record.worktree, "a.txt"), "utf8")).toContain(">>>>>>> ");
  }, 60_000);

  test("a modify/delete conflict: the request names the file the target deleted", async () => {
    const { repo, main } = await conflictingWave({
      main: (repo) => {
        git(repo, "rm", "--quiet", "a.txt");
        git(repo, "commit", "--quiet", "-m", "main: remove a");
        return git(repo, "rev-parse", "HEAD");
      },
    });
    await pokeWave(WAVE);
    const record = await startedTask();
    const building = await fold();
    expect(building.conflicts?.[0]?.files).toEqual(["a.txt"]);
    const spec = building.tasks.find((task) => task.key === "conflict-1");
    expect(spec?.request).toContain("- a.txt: main deleted it, the wave changed it; your worktree holds the wave's version");
    expect(spec?.request).not.toContain("conflict markers (");
    expect(spec?.request).toContain("Commits of main on them since the wave branched off:\n- main: remove a");
    expect(git(repo, "rev-parse", BRANCH)).toBe(main);
    // The wave's version of the file the target removed is in the worktree for the coder to judge.
    expect(readFileSync(join(record.worktree, "a.txt"), "utf8")).toBe("wave's a\n");
  }, 60_000);

  test("an after_create hook that dirties tracked files: the merge wins on the conflicting file, the hook's other changes stay", async () => {
    const hook = `hooks:\n  after_create:\n    - [sh, -c, 'case "$PWD" in *resolve-the-conflict*) echo hooked >> a.txt; echo hooked >> b.txt;; esac']\n`;
    const { wave } = await conflictingWave({
      files: { "b.txt": "b\n" },
      main: (repo) => {
        writeFileSync(join(repo, "factory.yaml"), `gates: []\n${hook}`);
        return commit(repo, "a.txt", "main's a\n", "main: change a");
      },
    });
    await pokeWave(WAVE);
    const record = await startedTask();
    const main = (await fold()).conflicts?.[0]?.onto ?? "";
    expect(readFileSync(join(record.worktree, "a.txt"), "utf8")).toBe(`<<<<<<< ${main}\nmain's a\n=======\nwave's a\n>>>>>>> ${wave}\n`);
    expect(readFileSync(join(record.worktree, "b.txt"), "utf8")).toBe("b\nhooked\n");
  }, 60_000);
});
