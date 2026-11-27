/**
 * A `squash` wave lands as one commit (`wave-runner.ts` `merge`, `merge.ts` `squashCommit`), over real git repos in a
 * temp dir: the wave's tasks are records whose sessions say `done`, their work commits on the wave's branch, the
 * reviewer a fake `pi` on PATH that approves.
 */
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { caseDigits, caseSerial, caseTests } from "./test-case.ts";
import { callAction } from "./core.ts";
import { worktreePath } from "./launch.ts";
import { writeTask, type TaskRecord } from "./tasks.ts";
import { stopWaveRunners } from "./wave-poke.ts";
import { runWave, waveCommitsRef } from "./wave-runner.ts";
import { appendWaveEvent, createWave, listWaves, lockWave, readWave, unlockWave, wavePath, type WaveView } from "./waves.ts";

const test = caseTests();
const savedEnv = { ...process.env };
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "factory-wave-squash-test-")));
const fakeBin = join(scratch, "bin");

mkdirSync(fakeBin);
writeFileSync(
  join(fakeBin, "pi"),
  `#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (!args.includes("json")) process.exit(3);
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
chmodSync(join(fakeBin, "pi"), 0o755);

let caseDir: string;
let caseCount = 0;

beforeEach(() => {
  caseDir = join(scratch, `case-${++caseCount}`);
  mkdirSync(caseDir);
  Object.assign(process.env, {
    PATH: `${fakeBin}:${savedEnv.PATH ?? ""}`,
    HOME: scratch,
    PI_CODING_AGENT_DIR: join(caseDir, "agent"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "test",
    GIT_COMMITTER_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_EMAIL: "test@example.com",
  });
});

afterEach(async () => {
  for (const wave of await listWaves()) await stopWaveRunners(wave.declaration.id);
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitOk(cwd: string, ...args: string[]): boolean {
  try {
    git(cwd, ...args);
    return true;
  } catch {
    return false;
  }
}

function commit(cwd: string, file: string, text: string, message: string): string {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", "-A");
  git(cwd, "commit", "--quiet", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

const RUN = randomBytes(2).toString("hex");
const WAVE = (): string => `32000000-${RUN}-4000-8000-${caseDigits()}`;
const BRANCH = "main-squash-w1";
const TAG = "squash/w1";
const REF = () => waveCommitsRef({ id: WAVE(), tag: TAG });
const taskId = (n: number) => `42000000-${RUN}-4000-8000-${caseDigits(caseSerial() * 10 + n)}`;

/**
 * A repo on `main` with `factory.yaml` (`config`), the wave's branch off it holding one commit per task (`files`), the
 * tasks' records with `done` sessions, and the wave's log. Returns the repo.
 */
async function waveRepo(overrides: object = { squash: true }, files = ["b", "c"], config = 'gates:\n  - ["true"]\n'): Promise<string> {
  const repo = join(caseDir, "repo");
  mkdirSync(repo);
  git(repo, "init", "--quiet", "-b", "main");
  writeFileSync(join(repo, "factory.yaml"), config);
  commit(repo, "a.txt", "a\n", "init");
  const base = git(repo, "rev-parse", "main");
  git(repo, "branch", BRANCH);
  const work = join(caseDir, "work");
  git(repo, "worktree", "add", "--quiet", work, BRANCH);
  for (const file of files) commit(work, `${file}.txt`, `${file}\n`, `feat: add ${file}`);
  git(repo, "worktree", "remove", work);
  await createWave({ id: WAVE(), repo, tag: TAG, plan: null, title: "Wave one", request: "r", branch: BRANCH, target: "main", base, origin: null, createdAt: "2026-01-01T00:00:00.000Z", overrides });
  const specs = files.map((file, index) => ({ key: file, title: `Add ${file}`, request: `add ${file}`, after: index === 0 ? [] : [files[index - 1]], id: crypto.randomUUID() }));
  await appendWaveEvent(WAVE(), { kind: "tasks", tasks: specs });
  for (const [index, spec] of specs.entries()) {
    const record: TaskRecord = {
      id: taskId(index + 1),
      repo,
      worktree: join(caseDir, `task-${spec.key}`),
      branch: `task-${spec.key}`,
      title: spec.title,
      sessionId: `session-${RUN}-${caseSerial()}-${spec.key}`,
      sessionDir: join(caseDir, "sessions"),
      createdAt: `2026-01-01T00:00:0${index + 1}.000Z`,
      tag: TAG,
      plan: null,
      wave: WAVE(),
      origin: null,
    };
    await writeTask(record);
    mkdirSync(record.sessionDir, { recursive: true });
    const entry = { type: "custom", customType: "factory-state", data: { state: "done", round: 1, reason: "r" } };
    writeFileSync(join(record.sessionDir, `2026-01-01T00-00-00-000Z_${record.sessionId}.jsonl`), `${JSON.stringify(entry)}\n`);
    await appendWaveEvent(WAVE(), { kind: "task", key: spec.key, taskId: record.id, sessionId: record.sessionId });
  }
  return repo;
}

const getWave = async () => ((await callAction("waves.get", { id: WAVE() })) as { wave: WaveView }).wave;
const kinds = async () => (await readWave(WAVE())).events.map((event) => ("stage" in event ? event.stage : event.kind));
const reviewWorktree = (repo: string) => worktreePath(repo, `wave-${WAVE().slice(0, 8)}-review`);
const branchExists = (repo: string) => gitOk(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH}`);

/** Cuts the wave's log back to before its `merge` event: as if its runner died after the target moved. */
function forgetLanding(): void {
  const lines = readFileSync(wavePath(WAVE()), "utf8").split("\n").filter(Boolean);
  const at = lines.findIndex((line) => (JSON.parse(line) as { kind?: string }).kind === "merge");
  expect(at).toBeGreaterThan(0);
  writeFileSync(wavePath(WAVE()), `${lines.slice(0, at).join("\n")}\n`);
}

/** What a landed squash wave of `subjects` on `from` must look like: one commit, the ref, no branch, one merge event. */
async function expectLanded(repo: string, from: string, subjects: string[]): Promise<void> {
  const wave = await getWave();
  expect(wave.stage).toBe("merged");
  const main = git(repo, "rev-parse", "main");
  expect(git(repo, "rev-parse", "main^")).toBe(from);
  expect(git(repo, "log", "--reverse", "--format=%s", `${from}..${REF()}`)).toBe(subjects.join("\n"));
  expect(git(repo, "rev-parse", "main^{tree}")).toBe(git(repo, "rev-parse", `${REF()}^{tree}`));
  expect(branchExists(repo)).toBe(false);
  expect(existsSync(reviewWorktree(repo))).toBe(false);
  expect(wave.merge).toEqual({ at: expect.any(String), from, to: main, ref: REF(), commits: subjects.length });
  expect((await kinds()).filter((kind) => kind === "merge")).toHaveLength(1);
}

describe("a squash wave", () => {
  test("a rerun after the move, the branch still there: no second commit, the branch deleted, one merge event", async () => {
    const repo = await waveRepo();
    const init = git(repo, "rev-parse", "main");
    expect(await runWave(WAVE())).toBe(0);
    const landed = git(repo, "rev-parse", "main");
    forgetLanding();
    git(repo, "branch", BRANCH, REF());
    expect(await runWave(WAVE())).toBe(0);
    expect(git(repo, "rev-parse", "main")).toBe(landed);
    await expectLanded(repo, init, ["feat: add b", "feat: add c"]);
  });

  test("a rerun after the branch was deleted: the landing is recognised from git, one merge event", async () => {
    const repo = await waveRepo();
    const init = git(repo, "rev-parse", "main");
    expect(await runWave(WAVE())).toBe(0);
    const landed = git(repo, "rev-parse", "main");
    forgetLanding();
    expect(await runWave(WAVE())).toBe(0);
    expect(git(repo, "rev-parse", "main")).toBe(landed);
    await expectLanded(repo, init, ["feat: add b", "feat: add c"]);
  });

  test("the target moved between the merge gates and the move: rebased again, then one commit on the new tip", async () => {
    // The gate commits to main on its 2nd and 3rd run: after the review's run and after the merge's first.
    const count = join(caseDir, "gate-runs");
    const repoPath = join(caseDir, "repo");
    const gate = `echo run >> ${count}; n=$(wc -l < ${count}); if [ $n -ge 2 ] && [ $n -le 3 ]; then echo $n > ${repoPath}/m$n.txt && git -C ${repoPath} add m$n.txt && git -C ${repoPath} commit --quiet -m "main: m$n"; fi`;
    const repo = await waveRepo({ squash: true, merge: "review" }, ["b", "c"], `gates:\n  - ["true"]\nmerge_gates:\n  - ["sh", "-c", ${JSON.stringify(gate)}]\n`);
    await runWave(WAVE());
    expect((await getWave()).stage).toBe("waiting_approve");
    commit(repo, "d.txt", "d\n", "main: add d");
    // Held: the approve's poke starts no runner of its own.
    await lockWave(WAVE());
    try {
      await callAction("waves.approve", { id: WAVE() });
    } finally {
      await unlockWave(WAVE());
    }
    expect(await runWave(WAVE())).toBe(0);
    const runs = readFileSync(count, "utf8").split("\n").filter(Boolean).length;
    // The review's run, then the merge's three: two found the target moved after them.
    expect(runs).toBe(4);
    expect(git(repo, "log", "--format=%s", "main")).toBe("Wave one\nmain: m3\nmain: m2\nmain: add d\ninit");
    await expectLanded(repo, git(repo, "rev-parse", "main^"), ["feat: add b", "feat: add c"]);
  }, 30_000);

  test("squash off: the task commits land as they are, the branch stays, no ref, the merge event as before", async () => {
    const repo = await waveRepo({});
    const init = git(repo, "rev-parse", "main");
    expect(await runWave(WAVE())).toBe(0);
    const wave = await getWave();
    expect(git(repo, "log", "--format=%s", "main")).toBe("feat: add c\nfeat: add b\ninit");
    expect(git(repo, "rev-parse", BRANCH)).toBe(git(repo, "rev-parse", "main"));
    expect(git(repo, "for-each-ref", "refs/factory/waves")).toBe("");
    expect(wave.merge).toEqual({ at: expect.any(String), from: init, to: git(repo, "rev-parse", "main") });
  });
});
