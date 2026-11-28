/**
 * Starts a factory task without an interactive session, and sends its session more messages.
 * - `launchTask`: worktree on a new branch, `hooks.after_create`, the detached runner with `/factory start`, the
 *   `TaskRecord`, the wait until it wrote its first state. A failing or aborted step undoes the earlier ones,
 *   through git only
 * - `sendCommand` and `messageTask` reach the session through a new runner that takes over the task lock, or through
 *   the inbox of a live one
 * - `deleteTask` removes through git only the task's own branch, never another
 */
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseFactoryYaml } from "./config.ts";
import { contractsForLaunch } from "./contracts.ts";
import { git, primaryCheckout } from "./git.ts";
import { CODER_EXTENSIONS_ENV, inboxReadPath, lastFactoryState, readFactoryStates, readInboxOffset, takeInboxLine, taskMainBranch, withdrawInboxLine } from "./runner.ts";
import { CommandRunner, runCommand, type Exec } from "./run.ts";
import { factoryHome, loadSettings, resolveSettings, taskModels, type ModelSize, type StoredSettings } from "./settings.ts";
import { isFinal, type Settings, type StartPayload, type State } from "./state.ts";
import { lockRunner, startRunner, unlockFile, withLock } from "./lock.ts";
import { onPath, stopProcesses, type RunnerEnv } from "./spawn.ts";
import { lockTask, removeTask, systemUser, taskLockPath, taskLogPath, tasksDir, writeTask, type TaskRecord } from "./tasks.ts";
import { TASK_WAVE_ENV, waveDir } from "./wave-poke.ts";
import { FactoryError, isBusy, outputTail, short } from "./util.ts";

// `import.meta.dirname`, not Bun's `import.meta.dir`: inside Pi the latter is not this directory, and a runner would not start.
const RUNNER_PATH = join(import.meta.dirname, "runner.ts");
const SLUG_MAX_CHARS = 40;
const HOOK_TIMEOUT_MS = 10 * 60_000;
const INBOX_POLL_MS = 100;
/** How long a start, or a cancel or retry of an interrupted task, waits for its runner to write a state or end. */
const RUNNER_START_WAIT_MS = 15_000;

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
  throw new FactoryError("refused", `${repo} has no default branch (origin/HEAD, main and master do not exist locally)`);
}

/**
 * The target branch of a repository: `given`, else the stored one, else the default branch. Unless `config` is false
 * it must also exist locally and hold a committed `factory.yaml`; `config: false` only resolves it.
 */
export async function targetOf(repo: string, given?: string, { config = true }: { config?: boolean } = {}): Promise<string> {
  const branch = given ?? (await loadSettings(repo)).branch ?? (await defaultBranch(repo));
  if (!config) return branch;
  if (!(await localBranchExists(repo, branch))) throw new FactoryError("not_found", `${repo} has no local branch ${branch}`);
  if ((await runCommand(["git", "cat-file", "-e", `refs/heads/${branch}:factory.yaml`], { cwd: repo })).exitCode !== 0) {
    throw new FactoryError("refused", `${repo}: branch ${branch} has no factory.yaml (write one with /factory init or the config.write action, and commit it)`);
  }
  return branch;
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
  /** Aborting it before the runner wrote its first state kills the running hook or runner and undoes the launch. */
  signal?: AbortSignal;
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
  const target = await targetOf(repo, overrides.branch ?? stored.branch);
  const { branch, merge, maxRounds, review, models } = resolveSettings([stored, overrides], target);
  const settings: Settings = { branch, merge, maxRounds, review, models: taskModels(models, input.size) };
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
    let record: TaskRecord | undefined;
    try {
      // Package managers race on their shared cache: one repository's hooks run one launch at a time.
      await withLock(join(factoryHome(), "locks", `${repoDirName(repo)}.hooks`), "hooks are busy", Infinity, () => runAfterCreate(commands.run, worktree), input.signal);
      if (aborted()) throw new Error("the start was aborted");
      await input.beforeRecord?.(settings.branch, worktree);
      record = {
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
        start: startCommand(input.title, input.request, settings, contracts?.prefix),
        ...(contracts === undefined ? {} : { contracts: contracts.stamps }),
      };
      // The record only once its runner holds the task: a record without a state and without a runner reads interrupted.
      await lockTask(id);
      await sendCommand(record, record.start, input.env);
      await writeTask(record);
      // A runner whose `pi` exits before it answers (missing, broken, no plugin) leaves a task without any state.
      await requireRunnerStarted(record, 0, input.signal);
      if (aborted()) throw new Error("the start was aborted");
      return record;
    } catch (error) {
      if (record !== undefined) {
        await stopRunners(record).catch(() => undefined);
        await removeTask(id).catch(() => undefined);
      }
      await removeWorktree(repo, worktree, name).catch(() => undefined);
      throw aborted() ? new Error("the start was aborted") : error;
    }
  } finally {
    input.signal?.removeEventListener("abort", abort);
  }
}

/**
 * After a command that starts the task's runner: waits until the session has more than `statesBefore` `factory-state`
 * entries (the runner runs) or the runner ended without one (`failed`, naming the last line of its log). A runner still
 * alive after `RUNNER_START_WAIT_MS` counts as started; `signal` ends the wait.
 */
export async function requireRunnerStarted(record: TaskRecord, statesBefore: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + RUNNER_START_WAIT_MS;
  const wroteState = async () => (await readFactoryStates(record.sessionDir, record.sessionId)).count > statesBefore;
  while (Date.now() < deadline && signal?.aborted !== true) {
    if (await wroteState()) return;
    if ((await liveRunners(record)).length === 0) {
      if (await wroteState()) return;
      const log = await readFile(taskLogPath(record.id), "utf8").catch(() => "");
      const last = log.trim().split("\n").at(-1)?.trim().slice(0, 300) ?? "";
      throw new FactoryError("failed", `the runner of task ${short(record.id)} ended before it ran${last === "" ? "" : ` (${last})`}`);
    }
    await Bun.sleep(100);
  }
}

/**
 * Starts `bun runner.ts` for `message` (`startRunner`), output appended to the task's log, with `env` (default
 * `process.env`) plus the lock path, the task's wave (`TASK_WAVE_ENV`, which the runner pokes when it ends with the
 * task at rest) and the repository's `extensions` setting (`CODER_EXTENSIONS_ENV`). The caller holds the task lock
 * (`lockTask`): it passes to the runner, which removes it when it exits.
 */
export async function sendCommand(record: TaskRecord, message: string, env: RunnerEnv = process.env): Promise<void> {
  await mkdir(record.sessionDir, { recursive: true });
  const { extensions } = await loadSettings(record.repo);
  await startRunner({
    lock: taskLockPath(record.id),
    argv: [RUNNER_PATH, record.worktree, record.sessionDir, record.sessionId, taskInboxPath(record.id), message],
    env,
    // A task runs without pauses, so the default short prompt cache is enough and the dearer long cache writes are not.
    vars: {
      FACTORY_TASK_LOCK: taskLockPath(record.id),
      PI_CACHE_RETENTION: "short",
      [CODER_EXTENSIONS_ENV]: extensions === undefined ? undefined : JSON.stringify(extensions),
      ...(record.wave === null ? {} : { [TASK_WAVE_ENV]: record.wave }),
    },
    log: taskLogPath(record.id),
    cwd: dirname(RUNNER_PATH),
  });
}

/** The messages for a task's live runner, one JSON `{"text"}` per line; the runner stores how far it sent them in `<inbox>.read`. */
export function taskInboxPath(id: string): string {
  return join(tasksDir(), `${id}.inbox`);
}

export const MERGING_REFUSAL = "is merging, send the message when the merge has ended";
/** A done task of a wave takes no message: more work for the wave is `waves.add`; a cancelled one keeps what it did. */
export const DONE_REFUSAL = "is done: give the work to its wave with waves.add, or start a new task";
/** The one rule for a message to a done task, sent by an action or typed into its session: refused in a wave, else it runs again. */
export const refusesDone = (state: State | null | undefined, wave: string | null): boolean => state === "done" && wave !== null;

/**
 * Before a follow-up run of a done task outside a wave: a worktree that is gone is made again on the task branch, new
 * off the target's tip. A branch of that name that holds commits the target lacks is not the merged task's: refused.
 */
async function restoreWorktree(record: TaskRecord): Promise<void> {
  if (existsSync(record.worktree)) return;
  const target = `refs/heads/${await taskMainBranch(record.sessionDir, record.sessionId)}`;
  await git(runCommand, record.repo, ["worktree", "prune"]);
  const merged = async () => (await runCommand(["git", "merge-base", "--is-ancestor", record.branch, target], { cwd: record.repo })).exitCode === 0;
  if ((await localBranchExists(record.repo, record.branch)) && !(await merged())) {
    throw new FactoryError(
      "refused",
      `task ${short(record.id)} cannot run again: its worktree is gone and its branch ${record.branch} holds commits ${target} lacks; delete or rename that branch, or start a new task`,
    );
  }
  await git(runCommand, record.repo, ["worktree", "add", "--quiet", "-B", record.branch, record.worktree, target]);
  await runAfterCreate(runCommand, record.worktree).catch(async (error: unknown) => {
    await removeWorktree(record.repo, record.worktree, record.branch).catch(() => undefined);
    throw error;
  });
}

/**
 * A message for the task's coder. A live runner holds the task: one line in its inbox, which it sends to Pi as a
 * follow-up. A runner that closed Pi's stdin before the line came ends without sending it, so this waits until the
 * line is sent or the runner is gone, and then delivers it itself. With no runner (at rest, interrupted, or ended with
 * lines unsent): takes the task lock and starts a runner with `env` and the first unsent inbox line as its prompt, else
 * `text`, the lock handed to it; that runner sends the lines after it. While the task merges the runner sends nothing but
 * keeps Pi open for a line it holds, so a line already in the inbox is left there and the call returns. Refuses
 * (`refused`, one sentence) while the task merges (line not yet appended), before it has a state, or when it is final
 * (a line appended meanwhile is taken back), a `busy` FactoryError while another holds its lock; a line already
 * appended is never refused, it goes with the next runner. A done task outside a wave is not final here: it runs again.
 */
export async function messageTask(record: TaskRecord, text: string, env?: RunnerEnv): Promise<void> {
  const inbox = taskInboxPath(record.id);
  const line = `${JSON.stringify({ text })}\n`;
  /** The inbox's size once `text` is in it; 0 before. */
  let end = 0;
  for (;;) {
    if ((await liveRunners(record)).length > 0) {
      // The runner sends nothing while the task merges: it keeps Pi open for a line it holds, so the line waits in the inbox.
      const merging = (await lastFactoryState(record.sessionDir, record.sessionId))?.state === "merging";
      if (end === 0 && merging) throw new FactoryError("refused", `task ${record.id.slice(0, 8)} ${MERGING_REFUSAL}`);
      if (end === 0) {
        await mkdir(tasksDir(), { recursive: true });
        await appendFile(inbox, line, "utf8");
        end = (await stat(inbox)).size;
      }
      while (
        (await readInboxOffset(inbox)) < end &&
        (await liveRunners(record)).length > 0 &&
        (await lastFactoryState(record.sessionDir, record.sessionId))?.state !== "merging"
      ) {
        await Bun.sleep(INBOX_POLL_MS);
      }
      if ((await readInboxOffset(inbox)) >= end || (await liveRunners(record)).length > 0) return;
    }
    const locked = await lockTask(record.id).then(
      () => true,
      (error: unknown) => {
        // Another sender's runner may be starting with the line: look again.
        if (end === 0 || !isBusy(error)) throw error;
        return false;
      },
    );
    if (locked) {
      try {
        // The caller checked `refusal(view, "tasks.message")` before the lock; the state may have moved since.
        const state = await lastFactoryState(record.sessionDir, record.sessionId);
        const followUp = state?.state === "done" && record.wave === null;
        if (followUp) {
          await restoreWorktree(record).catch(async (error: unknown) => {
            // The next runner would send a line left in the inbox.
            if (end > 0) await withdrawInboxLine(inbox, line);
            throw error;
          });
        }
        if (end > 0) {
          if (state !== undefined && isFinal(state.state) && !followUp) {
            await withdrawInboxLine(inbox, line);
            throw new FactoryError("refused", `task ${record.id.slice(0, 8)} ${DONE_REFUSAL}`);
          }
          const first = state === undefined || state.state === "merging" ? undefined : await takeInboxLine(inbox);
          if (first !== undefined) await sendCommand(record, first, env);
          return;
        }
        if (state === undefined) throw new FactoryError("refused", `task ${record.id.slice(0, 8)} has not started yet, send the message once it runs`);
        if (state.state === "merging") throw new FactoryError("refused", `task ${record.id.slice(0, 8)} ${MERGING_REFUSAL}`);
        if (refusesDone(state.state, record.wave)) throw new FactoryError("refused", `task ${record.id.slice(0, 8)} ${DONE_REFUSAL}`);
        return await sendCommand(record, text, env);
      } finally {
        await unlockFile(taskLockPath(record.id));
      }
    }
    await Bun.sleep(INBOX_POLL_MS);
  }
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
