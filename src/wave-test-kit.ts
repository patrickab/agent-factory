/**
 * What the wave runner's tests share: real git repos in a temp dir, the wave's tasks as records with sessions of
 * their own, and the fake `pi` of `core-test-kit.ts` on PATH (the reviewer; a task's Pi when a verdict is handed over).
 *
 * - `const test = useWaveFixture()`, once at the top of a test file: its own scratch dir, a fresh case dir (`caseDir`)
 *   and environment per test, every wave runner stopped after each, the scratch dir removed after the file
 */
import { randomBytes } from "node:crypto";
import { afterAll, afterEach } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callAction } from "./core.ts";
import { stopRunners, worktreePath } from "./launch.ts";
import { caseDigits, caseSerial, caseTests, git, GIT_ENV, removeHome, restoreEnv, TASK_ENTRY, writeFakePi } from "./core-test-kit.ts";
import { listTasks, writeTask, type TaskRecord } from "./tasks.ts";
import { lockWave, stopWaveRunners, waveLockPath } from "./wave-poke.ts";
import { unlockFile } from "./lock.ts";
import { appendWaveEvent, createWave, listWaves, type WaveView } from "./waves.ts";

export let caseDir: string;
type Overrides = Parameters<typeof createWave>[0]["overrides"];

/** Sets up the test file's fixture and registers its hooks; answers the file's `test`. */
export function useWaveFixture(): ReturnType<typeof caseTests> {
  const savedEnv = { ...process.env };
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "factory-wave-test-")));
  writeFakePi(join(scratch, "bin"));
  afterEach(async () => {
    // Every runner a test started, before the home goes: wave runners first, they would start tasks.
    for (const wave of await listWaves()) await stopWaveRunners(wave.declaration.id);
    for (const record of await listTasks()) await stopRunners(record);
    restoreEnv(savedEnv);
  });
  afterAll(() => removeHome(scratch));
  return caseTests(() => {
    caseDir = join(scratch, `case-${caseSerial()}`);
    mkdirSync(caseDir);
    Object.assign(process.env, { PATH: `${join(scratch, "bin")}:${savedEnv.PATH ?? ""}`, HOME: scratch, PI_CODING_AGENT_DIR: join(caseDir, "agent"), FAKE_PI_LOG: join(caseDir, "fake-pi.log"), ...GIT_ENV });
  });
}

export function commit(cwd: string, file: string, text: string, message: string): string {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", "-A");
  git(cwd, "commit", "--quiet", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

/** Part of every fixed id and session id here: a concurrent test run (another worktree) never matches these runners. */
export const RUN = randomBytes(2).toString("hex");
export const WAVE = (): string => `30000000-${RUN}-4000-8000-${caseDigits()}`;
export const TAG = "factory/w1";
export const BRANCH = "main-factory-w1";
export const taskId = (n: number): string => `40000000-${RUN}-4000-8000-${caseDigits(caseSerial() * 10 + n)}`;

/** The record of the wave's task `key`, the `n`th: its worktree `task-<key>` under the case dir (not made). */
export function taskRecord(repo: string, key: string, n: number): TaskRecord {
  const branch = `task-${key}`;
  return { id: taskId(n), repo, worktree: join(caseDir, branch), branch, title: `Task ${key}`, sessionId: `session-${RUN}-${caseSerial()}-${key}`, sessionDir: join(caseDir, "sessions"), createdAt: `2026-01-01T00:00:0${n}.000Z`, tag: TAG, plan: null, wave: WAVE(), origin: null, start: "" };
}

/** A repo on `main` with `factory.yaml` (`config`) and the wave's branch off it; `onBranch` commits there before the wave is declared with `specs`. */
async function declareWave(config: string, specs: { key: string; after: string[] }[], overrides: Overrides, onBranch: (work: string) => void = () => {}): Promise<string> {
  const repo = join(caseDir, "repo");
  mkdirSync(repo);
  git(repo, "init", "--quiet", "-b", "main");
  writeFileSync(join(repo, "factory.yaml"), config);
  commit(repo, "a.txt", "a\n", "init");
  const base = git(repo, "rev-parse", "main");
  git(repo, "branch", BRANCH);
  const work = join(caseDir, "work");
  git(repo, "worktree", "add", "--quiet", work, BRANCH);
  onBranch(work);
  git(repo, "worktree", "remove", work);
  await createWave({ id: WAVE(), repo, tag: TAG, plan: null, title: "Wave one", request: "Check b and c.\nKeep it small.", branch: BRANCH, target: "main", base, origin: null, createdAt: "2026-01-01T00:00:00.000Z", overrides });
  await appendWaveEvent(WAVE(), { kind: "tasks", tasks: specs.map(({ key, after }) => ({ key, title: `Task ${key}`, request: `do ${key}`, after, id: crypto.randomUUID() })) });
  return repo;
}

/** Writes the task's record, its session resting in `state`, and the wave's `task` event of it. */
async function addTask(record: TaskRecord, key: string, state: string): Promise<void> {
  await writeTask(record);
  setState(key, state);
  await appendWaveEvent(WAVE(), { kind: "task", key, taskId: record.id, sessionId: record.sessionId });
}

/**
 * A wave whose tasks' runs are over: the wave's branch holds one commit per task (a adds b.txt, then b after a adds
 * c.txt), the tasks' sessions rest in `state`. Returns the repo.
 */
export async function waveRepo(config = 'gates:\n  - ["true"]\n', state = "done", overrides: Overrides = {}): Promise<string> {
  const specs = [
    { key: "a", after: [] },
    { key: "b", after: ["a"] },
  ];
  const repo = await declareWave(config, specs, overrides, (work) => {
    commit(work, "b.txt", "b\n", "feat: add b");
    commit(work, "c.txt", "c\n", "feat: add c");
  });
  for (const [index, { key }] of specs.entries()) await addTask(taskRecord(repo, key, index + 1), key, state);
  return repo;
}

/** A wave whose tasks `keys` each rest in `state` in a worktree off the wave's branch holding an uncommitted `<key>.txt`. */
export async function eachWave(keys: string[], state = "reviewing"): Promise<string> {
  const repo = await declareWave('gates:\n  - ["true"]\n', keys.map((key) => ({ key, after: [] })), {});
  for (const [index, key] of keys.entries()) {
    const record = taskRecord(repo, key, index + 1);
    git(repo, "worktree", "add", "--quiet", "-b", record.branch, record.worktree, BRANCH);
    writeFileSync(join(record.worktree, `${key}.txt`), `${key} one\n`);
    await addTask(record, key, state);
  }
  return repo;
}

/** The session file of the wave's task `key`. */
export const sessionPath = (key: string): string => join(caseDir, "sessions", `2026-01-01T00-00-00-000Z_session-${RUN}-${caseSerial()}-${key}.jsonl`);

/** Appends a state to the session of the wave's task `key` (made with its task entry when missing). */
export function setState(key: string, state: string, round = 1): void {
  mkdirSync(join(caseDir, "sessions"), { recursive: true });
  if (!existsSync(sessionPath(key))) writeFileSync(sessionPath(key), `${JSON.stringify(TASK_ENTRY)}\n`);
  appendFileSync(sessionPath(key), `${JSON.stringify({ type: "custom", customType: "factory-state", timestamp: "2026-01-01T00:00:00.000Z", data: { state, round, reason: "r" } })}\n`);
}

export const getWave = async (): Promise<WaveView> => ((await callAction("waves.get", { id: WAVE() })) as { wave: WaveView }).wave;
export const reviewWorktree = (repo: string): string => worktreePath(repo, `wave-${WAVE().slice(0, 8)}-review`);

/** Holds the runner's lock in this process while `act` runs: a poke leaves its marker and starts no runner. */
export async function holding<T>(act: () => Promise<T>): Promise<T> {
  await lockWave(WAVE());
  try {
    return await act();
  } finally {
    await unlockFile(waveLockPath(WAVE()));
  }
}
