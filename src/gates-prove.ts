/**
 * The gate proof: `merge_gates` of a branch's `factory.yaml` run on its tip in a worktree of its own, in the background,
 * so the supervisor learns whether the target holds before it declares a wave on it.
 *
 * - `gates.prove {repo, branch?}` (`PROOF_HANDLERS`): writes the record and spawns `bun gates-prove.ts <id>` detached
 *   (`spawnDetached`, like a wave's runner). Branch: the given one, else the repo's stored branch, else its default.
 *   Refused without a committed `factory.yaml`. Answers `{proof}`
 * - `gates.get {id}`: `{proof: ProofView}`
 * - The record `proofs/<id>.jsonl`, append-only and written by its runner alone: line 1 the declaration, then a `step`
 *   event per gate step, then one `end` event (`passed`, `flaky` or `failing`; failing names the step and the path of
 *   its output, `proofs/<id>.failing.log`). Without an `end` it is `running`, or `interrupted` once its runner (noted in
 *   `proofs/<id>.pid` by `gates.prove`: pid and start time) no longer lives. `<id>.log` is the runner's output
 * - The runner: a detached worktree of the tip, `hooks.after_create` of the tip, then every `merge_gates` step through
 *   `runGateStep` (one rerun: passing then, the proof is `flaky`). `FACTORY_BASE` is the empty tree: the whole tree is
 *   the change. The worktree is removed (forced: gate output is scratch) before the `end` event is written
 * - `proofsOf(origin)`: the views a Pi session's notifier judges (`notify.ts`)
 */
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadTaskFiles } from "./config.ts";
import type { ActionName } from "./core.ts";
import { FactoryError, nonEmpty, primaryOf, type Handler } from "./core-shared.ts";
import { branchHasConfig } from "./core-settings.ts";
import { runGateStep } from "./flaky-rerun.ts";
import { git } from "./git.ts";
import { defaultBranch, localBranchExists, runAfterCreate, worktreePath } from "./launch.ts";
import { procStart } from "./queue.ts";
import { CommandRunner, runCommand } from "./run.ts";
import { factoryHome, loadSettings } from "./settings.ts";
import { onPath, spawnDetached } from "./spawn.ts";
import { passed } from "./state.ts";
import { errorText, isRecord, outputTail } from "./util.ts";

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

type EndEvent = { kind: "end"; state: Exclude<ProofState, "running">; at: string; step?: string; tail?: string; log?: string };
type StepEvent = { kind: "step"; command: string; passed: boolean; wallMs: number; flaky?: string[] };

const PROOF_ID = /^[0-9a-f-]{36}$/;
export const PROOF_RUNNER_PATH = join(import.meta.dirname, "gates-prove.ts");

export function proofsDir(): string {
  return join(factoryHome(), "proofs");
}

const proofPath = (id: string) => join(proofsDir(), `${id}.jsonl`);
const proofLogPath = (id: string) => join(proofsDir(), `${id}.log`);
export const failingLogPath = (id: string) => join(proofsDir(), `${id}.failing.log`);

function parseDeclaration(raw: unknown): ProofDeclaration | null {
  if (!isRecord(raw)) return null;
  const { id, repo, branch, commit, origin, createdAt } = raw;
  if ([id, repo, branch, commit, createdAt].some((value) => typeof value !== "string")) return null;
  return { id, repo, branch, commit, origin: typeof origin === "string" ? origin : null, createdAt } as ProofDeclaration;
}

function parseEvent(raw: unknown): StepEvent | EndEvent | null {
  if (!isRecord(raw)) return null;
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  if (raw.kind === "step" && typeof raw.command === "string") {
    return { kind: "step", command: raw.command, passed: raw.passed === true, wallMs: Number(raw.wallMs) || 0, flaky: strings(raw.flaky) };
  }
  if (raw.kind === "end" && (raw.state === "passed" || raw.state === "flaky" || raw.state === "failing")) {
    const text = (value: unknown) => (typeof value === "string" ? value : undefined);
    return { kind: "end", state: raw.state, at: text(raw.at) ?? "", step: text(raw.step), tail: text(raw.tail), log: text(raw.log) };
  }
  return null;
}

/** The record of proof `id`: its declaration and events, a torn or unknown line skipped. Throws `not_found`. */
async function readProof(id: string): Promise<{ declaration: ProofDeclaration; events: (StepEvent | EndEvent)[] }> {
  const text = await readFile(proofPath(id), "utf8").catch(() => {
    throw new FactoryError("not_found", `no proof has the id "${id}"`);
  });
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const parsed = lines.map((line) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return null;
    }
  });
  const declaration = parseDeclaration(parsed[0]);
  if (declaration === null) throw new FactoryError("failed", `the record of proof ${id} has no declaration`);
  return { declaration, events: parsed.slice(1).map(parseEvent).filter((event) => event !== null) };
}

async function appendEvent(id: string, event: StepEvent | EndEvent): Promise<void> {
  await appendFile(proofPath(id), `${JSON.stringify(event)}\n`, "utf8");
}

/** The ids of every recorded proof. */
async function proofIds(): Promise<string[]> {
  const names = await readdir(proofsDir()).catch(() => [] as string[]);
  return names.filter((name) => name.endsWith(".jsonl")).map((name) => name.slice(0, -".jsonl".length));
}

/** Where `gates.prove` notes its runner: `<pid> <start time>` (`/proc/<pid>/stat`). */
const proofPidPath = (id: string) => join(proofsDir(), `${id}.pid`);

/**
 * Whether the proof's runner lives: the noted pid runs (not a zombie) with the noted start time. Before the note is
 * written (`gates.prove` is spawning it) it counts as living.
 */
async function runnerLives(id: string): Promise<boolean> {
  const note = await readFile(proofPidPath(id), "utf8").catch(() => null);
  if (note === null) return true;
  const [pid, start] = note.trim().split(" ");
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return stat !== "" && fields[0] !== "Z" && fields[19] === start;
}

/** Proof `id` as the full view shows it. */
export async function proofView(id: string): Promise<ProofView> {
  let { declaration, events } = await readProof(id);
  let end = events.find((event) => event.kind === "end");
  const running = end === undefined && (await runnerLives(id));
  // A runner that ended between the read and the look wrote its end first.
  if (end === undefined && !running) ({ declaration, events } = await readProof(id));
  end = events.find((event) => event.kind === "end");
  const steps = events.filter((event) => event.kind === "step").map(({ command, passed: ok, wallMs, flaky }) => ({ command, passed: ok, wallMs, flaky: flaky ?? [] }));
  return {
    ...declaration,
    state: end?.state ?? "running",
    steps,
    flaky: [...new Set(steps.flatMap((step) => step.flaky))],
    failing: end?.state === "failing" ? { step: end.step ?? "", tail: end.tail ?? "", log: end.log ?? "" } : null,
    endedAt: end?.at ?? null,
    running,
    interrupted: end === undefined && !running,
  };
}

/** The proof whose id is `id` or starts with it. */
export async function findProof(id: unknown): Promise<string> {
  const wanted = nonEmpty(id)?.trim();
  if (wanted === undefined) throw new FactoryError("invalid", "the id of a proof must not be empty");
  const ids = await proofIds();
  if (ids.includes(wanted)) return wanted;
  const matches = ids.filter((candidate) => candidate.startsWith(wanted));
  if (matches.length === 0) throw new FactoryError("not_found", `no proof has an id starting with "${wanted}"`);
  if (matches.length > 1) throw new FactoryError("invalid", `"${wanted}" matches ${matches.length} proofs, give more of the id`);
  return matches[0];
}

/** It ends no more by itself: ended, or interrupted. */
export function proofRests(view: ProofView): boolean {
  return view.state !== "running" || view.interrupted;
}

/** It waits for the supervisor: `failing` or interrupted. */
export function proofNeedsAttention(view: ProofView): boolean {
  return view.state === "failing" || view.interrupted;
}

/** The views of the proofs Pi session `origin` declared, those in `skip` left out. */
export async function proofsOf(origin: string, skip: ReadonlySet<string> = new Set()): Promise<ProofView[]> {
  const views: ProofView[] = [];
  for (const id of await proofIds()) {
    if (skip.has(id)) continue;
    const view = await proofView(id).catch(() => undefined);
    if (view?.origin === origin) views.push(view);
  }
  return views;
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
    await mkdir(proofsDir(), { recursive: true });
    await writeFile(proofPath(declaration.id), `${JSON.stringify(declaration)}\n`, "utf8");
    const pid = await spawnDetached([bun, PROOF_RUNNER_PATH, declaration.id], env ?? process.env, proofLogPath(declaration.id), import.meta.dirname).catch((error: unknown) => {
      log(declaration.id, errorText(error));
      return undefined;
    });
    if (pid === undefined) {
      await appendEvent(declaration.id, { kind: "end", state: "failing", at: new Date().toISOString(), step: "the proof's runner", tail: "it did not start" });
      throw new FactoryError("failed", `the runner of proof ${declaration.id.slice(0, 8)} did not start`);
    }
    const temp = `${proofPidPath(declaration.id)}.tmp`;
    await writeFile(temp, `${pid} ${(await procStart(pid)) ?? "0"}\n`, "utf8");
    await rename(temp, proofPidPath(declaration.id));
    return { proof: await proofView(declaration.id) };
  },
  "gates.get": async (params) => ({ proof: await proofView(await findProof(params.id)) }),
} satisfies Partial<Record<ActionName, Handler>>;

// ---- the runner ----

function log(id: string, text: string): void {
  console.error(`${new Date().toISOString()} proof ${id.slice(0, 8)}: ${text}`);
}

/** Removes the proof's worktree whatever it holds, and git's note of it. */
async function removeProofWorktree(runner: CommandRunner, repo: string, path: string): Promise<void> {
  await runner.cleanup(["git", "worktree", "remove", "--force", "--force", path], { cwd: repo });
  if (existsSync(path)) await rm(path, { recursive: true, force: true });
  await runner.cleanup(["git", "worktree", "prune"], { cwd: repo });
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
  const path = worktreePath(declaration.repo, `proof-${id.slice(0, 8)}`);
  const flaky: string[] = [];
  let end: Omit<EndEvent, "at" | "kind"> = { state: "passed" };
  const fail = async (step: string, output: string) => {
    await writeFile(failingLogPath(id), output, "utf8");
    end = { state: "failing", step, tail: outputTail(output), log: failingLogPath(id) };
  };
  try {
    await git(runner.cleanup, declaration.repo, ["worktree", "prune"]);
    await git(runner.cleanup, declaration.repo, ["worktree", "add", "--quiet", "--detach", path, declaration.commit]);
    const { config } = await loadTaskFiles(runner.cleanup, path, declaration.commit);
    let hooked = true;
    try {
      await runAfterCreate(runner.run, path, config.hooks.after_create);
    } catch (error) {
      hooked = false;
      await fail("hooks.after_create", errorText(error));
    }
    const emptyTree = await git(runner.cleanup, path, ["hash-object", "-t", "tree", "/dev/null"]);
    for (const argv of hooked ? config.merge_gates : []) {
      log(id, `gate ${argv.join(" ")}`);
      const step = await runGateStep(argv, () => runner.run(argv, { cwd: path, env: { FACTORY_BASE: emptyTree } }), () => stopping);
      const ok = passed(step.result);
      await appendEvent(id, { kind: "step", command: argv.join(" "), passed: ok, wallMs: step.result.durationMs, ...(step.flaky === null ? {} : { flaky: step.flaky }) });
      flaky.push(...(step.flaky ?? []));
      if (!ok) {
        await fail(argv.join(" "), step.result.output);
        break;
      }
    }
    if (end.state === "passed" && flaky.length > 0) end = { state: "flaky" };
  } catch (error) {
    await fail("the proof's worktree", errorText(error));
  } finally {
    await removeProofWorktree(runner, declaration.repo, path).catch((error: unknown) => log(id, `the worktree stays: ${errorText(error)}`));
  }
  if (stopping) return log(id, "stopped: no end is recorded");
  await appendEvent(id, { kind: "end", at: new Date().toISOString(), ...end });
  log(id, end.state);
}

if (import.meta.main) {
  const id = process.argv[2] ?? "";
  if (!PROOF_ID.test(id)) {
    console.error(`usage: bun gates-prove.ts <proof id>`);
    process.exit(2);
  }
  await runProof(id).catch((error: unknown) => {
    log(id, errorText(error));
    process.exit(1);
  });
  process.exit(0);
}
