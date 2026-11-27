/**
 * Starts a factory task without an interactive session.
 *
 * - Consumes the primary checkout of a repo, a title, a request and settings overrides
 * - Provides `launchTask`: resolves the settings and the target branch (it must hold a committed `factory.yaml`),
 *   creates the task's worktree on a new branch
 *   (`agent-worktree` when it is on PATH, else `git worktree add`), runs the repo's `hooks.after_create` in it, writes
 *   the `TaskRecord` and starts the detached runner with `/factory start <json>`. A failing or aborted step undoes the
 *   earlier ones, through git only. A missing target branch or `factory.yaml` is the refusal `refused`
 * - Provides `sendCommand`: one more message to a task's session, through a new detached runner (the caller's `env`;
 *   `runnerSpawn` puts it in a systemd user scope when `systemd-run` is on PATH) that takes over the task lock its caller holds;
 *   `messageTask`: a message to the coder in any state but merging (`taskInboxPath` of a live runner, else a new
 *   runner); a state refusal is `refused`
 * - Provides `defaultBranch` and `localBranchExists`
 * - Provides `liveRunners`/`stopRunners` (a task's runner: the holder of its lock, `lockRunner`), `unmergedWork` and
 *   `deleteTask` (worktree, branch, record, log and inbox, removed through git: the task's own branch, never another)
 * - The detached spawn itself (`runnerSpawn`, `spawnDetached`) lives in `spawn.ts`, shared with the wave runner's poke
 */
import { existsSync } from "node:fs";
import { appendFile, mkdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseFactoryYaml } from "./config.ts";
import { contractsForLaunch } from "./contracts.ts";
import { git, primaryCheckout } from "./git.ts";
import { CODER_EXTENSIONS_ENV, CODER_MODEL_ENV, inboxReadPath, lastFactoryState, taskMainBranch } from "./runner.ts";
import { CommandRunner, runCommand, type Exec } from "./run.ts";
import { factoryHome, loadSettings, resolveSettings, taskModels, type ModelSize, type StoredSettings } from "./settings.ts";
import type { Settings, StartPayload } from "./state.ts";
import { onPath, spawnDetached, stopProcesses, type RunnerEnv } from "./spawn.ts";
import { handTaskLock, lockRunner, lockTask, removeTask, systemUser, taskLockPath, taskLogPath, tasksDir, unlockTask, writeTask, type TaskRecord } from "./tasks.ts";
import { TASK_WAVE_ENV, waveDir } from "./wave-poke.ts";
import { FactoryError, outputTail } from "./util.ts";

// `import.meta.dirname`, not Bun's `import.meta.dir`: inside Pi the latter is not this directory, and a runner would not start.
const RUNNER_PATH = join(import.meta.dirname, "runner.ts");
const SLUG_MAX_CHARS = 40;
const HOOK_TIMEOUT_MS = 10 * 60_000;

export type { RunnerEnv };

export async function localBranchExists(repo: string, branch: string): Promise<boolean> {
  const result = await runCommand(["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo });
  return result.exitCode === 0;
}

/** The branch `origin/HEAD` names, else `main`, else `master`: the first of them that exists locally. */
export async function defaultBranch(repo: string): Promise<string> {
  const originHead = await runCommand(["git", "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { cwd: repo, maxStdoutChars: 1000 });
  const candidates = originHead.exitCode === 0 ? [originHead.stdout.trim().replace(/^origin\//, ""), "main", "master"] : ["main", "master"];
  for (const branch of candidates) {
    if (branch !== "" && (await localBranchExists(repo, branch))) return branch;
  }
  throw new Error(`${repo}: no default branch (origin/HEAD, main and master do not exist locally)`);
}

/** The prompt that starts a task in its session; `prefix` (its contracts) goes before the request in the coder's first message only. */
function startCommand(title: string, request: string, settings: Settings, prefix?: string): string {
  const payload: StartPayload = { request, title, settings, ...(prefix === undefined ? {} : { prefix }) };
  return `/factory start ${JSON.stringify(payload)}`;
}

function slug(title: string): string {
  const text = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, SLUG_MAX_CHARS).replace(/^-+|-+$/g, "");
  return text === "" ? "task" : text;
}

/** `hooks.after_create` of the worktree's `factory.yaml` (the target branch's), none without the file. */
async function afterCreateHooks(worktree: string): Promise<string[][]> {
  const file = Bun.file(join(worktree, "factory.yaml"));
  if (!(await file.exists())) return [];
  return parseFactoryYaml(await file.text()).hooks.after_create;
}

/** The path of the worktree that has `branch` checked out, if any. */
async function worktreeOfBranch(repo: string, branch: string): Promise<string | undefined> {
  const result = await runCommand(["git", "worktree", "list", "--porcelain"], { cwd: repo, maxStdoutChars: 1_000_000 });
  if (result.exitCode !== 0) return undefined;
  for (const block of result.stdout.split("\n\n")) {
    const lines = block.split("\n");
    if (lines.includes(`branch refs/heads/${branch}`)) return lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
  }
  return undefined;
}

/** Best effort, through git only: removes the worktree at `path` and deletes `branch`, the task's own branch, when given. */
async function removeWorktree(repo: string, path: string | undefined, branch: string | undefined): Promise<void> {
  if (path !== undefined && existsSync(path)) await runCommand(["git", "worktree", "remove", "--force", path], { cwd: repo });
  await runCommand(["git", "worktree", "prune"], { cwd: repo });
  if (branch !== undefined && (await localBranchExists(repo, branch))) await runCommand(["git", "branch", "-D", branch], { cwd: repo });
}

/** Where a worktree named `name` of `repo` lies when `agent-worktree` does not choose. */
export function worktreePath(repo: string, name: string): string {
  return resolve(repo, "..", "worktrees", basename(repo), name);
}

/** The new worktree's path. A failure removes what the attempt left (a worktree on `name`, the branch `name`). */
async function createWorktree(exec: Exec, repo: string, name: string, base: string): Promise<string> {
  try {
    const agentWorktree = onPath("agent-worktree");
    if (agentWorktree !== null) {
      const result = await exec([agentWorktree, "create", name, "--base", base, "--background"], { cwd: repo, maxStdoutChars: 100_000 });
      if (result.exitCode !== 0 || result.killed) throw new Error(`agent-worktree create ${name}: ${outputTail(result.output)}`);
      const path = result.stdout.trim().split("\n").at(-1)?.trim() ?? "";
      if (path === "") throw new Error(`agent-worktree create ${name}: printed no path`);
      return path;
    }
    const path = worktreePath(repo, name);
    await git(exec, repo, ["worktree", "add", "-b", name, path, base]);
    return path;
  } catch (error) {
    await removeWorktree(repo, await worktreeOfBranch(repo, name), name).catch(() => undefined);
    throw error;
  }
}

/** Runs `hooks` (default: `hooks.after_create` of the worktree's `factory.yaml`) in `worktree`; throws on the first that fails. */
export async function runAfterCreate(exec: Exec, worktree: string, hooks?: string[][]): Promise<void> {
  for (const argv of hooks ?? (await afterCreateHooks(worktree))) {
    const result = await exec(argv, { cwd: worktree, timeoutMs: HOOK_TIMEOUT_MS });
    if (result.exitCode !== 0 || result.killed) {
      const why = result.timedOut ? "timed out" : `exit ${result.exitCode}`;
      throw new Error(`hooks.after_create ${argv.join(" ")} (${why}): ${outputTail(result.output)}`);
    }
  }
}

export interface LaunchInput {
  /** A path in the repository; the task records its primary checkout. */
  repo: string;
  title: string;
  request: string;
  overrides?: StoredSettings;
  /** Default: `systemUser()`. */
  tag?: string;
  plan?: string | null;
  /** Aborting it before the runner is started kills the running hook and undoes the launch. */
  signal?: AbortSignal;
  /** The runner's environment. */
  env?: RunnerEnv;
  /** Which of the resolved models the coder runs with; default `big`. */
  size?: ModelSize;
  /** The wave the task belongs to: only `waves.start`/`waves.add` (the scheduler) give one, never `tasks.start`. */
  wave?: string;
  /** The task's id, declared with a wave's task; default a new one. */
  id?: string;
  /** The Pi session that starts the task (`TaskRecord.origin`). */
  origin?: string | null;
  /** The wave's contracts (in the memory-store `plan`): read now, named in the coder's first message, stamped on the record. */
  contracts?: readonly string[];
  /**
   * Checked (and the new `worktree` prepared) once the worktree on the target `branch` exists, right before the record
   * is written; a throw undoes the start. `tasks.start` checks there again that no open wave owns the branch (a `waves.start` racing it).
   */
  beforeRecord?: (branch: string, worktree: string) => Promise<void>;
}

export async function launchTask(input: LaunchInput): Promise<TaskRecord> {
  const repo = await primaryCheckout(runCommand, input.repo).then(
    (checkout) => checkout.primary,
    () => {
      throw new Error(`${input.repo} is not inside a git repository`);
    },
  );
  const loaded = await loadSettings(repo);
  // A wave's task runs with the wave's models only (its declaration's, passed as overrides), never the stored ones.
  const stored = input.wave === undefined ? loaded : { ...loaded, models: undefined };
  const overrides = input.overrides ?? {};
  const explicit = overrides.branch ?? stored.branch;
  const fallback =
    explicit ??
    (await defaultBranch(repo).catch(() => {
      throw new FactoryError("refused", `${repo} has no default branch (origin/HEAD, main and master do not exist locally)`);
    }));
  const { branch, merge, maxRounds, review, models } = resolveSettings([stored, overrides], fallback);
  const settings: Settings = { branch, merge, maxRounds, review, models: taskModels(models, input.size) };
  if (!(await localBranchExists(repo, settings.branch))) throw new FactoryError("refused", `${repo}: branch ${settings.branch} does not exist locally`);
  const config = await runCommand(["git", "cat-file", "-e", `refs/heads/${settings.branch}:factory.yaml`], { cwd: repo });
  if (config.exitCode !== 0) {
    throw new FactoryError("refused", `${repo}: branch ${settings.branch} has no factory.yaml (write one with /factory init or the config.write action, and commit it)`);
  }
  const contracts = input.contracts !== undefined && input.contracts.length > 0 && input.plan ? await contractsForLaunch(input.plan, input.contracts) : undefined;

  const id = input.id ?? crypto.randomUUID();
  const name = `${slug(input.title)}-${id.slice(0, 8)}`;
  const commands = new CommandRunner();
  const abort = () => commands.cancel();
  const aborted = () => input.signal?.aborted === true;
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (aborted()) throw new Error("the start was aborted");
    const worktree = await createWorktree(commands.run, repo, name, settings.branch).catch((error: unknown) => {
      throw aborted() ? new Error("the start was aborted") : error;
    });
    let recorded = false;
    try {
      await runAfterCreate(commands.run, worktree);
      if (aborted()) throw new Error("the start was aborted");
      await input.beforeRecord?.(settings.branch, worktree);
      const record: TaskRecord = {
        id,
        repo,
        worktree,
        branch: name,
        title: input.title,
        sessionId: crypto.randomUUID(),
        sessionDir: input.wave === undefined ? join(factoryHome(), "sessions", repoDirName(repo)) : join(waveDir(input.wave), "sessions"),
        createdAt: new Date().toISOString(),
        tag: input.tag ?? systemUser(),
        plan: input.plan ?? null,
        wave: input.wave ?? null,
        origin: input.origin ?? null,
        ...(contracts === undefined ? {} : { contracts: contracts.stamps }),
      };
      await writeTask(record);
      recorded = true;
      await lockTask(id);
      const coder = settings.models.coder;
      await sendCommand(record, startCommand(input.title, input.request, settings, contracts?.prefix), { ...(input.env ?? process.env), ...(coder ? { [CODER_MODEL_ENV]: coder } : {}) });
      return record;
    } catch (error) {
      if (recorded) await removeTask(id).catch(() => undefined);
      await removeWorktree(repo, worktree, name).catch(() => undefined);
      throw aborted() ? new Error("the start was aborted") : error;
    }
  } finally {
    input.signal?.removeEventListener("abort", abort);
  }
}

/**
 * Starts `bun runner.ts` for `message` in its own process group, detached, output appended to the task's log, with
 * `env` (default `process.env`) plus the lock path, the task's wave (`TASK_WAVE_ENV`, which the runner pokes when
 * it ends with the task at rest) and the repository's `extensions` setting (`CODER_EXTENSIONS_ENV`). The caller holds
 * the task lock (`lockTask`): it passes to the runner, which removes it when it exits.
 */
export async function sendCommand(record: TaskRecord, message: string, env: RunnerEnv = process.env): Promise<void> {
  const bun = onPath("bun");
  if (bun === null) throw new Error("bun is not on PATH: the task runner needs it");
  await mkdir(tasksDir(), { recursive: true });
  await mkdir(record.sessionDir, { recursive: true });
  const { [TASK_WAVE_ENV]: _wave, ...base } = env;
  const { extensions } = await loadSettings(record.repo);
  const pid = await spawnDetached(
    [bun, RUNNER_PATH, record.worktree, record.sessionDir, record.sessionId, taskInboxPath(record.id), message],
    // A task runs without pauses, so the default short prompt cache is enough and the dearer long cache writes are not.
    {
      ...base,
      FACTORY_TASK_LOCK: taskLockPath(record.id),
      PI_CACHE_RETENTION: "short",
      [CODER_EXTENSIONS_ENV]: extensions === undefined ? undefined : JSON.stringify(extensions),
      ...(record.wave === null ? {} : { [TASK_WAVE_ENV]: record.wave }),
    },
    taskLogPath(record.id),
    dirname(RUNNER_PATH),
  );
  if (pid !== undefined) await handTaskLock(record.id, pid);
}

/** The messages for a task's live runner, one JSON `{"text"}` per line; the runner stores how far it sent them in `<inbox>.read`. */
export function taskInboxPath(id: string): string {
  return join(tasksDir(), `${id}.inbox`);
}

/**
 * A message for the task's coder. A live runner holds the task: one line in its inbox, which it sends to Pi as a
 * follow-up. Resting or interrupted: takes the task lock and starts a runner with `text` as the prompt and `env`, the
 * lock handed to it. Refuses (`refused`, one sentence) while the task merges or before it has a state, a
 * `busy` FactoryError while another holds its lock.
 */
export async function messageTask(record: TaskRecord, text: string, env?: RunnerEnv): Promise<void> {
  const refuseState = async () => {
    const state = await lastFactoryState(record.sessionDir, record.sessionId);
    if (state === undefined) throw new FactoryError("refused", `task ${record.id.slice(0, 8)} has not started yet, send the message once it runs`);
    if (state.state === "merging") throw new FactoryError("refused", `task ${record.id.slice(0, 8)} is merging, send the message when the merge has ended`);
  };
  const toInbox = async () => {
    await mkdir(tasksDir(), { recursive: true });
    await appendFile(taskInboxPath(record.id), `${JSON.stringify({ text })}\n`, "utf8");
  };
  await refuseState();
  if ((await liveRunners(record)).length > 0) return toInbox();
  await lockTask(record.id);
  try {
    await refuseState();
    if ((await liveRunners(record)).length > 0) throw new FactoryError("busy", `task ${record.id.slice(0, 8)} is busy: its last runner is still ending, try again in a few seconds`);
    if ((await lastFactoryState(record.sessionDir, record.sessionId))?.state === "done") await restoreWorktree(record);
    await sendCommand(record, text, env);
  } finally {
    await unlockTask(record.id);
  }
}

/**
 * The worktree of a done task that is gone, made again before a runner starts in it: on the task branch when that
 * still exists, else on a new one off the target branch. `git worktree prune` first drops the stale entry.
 */
export async function restoreWorktree(record: TaskRecord): Promise<void> {
  if (existsSync(record.worktree)) return;
  const target = await taskMainBranch(record.sessionDir, record.sessionId);
  await git(runCommand, record.repo, ["worktree", "prune"]);
  if (await localBranchExists(record.repo, record.branch)) await git(runCommand, record.repo, ["worktree", "add", "--quiet", record.worktree, record.branch]);
  else if (target !== undefined) await git(runCommand, record.repo, ["worktree", "add", "--quiet", "-b", record.branch, record.worktree, `refs/heads/${target}`]);
  else throw new Error(`the worktree ${record.worktree} is gone and the task's target branch is unknown`);
}

/** The task's live runner: the holder of its lock (`lockRunner`), named by the task's session id; as a list. */
export async function liveRunners(record: Pick<TaskRecord, "id" | "sessionId">): Promise<number[]> {
  const pid = await lockRunner(taskLockPath(record.id), record.sessionId);
  return pid === null ? [] : [pid];
}

/** Ends the task's runners (SIGTERM: the runner closes Pi's stdin). */
export function stopRunners(record: Pick<TaskRecord, "id" | "sessionId">): Promise<void> {
  return stopProcesses(() => liveRunners(record), `the runner of task ${record.sessionId}`);
}

/** What removing the task would drop: commits on its branch that `target` lacks, uncommitted changes in its worktree. */
export interface UnmergedWork {
  commits: number;
  dirty: boolean;
}

/**
 * The task's unmerged work. Without a `target` (the task never recorded one) its commits are those no other local
 * branch has. A worktree whose status cannot be read counts as dirty.
 */
export async function unmergedWork(record: TaskRecord, target: string | undefined): Promise<UnmergedWork> {
  let commits = 0;
  if (await localBranchExists(record.repo, record.branch)) {
    const range =
      target !== undefined && (await localBranchExists(record.repo, target))
        ? [`refs/heads/${target}..refs/heads/${record.branch}`]
        : // `--exclude` matches what `--branches` lists: names below refs/heads/.
          [`refs/heads/${record.branch}`, "--not", `--exclude=${record.branch}`, "--branches"];
    commits = Number(await git(runCommand, record.repo, ["rev-list", "--count", ...range]));
  }
  let dirty = false;
  if (existsSync(record.worktree)) {
    const status = await runCommand(["git", "status", "--porcelain", "--untracked-files=normal"], { cwd: record.worktree, maxStdoutChars: 1000 });
    dirty = status.exitCode !== 0 || status.stdout.trim() !== "";
  }
  return { commits, dirty };
}

/**
 * Removes the task's worktree, its own branch (through git), its record,
 * its runner log, its lock and its inbox. The session file stays.
 */
export async function deleteTask(record: TaskRecord): Promise<void> {
  const { branch } = record;
  await removeWorktree(record.repo, record.worktree, branch);
  if (existsSync(record.worktree)) throw new Error(`${record.worktree}: the worktree could not be removed`);
  if (await localBranchExists(record.repo, branch)) throw new Error(`${record.repo}: the branch ${branch} could not be deleted`);
  await removeTask(record.id);
  await rm(taskInboxPath(record.id), { force: true });
  await rm(inboxReadPath(taskInboxPath(record.id)), { force: true });
}

/** Pi's directory name of a path (`/a/b` -> `--a-b--`): one sessions folder per repository, as pi-host names it. */
function repoDirName(repo: string): string {
  return `--${resolve(repo).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}
