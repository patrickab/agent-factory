/**
 * Review per task (every wave): the wave's runner has the wave's reviewer judge each task that rests
 * `reviewing`, one after another, and hands the verdict to the task (`/factory reviewed`).
 *
 * - The queue (`reviewNext`): the first task of the wave (declaration order) in `reviewing` whose runner does not live.
 *   A `task_review` event for its round recorded already (a runner that died before the hand-over) is handed over
 *   again, else the reviewer runs and the event is recorded first. The task applies a verdict only while it rests
 *   `reviewing` in that round: a verdict handed over twice changes nothing. Within one runner process a verdict goes out
 *   at most `DELIVERIES` times
 * - One reviewer session per wave: `--session-id` = the wave's id, `--session-dir` and working directory its reviews
 *   directory, the model, role prompt (from the wave's base) and tools the same at every resume,
 *   `PI_CACHE_RETENTION=long`, one process per review. Before each resume `stubEarlierRounds` replaces every earlier
 *   tool result by a `[reviewed]` stub: no earlier diff stays in the context
 * - The diff reaches the reviewer only through `read_diff` (`REVIEW_DIFF_ENV`): the task's worktree since the tree the
 *   reviewer last judged for it while the task's base stayed, else since its base. The prompt holds the task's request
 *   and the wave's contracts (read fresh with `readContract`; only when their text changed since the last review)
 * - A review that the runner's stop cut short records nothing: the resume reviews that round again
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadTaskFiles } from "./config.ts";
import { readContract, stampOf, type ContractFacts } from "./contracts.ts";
import { git, snapshotTree, treeDiff } from "./git.ts";
import { liveRunners, messageTask, type RunnerEnv } from "./launch.ts";
import { REVIEW_DIFF_ENV } from "./review-diff.ts";
import { STUB_PREFIX, stubEarlierRounds } from "./review-session.ts";
import { readReviewerOutput, VERDICT_TOOL } from "./review.ts";
import type { Exec } from "./run.ts";
import { lastFactoryState } from "./runner.ts";
import { resolveModels } from "./settings.ts";
import { approvedFrom, type Finding, type ReviewData, type ReviewStatus } from "./state.ts";
import { listTasks, type TaskRecord } from "./tasks.ts";
import { errorText } from "./util.ts";
import { appendWaveEvents, waveReviewsDir, type NewWaveEvent, type StartedWaveFold, type TaskStates, type WaveTaskReview } from "./waves.ts";

const REVIEWER_TOOL_EXTENSION = join(import.meta.dirname, "pi", "reviewer-tool.ts");
const REVIEWER_STDOUT_MAX_CHARS = 32_000_000;
/** How often one runner process hands one verdict to its task before it leaves it to a restart. */
const DELIVERIES = 3;

export interface ReviewEachDeps {
  exec: Exec;
  /** True once the runner stops or the step is cancelled: a review cut short records nothing. */
  cancelled: () => boolean;
  env?: RunnerEnv;
  log: (text: string) => void;
  /** The verdicts handed over by this process, `<task id>:<round>` -> how often. */
  delivered: Map<string, number>;
  /** Hands the command to the task; default `messageTask`. Tests replace it. */
  deliver?: (record: TaskRecord, text: string, env?: RunnerEnv) => Promise<void>;
}

/** The reviewer's session file in the wave's reviews directory (`<time>_<wave id>.jsonl`), undefined before its first review. */
async function sessionFile(dir: string, id: string): Promise<string | undefined> {
  const name = (await readdir(dir).catch(() => [] as string[])).find((entry) => entry.endsWith(`_${id}.jsonl`));
  return name === undefined ? undefined : join(dir, name);
}

/** The wave's contracts as prompt text and the hash of it; null for both without contracts. */
async function contractsText(fold: StartedWaveFold): Promise<{ text: string | null; hash: string | null }> {
  const names = fold.contracts ?? [];
  if (fold.plan === null || names.length === 0) return { text: null, hash: null };
  const all: ContractFacts = new Map();
  const blocks: string[] = [];
  for (const name of names) {
    const facts = await readContract(fold.plan, name);
    for (const [path, text] of [...facts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      all.set(path, text);
      blocks.push(`### ${path}\n\n${text}\n`);
    }
  }
  return { text: blocks.join("\n"), hash: stampOf(all).hash };
}

/** The prompt of one task review. */
export function taskReviewPrompt(input: {
  wave: Pick<StartedWaveFold, "title" | "branch">;
  key: string;
  title: string;
  request: string;
  round: number;
  worktree: string;
  since: "base" | number;
  contracts: string | null | "unchanged";
}): string {
  const diff = input.since === "base" ? "its whole change against its base" : `what changed since the tree you judged in its round ${input.since}`;
  const lines = [
    `Review task ${input.key} "${input.title}", round ${input.round}, of the wave "${input.wave.title}" (it merges into ${input.wave.branch}).`,
    `Its worktree is ${input.worktree}: read its files there by absolute path. read_diff shows ${diff}; it is the only diff you get.`,
    `Earlier tool results in this session are stubs starting with ${STUB_PREFIX}: judge this task from read_diff and its files. Your own earlier verdicts on it stay above.`,
    `Only blocker and major findings send the task back to its coder; minor ones are kept and never start a round. Finish with ${VERDICT_TOOL}.`,
    "",
    "## The task's request",
    "",
    input.request,
  ];
  if (input.contracts === "unchanged") lines.push("", "## The wave's contracts", "", "Unchanged since your last review: they are above.");
  else if (input.contracts !== null) lines.push("", "## The wave's contracts (they win over the request)", "", input.contracts);
  return lines.join("\n");
}

/**
 * The reviewer's tools, the same in every pass (the prompt cache): `feedback` in the fit pass is the wave's (task null),
 * `start_fix` and `notify_supervisor` work in both.
 */
export const REVIEWER_TOOLS = `read,grep,find,ls,read_diff,scout,feedback,notify_supervisor,start_fix,${VERDICT_TOOL}`;

/** One run of the wave's reviewer session: the same argv, directory, model and tools at every resume. */
interface ReviewerRun {
  status: ReviewStatus;
  findings: Finding[];
  sessionId: string | null;
  model: string | null;
  usage: ReturnType<typeof readReviewerOutput>["usage"];
  wallMs: number;
}

/**
 * Resumes the wave's reviewer session on `prompt` with `diffFile` behind `read_diff`, after stubbing every earlier tool
 * result; `taskId` the task under review (null: the wave's fit pass). Null when cut short.
 */
async function runWaveReviewer(fold: StartedWaveFold, prompt: string, diffFile: string, taskId: string | null, deps: ReviewEachDeps): Promise<ReviewerRun | null> {
  const { exec } = deps;
  const dir = waveReviewsDir(fold.id);
  // The wave's base: the same role prompt at every resume of the session.
  const { prompts } = await loadTaskFiles(exec, fold.repo, fold.base);
  const existing = await sessionFile(dir, fold.id);
  if (existing !== undefined) stubEarlierRounds(existing);
  const model = resolveModels([fold.overrides.models]).reviewer ?? null;
  const argv = ["pi", "--mode", "json", "-p", "--tools", REVIEWER_TOOLS, "-ne", "-e", REVIEWER_TOOL_EXTENSION];
  argv.push("--no-skills", "--no-prompt-templates", "--no-themes", "--session-dir", dir, "--session-id", fold.id);
  if (model) argv.push("--model", model);
  if (prompts.reviewer) argv.push("--append-system-prompt", prompts.reviewer);
  argv.push(prompt);
  const env: Record<string, string> = { PI_CACHE_RETENTION: "long", [REVIEW_DIFF_ENV]: diffFile, FACTORY_REVIEW_WAVE: fold.id };
  if (taskId !== null) env.FACTORY_REVIEW_TASK = taskId;
  if (fold.plan !== null) env.FACTORY_REVIEW_PLAN = fold.plan;
  const child = await exec(argv, { cwd: dir, env, maxStdoutChars: REVIEWER_STDOUT_MAX_CHARS });
  if (child.killed || deps.cancelled()) return null;
  const output = readReviewerOutput(child.stdout);
  let status: ReviewStatus = "ok";
  if (child.exitCode !== 0) status = "failed";
  else if (output.findings === null) status = "malformed";
  const findings = status === "ok" ? (output.findings ?? []) : [];
  return {
    status,
    findings: findings.map((finding) => ({ severity: finding.severity, file: finding.file, line: finding.line, text: finding.text })),
    sessionId: output.sessionId,
    model,
    usage: output.usage,
    wallMs: child.durationMs,
  };
}

/** The verdict of a reviewer run: only a blocker or major finding rejects. */
function verdictOf(run: Pick<ReviewerRun, "status" | "findings">): "approved" | "rejected" | "failed" {
  return run.status !== "ok" ? "failed" : approvedFrom(run.status, run.findings) ? "approved" : "rejected";
}

/** Runs the reviewer on the task `key` in its `round` and answers the `task_review` event; null when cut short. */
async function reviewTask(fold: StartedWaveFold, key: string, record: TaskRecord, round: number, deps: ReviewEachDeps): Promise<NewWaveEvent | null> {
  const spec = fold.tasks.find((task) => task.key === key);
  if (spec === undefined) return null;
  const { exec } = deps;
  const dir = waveReviewsDir(fold.id);
  await mkdir(dir, { recursive: true });
  const worktree = record.worktree;
  const base = await git(exec, worktree, ["merge-base", "HEAD", `refs/heads/${fold.branch}`]);
  // The wave's base: the same lockfiles at every review.
  const { config } = await loadTaskFiles(exec, fold.repo, fold.base);
  const tree = await snapshotTree(exec, worktree);
  const reviews = fold.taskReviews ?? [];
  const previous = reviews.filter((review) => review.taskId === record.id && review.round < round).at(-1);
  const sinceTree = previous !== undefined && previous.base === base ? previous.tree : base;
  const diff = await treeDiff(exec, worktree, sinceTree, tree, config.lockfiles);
  const diffFile = join(dir, `${key}-round-${round}.diff.json`);
  await writeFile(diffFile, JSON.stringify({ base: diff.base, paths: diff.paths, patch: diff.patch }));
  const contracts = await contractsText(fold);
  const lastHash = reviews.at(-1)?.contracts ?? null;
  const prompt = taskReviewPrompt({
    wave: fold,
    key,
    title: spec.title,
    request: spec.request,
    round,
    worktree,
    since: sinceTree === base ? "base" : (previous?.round ?? "base"),
    contracts: contracts.text === null ? null : reviews.length > 0 && lastHash === contracts.hash ? "unchanged" : contracts.text,
  });
  deps.log(`review of task ${key}, round ${round}`);
  const run = await runWaveReviewer(fold, prompt, diffFile, record.id, deps);
  if (run === null) return null;
  return {
    kind: "task_review",
    key,
    taskId: record.id,
    round,
    tree,
    base,
    contracts: contracts.hash,
    sessionId: run.sessionId,
    model: run.model,
    verdict: verdictOf(run),
    status: run.status,
    findings: run.findings,
    usage: run.usage,
    wallMs: run.wallMs,
  };
}

/** The prompt of the wave's fit pass. */
export function fitPassPrompt(input: {
  wave: Pick<StartedWaveFold, "title" | "branch" | "target" | "request">;
  round: number;
  worktree: string;
  tasks: { key: string; title: string }[];
  contracts: string | null | "unchanged";
}): string {
  const lines = [
    `Review how the tasks of the wave "${input.wave.title}" fit together (wave review round ${input.round}): every task is done and merged into ${input.wave.branch}, the wave is rebased onto ${input.wave.target} and its merge_gates passed.`,
    `Its review worktree is ${input.worktree}: read its files there by absolute path. read_diff shows the wave's whole change against ${input.wave.target}; it is the only diff you get.`,
    `You judged each task on its own above (earlier tool results are stubs starting with ${STUB_PREFIX}). Judge now only what lies between the tasks: interfaces that do not match, the same thing built twice, one task undoing another, a piece of the request no task covered.`,
    `Only blocker and major findings count; the factory turns them into one fix: task of the wave, so do not call start_fix in this pass. Finish with ${VERDICT_TOOL}.`,
    "",
    "## The wave's tasks",
    "",
    ...input.tasks.map((task) => `- ${task.key}: ${task.title}`),
    "",
    "## The wave's request",
    "",
    input.wave.request,
  ];
  if (input.contracts === "unchanged") lines.push("", "## The wave's contracts", "", "Unchanged since your last review: they are above.");
  else if (input.contracts !== null) lines.push("", "## The wave's contracts (they win over the request)", "", input.contracts);
  return lines.join("\n");
}

/** What the fit pass answers: the run with its verdict. */
export type FitPass = ReviewerRun & { verdict: "approved" | "rejected" | "failed" };

/**
 * The end of a wave's review: one pass of the wave's reviewer session on how its tasks fit together, the wave's
 * whole change (`diff`, against the target) behind `read_diff`. Null when cut short.
 */
export async function reviewFit(fold: StartedWaveFold, input: { root: string; round: number; diff: { base: string; paths: string[]; patch: string } }, deps: ReviewEachDeps): Promise<FitPass | null> {
  const dir = waveReviewsDir(fold.id);
  await mkdir(dir, { recursive: true });
  const diffFile = join(dir, `wave-round-${input.round}.diff.json`);
  await writeFile(diffFile, JSON.stringify({ base: input.diff.base, paths: input.diff.paths, patch: input.diff.patch }));
  const contracts = await contractsText(fold);
  const reviews = fold.taskReviews ?? [];
  const lastHash = reviews.at(-1)?.contracts ?? null;
  const prompt = fitPassPrompt({
    wave: fold,
    round: input.round,
    worktree: input.root,
    tasks: fold.tasks.filter((task) => task.taskId !== null).map((task) => ({ key: task.key, title: task.title })),
    contracts: contracts.text === null ? null : reviews.length > 0 && lastHash === contracts.hash ? "unchanged" : contracts.text,
  });
  deps.log(`fit pass, wave review round ${input.round}`);
  const run = await runWaveReviewer(fold, prompt, diffFile, null, deps);
  return run === null ? null : { ...run, verdict: verdictOf(run) };
}

/** The `fix:` task of a fit pass's blocker and major findings (`start_fix`'s input). */
export function fitFix(round: number, findings: readonly { severity: string; file: string | null; line: number | null; text: string }[]): { title: string; request: string } {
  const lines = findings
    .filter((finding) => finding.severity === "blocker" || finding.severity === "major")
    .map((finding) => `- ${finding.severity}${finding.file === null ? "" : ` ${finding.file}${finding.line === null ? "" : `:${finding.line}`}`}: ${finding.text}`);
  return {
    title: `fix: how the wave's tasks fit together (wave review round ${round})`,
    request: [`The wave's reviewer, judging how the wave's tasks fit together, found:`, "", ...lines, "", "Fix them on the wave's branch; your change is reviewed like every task's."].join("\n"),
  };
}

/** The `/factory reviewed` command of a recorded review. */
export function reviewedCommand(review: WaveTaskReview, sessionFilePath: string | null): string {
  const data: ReviewData = {
    round: review.round,
    status: review.status as ReviewStatus,
    approved: review.verdict === "approved",
    findings: review.findings,
    model: review.model,
    sessionFile: sessionFilePath,
    usage: review.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    wallMs: review.wallMs,
  };
  return `/factory reviewed ${JSON.stringify({ round: review.round, review: data })}`;
}

/**
 * One step of the wave's review queue: reviews (or hands over again) the first task resting `reviewing`. True when it
 * did something (look again), false when nothing waits or the review was cut short.
 */
export async function reviewNext(fold: StartedWaveFold, states: TaskStates, deps: ReviewEachDeps): Promise<boolean> {
  const waiting = fold.tasks.filter((task) => task.taskId !== null && states.get(task.key) === "reviewing");
  if (waiting.length === 0) return false;
  const records = new Map((await listTasks()).map((record) => [record.id, record]));
  for (const task of waiting) {
    const record = records.get(task.taskId as string);
    if (record === undefined) continue;
    const state = await lastFactoryState(record.sessionDir, record.sessionId);
    if (state?.state !== "reviewing") continue;
    // Its runner still ends (or applies a verdict): it pokes the wave once the task rests.
    if ((await liveRunners(record)).length > 0) continue;
    const handled = `${record.id}:${state.round}`;
    let review = (fold.taskReviews ?? []).find((candidate) => candidate.taskId === record.id && candidate.round === state.round);
    if (review === undefined) {
      const event = await reviewTask(fold, task.key, record, state.round, deps);
      if (event === null) return false;
      const written = await appendWaveEvents(fold.id, (now) => ((now.taskReviews ?? []).some((candidate) => candidate.taskId === record.id && candidate.round === state.round) ? null : [event]));
      if (written === null) return true;
      review = written[0] as WaveTaskReview & { kind: "task_review" };
    }
    const count = deps.delivered.get(handled) ?? 0;
    if (count >= DELIVERIES) {
      deps.log(`task ${task.key} stays reviewing round ${state.round} after ${count} hand-overs of its verdict; a restart tries again`);
      continue;
    }
    deps.delivered.set(handled, count + 1);
    const file = await sessionFile(waveReviewsDir(fold.id), fold.id);
    const deliver = deps.deliver ?? messageTask;
    await deliver(record, reviewedCommand(review, file ?? null), deps.env).catch((error: unknown) => deps.log(`handing task ${task.key} its verdict: ${errorText(error)}`));
    deps.log(`task ${task.key} round ${state.round}: ${review.verdict}`);
    return true;
  }
  return false;
}
