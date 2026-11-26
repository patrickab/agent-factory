/**
 * The conflict task (throughput/1): a wave whose rebase onto its target conflicts (not additions-only) builds again
 * with a task whose worktree holds the markers. Real git repos, the core kit's fake `pi` for the task, a fake reviewer
 * (`--mode json`) in front of it, a detached wave runner.
 */
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { caseDir, fakeBin, git, makeRepo, RUN, scratch, until, useCoreFixture, writeSession } from "./core-test-kit.ts";
import { stopRunners } from "./launch.ts";
import { listTasks, writeTask, type TaskRecord } from "./tasks.ts";
import { pokeWave } from "./wave-poke.ts";
import { appendWaveEvent, createWave, foldWave, readWave } from "./waves.ts";

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

/** A repo whose wave (one done task) changed the line of a.txt that main changed too. */
async function conflictingWave(): Promise<{ repo: string; wave: string; main: string }> {
  const repo = makeRepo();
  const base = git(repo, "rev-parse", "main");
  git(repo, "branch", BRANCH);
  const work = join(caseDir, "work");
  git(repo, "worktree", "add", "--quiet", work, BRANCH);
  const wave = commit(work, "a.txt", "wave's a\n", "feat: change a");
  git(repo, "worktree", "remove", work);
  const main = commit(repo, "a.txt", "main's a\n", "main: change a");
  await createWave({ id: WAVE, repo, tag: "factory/w1", plan: null, title: "Wave one", request: "Check a.", branch: BRANCH, target: "main", base, origin: null, createdAt: "2026-01-01T00:00:00.000Z", overrides: {} });
  await appendWaveEvent(WAVE, { kind: "tasks", tasks: [{ key: "a", title: "Change a", request: "change a", after: [] }] });
  const record: TaskRecord = { id: `41000000-${RUN}-4000-8000-000000000001`, repo, worktree: join(caseDir, "task-a"), branch: "task-a", title: "Change a", sessionId: `session-${RUN}-a`, sessionDir: join(caseDir, "sessions"), createdAt: "2026-01-01T00:00:01.000Z", tag: "factory/w1", plan: null, wave: WAVE, origin: null };
  await writeTask(record);
  writeSession(record, [{ type: "custom", customType: "factory-state", data: { state: "done", round: 1, reason: "merged" } }]);
  await appendWaveEvent(WAVE, { kind: "task", key: "a", taskId: record.id, sessionId: record.sessionId });
  return { repo, wave, main };
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
    appendFileSync(join(record.sessionDir, `2026-01-01T00-00-00-000Z_${record.sessionId}.jsonl`), `${JSON.stringify({ type: "custom", customType: "factory-state", data: { state: "done", round: 1, reason: "merged" } })}\n`);
    await pokeWave(WAVE);
    await until(async () => (await fold()).stage === "merged", 20_000);
    expect(git(repo, "show", "main:a.txt")).toBe("both a");
    expect((await fold()).tasks.map((task) => task.key)).toEqual(["a", "conflict-1"]);
  }, 60_000);
});
