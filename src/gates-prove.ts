/**
 * The gate proof: `merge_gates` of a branch's `factory.yaml` run on its tip in a worktree of its own, in the background,
 * so the supervisor learns whether the target holds before it declares a wave on it.
 *
 * - `gates.prove {repo, branch?}` (`PROOF_HANDLERS`): takes the lock `proofs/<id>.lock`, writes the record, spawns
 *   `bun gates-prove.ts <id>` detached (`spawnDetached`) and hands it the lock, like a task's runner. Branch: the given
 *   one, else the repo's stored branch, else its default. Refused without a committed `factory.yaml`. Answers `{proof}`
 * - The record `proofs/<id>.jsonl`: line 1 the declaration; the runner rewrites it whole with one `end` line that holds
 *   the steps (`passed`, `flaky` or `failing`; failing names the step and the path of its output,
 *   `proofs/<id>.failing.log`). Without an `end` it is `running` while its runner holds the lock (`lockRunner`), else `interrupted`.
 *   `<id>.log` is the runner's output. The worktree an interrupted proof left is removed by the next `gates.prove` in its repo
 * - The runner: a detached worktree of the tip, `hooks.after_create` of the tip, then every `merge_gates` step through
 *   `runGateStep` (one rerun: passing then, the proof is `flaky`). `FACTORY_BASE` is the empty tree: the whole tree is
 *   the change. The worktree is removed (forced: gate output is scratch) before the `end` is written
 * - `proofsOf(origin)`: the views a Pi session's notifier judges (`notify.ts`)
 */
import { existsSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadTaskFiles } from "./config.ts";
import { byId, nonEmpty, primaryOf, type Handler } from "./core-shared.ts";
import { branchHasConfig } from "./core-settings.ts";
import { runGateStep } from "./flaky-rerun.ts";
import { git } from "./git.ts";
import { defaultBranch, localBranchExists, runAfterCreate, worktreePath } from "./launch.ts";
import { CommandRunner, runCommand, type CommandResult, type Exec } from "./run.ts";
import { factoryHome, loadSettings } from "./settings.ts";
import { onPath, spawnDetached } from "./spawn.ts";
import { passed } from "./state.ts";
import { handLockFile, lockFile, lockRunner } from "./tasks.ts";
import { errorText, FactoryError, ifMissing, jsonLines, outputTail, writeAtomic } from "./util.ts";

export type ProofState = "running" | "passed" | "flaky" | "failing";

export interface ProofDeclaration {
  id: string;
  repo: string;
  branch: string;
  /** The tip the proof runs on. */
  commit: string;
  /** The declaring Pi session, null from the CLI and MCP. */
  origin: string | null;
  createdAt: string;
}

export interface ProofStep {
  command: string;
  passed: boolean;
  wallMs: number;
  /** The failing test names of a step that passed on its rerun. */
  flaky: string[];
}

export interface ProofView extends ProofDeclaration {
  state: ProofState;
  steps: ProofStep[];
  /** Every step's flaky names. */
  flaky: string[];
  /** The failing step (`hooks.after_create ...` for a hook), its output's tail and the path of its full output. */
  failing: { step: string; tail: string; log: string } | null;
  endedAt: string | null;
  /** A runner lives. */
  running: boolean;
  /** `running` in its record, no runner lives: it never ends. */
  interrupted: boolean;
}

type End = { state: Exclude<ProofState, "running">; at: string; steps: ProofStep[]; step?: string; tail?: string; log?: string };

export const PROOF_RUNNER_PATH = join(import.meta.dirname, "gates-prove.ts");

export function proofsDir(): string {
  return join(factoryHome(), "proofs");
}

const proofPath = (id: string) => join(proofsDir(), `${id}.jsonl`);
const proofLogPath = (id: string) => join(proofsDir(), `${id}.log`);
const proofLockPath = (id: string) => join(proofsDir(), `${id}.lock`);
export const failingLogPath = (id: string) => join(proofsDir(), `${id}.failing.log`);

/** The record of proof `id`: its declaration and its end, if any. Throws `not_found`. */
async function readProof(id: string): Promise<{ declaration: ProofDeclaration; end: End | undefined }> {
  const text = await ifMissing(readFile(proofPath(id), "utf8"), null);
  if (text === null) throw new FactoryError("not_found", `no proof has the id "${id}"`);
  const [declaration, end] = jsonLines(text);
  return { declaration: declaration as unknown as ProofDeclaration, end: end as End | undefined };
}

/** Writes the record of a proof whole, atomically. */
async function writeProof(declaration: ProofDeclaration, end?: End): Promise<void> {
  await writeAtomic(proofPath(declaration.id), [declaration, ...(end === undefined ? [] : [end])].map((line) => `${JSON.stringify(line)}\n`).join(""));
}

/** The ids of every recorded proof. */
async function proofIds(): Promise<string[]> {
  const names = await ifMissing(readdir(proofsDir()), []);
  return names.filter((name) => name.endsWith(".jsonl")).map((name) => name.slice(0, -".jsonl".length));
}

/** Proof `id` as the full view shows it. Whether its runner lives is asked first: a runner writes its end before it exits. */
export async function proofView(id: string): Promise<ProofView> {
  const lives = (await lockRunner(proofLockPath(id), id)) !== null;
  const { declaration, end } = await readProof(id);
  const steps = end?.steps ?? [];
  return {
    ...declaration,
    state: end?.state ?? "running",
    steps,
    flaky: [...new Set(steps.flatMap((step) => step.flaky))],
    failing: end?.state === "failing" ? { step: end.step ?? "", tail: end.tail ?? "", log: end.log ?? "" } : null,
    endedAt: end?.at ?? null,
    running: end === undefined && lives,
    interrupted: end === undefined && !lives,
  };
}

/** The proof whose id is `id` or starts with it. */
export async function findProof(id: unknown): Promise<string> {
  return byId(await proofIds(), (proof) => proof, id, "proof");
}

/** It ends no more by itself: ended, or interrupted. */
export function proofRests(view: ProofView): boolean {
  return view.state !== "running" || view.interrupted;
}

/** It waits for the supervisor: `failing` or interrupted. */
export function proofNeedsAttention(view: ProofView): boolean {
  return view.state === "failing" || view.interrupted;
}

/** The views of the proofs Pi session `origin` declared. */
export async function proofsOf(origin: string): Promise<ProofView[]> {
  const views = await Promise.all((await proofIds()).map((id) => proofView(id).catch(() => undefined)));
  return views.filter((view): view is ProofView => view?.origin === origin);
}

const proofWorktree = (declaration: ProofDeclaration) => worktreePath(declaration.repo, `proof-${declaration.id.slice(0, 8)}`);

/** Removes the worktrees the interrupted proofs of `repo` left. */
async function removeLeftovers(repo: string): Promise<void> {
  for (const id of await proofIds()) {
    const view = await proofView(id).catch(() => undefined);
    if (view?.repo !== repo || !view.interrupted || !existsSync(proofWorktree(view))) continue;
    await removeProofWorktree(runCommand, repo, proofWorktree(view)).catch((error: unknown) => log(id, `the leftover worktree stays: ${errorText(error)}`));
  }
}

export const PROOF_HANDLERS = {
  "gates.prove": async (params, { cwd, env, origin }) => {
    const repo = await primaryOf(params.repo as string, cwd);
    let branch = params.branch === undefined ? undefined : nonEmpty(params.branch)?.trim();
    if (params.branch !== undefined && branch === undefined) throw new FactoryError("invalid", "gates.prove: branch must not be empty");
    branch ??= (await loadSettings(repo)).branch ?? (await defaultBranch(repo).catch(() => undefined));
    if (branch === undefined) throw new FactoryError("refused", `${repo} has no default branch (origin/HEAD, main and master do not exist locally)`);
    if (!(await localBranchExists(repo, branch))) throw new FactoryError("not_found", `${repo} has no local branch ${branch}`);
    if (!(await branchHasConfig(repo, branch))) throw new FactoryError("refused", `${repo}: branch ${branch} has no factory.yaml (write one with /factory init or the config.write action, and commit it)`);
    await removeLeftovers(repo);
    const bun = onPath("bun");
    if (bun === null) throw new FactoryError("failed", "bun is not on PATH: the proof's runner needs it");
    const declaration: ProofDeclaration = {
      id: crypto.randomUUID(),
      repo,
      branch,
      commit: await git(runCommand, repo, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]),
      origin: origin ?? null,
      createdAt: new Date().toISOString(),
    };
    // Held by this process until the runner has it.
    await lockFile(proofLockPath(declaration.id), `proof ${declaration.id.slice(0, 8)} is busy`);
    await writeProof(declaration);
    const pid = await spawnDetached([bun, PROOF_RUNNER_PATH, declaration.id], env ?? process.env, proofLogPath(declaration.id), import.meta.dirname).catch((error: unknown) => {
      log(declaration.id, errorText(error));
      return undefined;
    });
    if (pid === undefined) {
      await Promise.all([proofPath(declaration.id), proofLockPath(declaration.id)].map((path) => rm(path, { force: true })));
      throw new FactoryError("failed", `the runner of proof ${declaration.id.slice(0, 8)} did not start`);
    }
    await handLockFile(proofLockPath(declaration.id), pid);
    return { proof: await proofView(declaration.id) };
  },
} satisfies Record<string, Handler>;

// ---- the runner ----

function log(id: string, text: string): void {
  console.error(`${new Date().toISOString()} proof ${id.slice(0, 8)}: ${text}`);
}

/** Removes the proof's worktree whatever it holds, and git's note of it. */
async function removeProofWorktree(exec: Exec, repo: string, path: string): Promise<void> {
  await exec(["git", "worktree", "remove", "--force", "--force", path], { cwd: repo });
  if (existsSync(path)) await rm(path, { recursive: true, force: true });
  await exec(["git", "worktree", "prune"], { cwd: repo });
}

/**
 * Runs proof `id`: worktree, `after_create`, `merge_gates`, then removes the worktree and records the end. A runner
 * stopped by a signal records no end: the proof reads as interrupted.
 */
export async function runProof(id: string): Promise<void> {
  const { declaration } = await readProof(id);
  const runner = new CommandRunner();
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      stopping = true;
      runner.cancel();
    });
  }
  const path = proofWorktree(declaration);
  const steps: ProofStep[] = [];
  let end: Omit<End, "at" | "steps"> = { state: "passed" };
  const fail = async (step: string, output: string) => {
    await writeFile(failingLogPath(id), output, "utf8");
    end = { state: "failing", step, tail: outputTail(output), log: failingLogPath(id) };
  };
  try {
    await git(runner.cleanup, declaration.repo, ["worktree", "prune"]);
    await git(runner.cleanup, declaration.repo, ["worktree", "add", "--quiet", "--detach", path, declaration.commit]);
    const { config } = await loadTaskFiles(runner.cleanup, path, declaration.commit);
    let hooked = true;
    let hook: CommandResult | undefined;
    try {
      const exec: Exec = async (argv, options) => {
        hook = await runner.run(argv, options);
        return hook;
      };
      await runAfterCreate(exec, path, config.hooks.after_create);
    } catch (error) {
      hooked = false;
      // The log gets the hook's whole output, the error only its tail.
      await fail("hooks.after_create", hook === undefined ? errorText(error) : `${errorText(error)}\n\n${hook.output}`);
    }
    const emptyTree = await git(runner.cleanup, path, ["hash-object", "-t", "tree", "/dev/null"]);
    for (const argv of hooked ? config.merge_gates : []) {
      log(id, `gate ${argv.join(" ")}`);
      const step = await runGateStep(argv, (env) => runner.run(argv, { cwd: path, env: { ...env, FACTORY_BASE: emptyTree } }), () => stopping);
      const ok = passed(step.result);
      steps.push({ command: argv.join(" "), passed: ok, wallMs: step.result.durationMs, flaky: step.flaky ?? [] });
      if (!ok) {
        await fail(argv.join(" "), step.result.output);
        break;
      }
    }
    if (end.state === "passed" && steps.some((step) => step.flaky.length > 0)) end = { state: "flaky" };
  } catch (error) {
    await fail("the proof's worktree", errorText(error));
  } finally {
    await removeProofWorktree(runner.cleanup, declaration.repo, path).catch((error: unknown) => log(id, `the worktree stays: ${errorText(error)}`));
  }
  if (stopping) return log(id, "stopped: no end is recorded");
  await writeProof(declaration, { ...end, at: new Date().toISOString(), steps });
  log(id, end.state);
}

if (import.meta.main) {
  const id = process.argv[2] ?? "";
  await runProof(id).catch((error: unknown) => {
    log(id, errorText(error));
    process.exit(1);
  });
  process.exit(0);
}
