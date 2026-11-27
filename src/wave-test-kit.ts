/**
 * What the wave runner's tests (`wave-runner.test.ts`, `wave-squash.test.ts`) share: real git repos in a temp dir, the
 * wave's tasks as records whose sessions say `done` and whose work is committed on the wave's branch, and the reviewer
 * as a fake `pi` on PATH (`--mode json`, an approving `submit_verdict` call; it notes its prompt in `$FAKE_PROMPT_LOG`
 * and sleeps `$FAKE_REVIEW_SLEEP` ms when set).
 *
 * - `useWaveFixture()`, called once at the top of a test file: its own scratch dir with the fake `pi`, a fresh case
 *   dir (`caseDir`) and environment per test, every wave runner stopped after each, the scratch dir removed after the file
 */
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callAction } from "./core.ts";
import { worktreePath } from "./launch.ts";
import { git } from "./scenario-kit.ts";
import { writeTask, type TaskRecord } from "./tasks.ts";
import { caseDigits, caseSerial } from "./test-case.ts";
import { lockWave, stopWaveRunners, unlockWave } from "./wave-poke.ts";
import { appendWaveEvent, createWave, listWaves, type WaveView } from "./waves.ts";

export let caseDir: string;
export let promptLog: string;

/** Sets up the test file's fixture and registers its hooks; call once at the top of the file. */
export function useWaveFixture(): void {
  const savedEnv = { ...process.env };
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "factory-wave-test-")));
  const fakeBin = join(scratch, "bin");
  promptLog = join(scratch, "reviewer-prompt.txt");
  let caseCount = 0;
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
writeFileSync(process.env.FAKE_PROMPT_LOG, args.at(-1));
if (process.env.FAKE_REVIEW_SLEEP) await Bun.sleep(Number(process.env.FAKE_REVIEW_SLEEP));
const emit = (record) => console.log(JSON.stringify(record));
emit({ type: "session", id });
emit({ type: "tool_execution_end", toolName: "submit_verdict", isError: false, result: { details: { findings: [] } } });
emit({ type: "message_end", message: { role: "assistant", usage: { input: 100, output: 20, cacheRead: 900, cacheWrite: 30, cost: { total: 0.5 } } } });
`,
  );
  chmodSync(join(fakeBin, "pi"), 0o755);

  beforeEach(() => {
    caseDir = join(scratch, `case-${++caseCount}`);
    mkdirSync(caseDir);
    Object.assign(process.env, {
      PATH: `${fakeBin}:${savedEnv.PATH ?? ""}`,
      HOME: scratch,
      PI_CODING_AGENT_DIR: join(caseDir, "agent"),
      FAKE_PROMPT_LOG: promptLog,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "test",
      GIT_COMMITTER_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_EMAIL: "test@example.com",
    });
    delete process.env.FAKE_REVIEW_SLEEP;
    rmSync(promptLog, { force: true });
  });

  afterEach(async () => {
    for (const wave of await listWaves()) await stopWaveRunners(wave.declaration.id);
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
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

/**
 * A repo on `main` with `factory.yaml` (`config`), the wave's branch off it holding one commit per task (a adds b.txt,
 * then b after a adds c.txt), the tasks' records with sessions in `state`, and the wave's log of them. Returns the repo.
 */
export async function waveRepo(config = 'gates:\n  - ["true"]\n', state = "done", overrides: object = {}): Promise<string> {
  const repo = join(caseDir, "repo");
  mkdirSync(repo);
  git(repo, "init", "--quiet", "-b", "main");
  writeFileSync(join(repo, "factory.yaml"), config);
  commit(repo, "a.txt", "a\n", "init");
  const base = git(repo, "rev-parse", "main");
  git(repo, "branch", BRANCH);
  // The tasks' merges into the wave's branch, as their runs left them: one commit each.
  const work = join(caseDir, "work");
  git(repo, "worktree", "add", "--quiet", work, BRANCH);
  commit(work, "b.txt", "b\n", "feat: add b");
  commit(work, "c.txt", "c\n", "feat: add c");
  git(repo, "worktree", "remove", work);
  await createWave({ id: WAVE(), repo, tag: TAG, plan: null, title: "Wave one", request: "Check b and c.\nKeep it small.", branch: BRANCH, target: "main", base, origin: null, createdAt: "2026-01-01T00:00:00.000Z", overrides });
  const specs = [
    { key: "a", title: "Add b", request: "add b", after: [], id: crypto.randomUUID() },
    { key: "b", title: "Add c", request: "add c", after: ["a"], id: crypto.randomUUID() },
  ];
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
    setState(spec.key, state);
    await appendWaveEvent(WAVE(), { kind: "task", key: spec.key, taskId: record.id, sessionId: record.sessionId });
  }
  return repo;
}

/** Overwrites the session of the wave's task `key` with one state. */
export function setState(key: string, state: string): void {
  mkdirSync(join(caseDir, "sessions"), { recursive: true });
  writeFileSync(join(caseDir, "sessions", `2026-01-01T00-00-00-000Z_session-${RUN}-${caseSerial()}-${key}.jsonl`), `${JSON.stringify({ type: "custom", customType: "factory-state", data: { state, round: 1, reason: "r" } })}\n`);
}

export const getWave = async (): Promise<WaveView> => ((await callAction("waves.get", { id: WAVE() })) as { wave: WaveView }).wave;
export const reviewWorktree = (repo: string): string => worktreePath(repo, `wave-${WAVE().slice(0, 8)}-review`);

/** Holds the runner's lock in this process while `act` runs: a poke leaves its marker and starts no runner. */
export async function holding<T>(act: () => Promise<T>): Promise<T> {
  await lockWave(WAVE());
  try {
    return await act();
  } finally {
    await unlockWave(WAVE());
  }
}
