/**
 * Review per task: the wave's runner has the wave's reviewer judge each task resting `reviewing`, one after another,
 * and hands the verdict to the task (`/factory reviewed`).
 * - The `task_review` event is recorded before the hand-over, so a runner that died after it hands it over again; the
 *   task applies a verdict only while it rests `reviewing` in that round, so a second hand-over changes nothing
 * - One reviewer session per wave (`--session-id` = the wave's id): model, prompt and tools stay the same at every
 *   resume, so the cached prefix holds. A review the runner's stop cut short records nothing
 */
import { join } from "node:path";
import { loadTaskFiles } from "./config.ts";
import { readContract, stampOf, type ContractFacts } from "./contracts.ts";
import { git, snapshotTree, treeDiff, type TaskDiff } from "./git.ts";
import { liveRunners, messageTask, type RunnerEnv } from "./launch.ts";
import { reviewerSession, runReviewer, STUB_PREFIX, VERDICT_TOOL, type ReviewerRun } from "./review.ts";
import type { Exec } from "./run.ts";
import { lastFactoryState } from "./runner.ts";
import { approvedFrom, rejectingLines, type Finding, type ReviewData, type ReviewStatus } from "./state.ts";
import { listTasks, type TaskRecord } from "./tasks.ts";
import { errorText } from "./util.ts";
import { waveReviewsDir } from "./wave-poke.ts";
import { appendWaveEvents, type NewWaveEvent, type WaveFold, type TaskStates, type WaveTaskReview } from "./waves.ts";

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

/**
 * The wave's contracts as prompt lines (none without contracts, a pointer when their text is unchanged since the
 * last review) and the hash of their text (null: none).
 */
async function contractsSection(fold: WaveFold): Promise<{ lines: string[]; hash: string | null }> {
  const names = fold.contracts ?? [];
  if (fold.plan === null || names.length === 0) return { lines: [], hash: null };
  const all: ContractFacts = new Map();
  const blocks: string[] = [];
  for (const name of names) {
    const facts = await readContract(fold.plan, name);
    for (const [path, text] of [...facts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      all.set(path, text);
      blocks.push(`### ${path}\n\n${text}\n`);
    }
  }
  const hash = stampOf(all).hash;
  const reviews = fold.taskReviews;
  if (reviews.length > 0 && reviews.at(-1)?.contracts === hash) return { lines: ["", "## The wave's contracts", "", "Unchanged since your last review: they are above."], hash };
  return { lines: ["", "## The wave's contracts (they win over the request)", "", blocks.join("\n")], hash };
}

/**
 * The reviewer's tools, the same in every pass (the prompt cache): `feedback` in the fit pass is the wave's (task null),
 * `start_fix` and `notify_supervisor` work in both.
 */
export const REVIEWER_TOOLS = `read,grep,find,ls,read_diff,scout,feedback,notify_supervisor,start_fix,${VERDICT_TOOL}`;

/** A run of the wave's reviewer session with its verdict: only a blocker or major finding rejects. */
export type WaveReviewerRun = ReviewerRun & { verdict: "approved" | "rejected" | "failed" };

/**
 * Resumes the wave's reviewer session on `prompt` with `diff` behind `read_diff`: the same argv, directory, model and
 * tools at every resume. `taskId` the task under review (null: the wave's fit pass). Null when cut short.
 */
async function runWaveReviewer(fold: WaveFold, prompt: string, diff: TaskDiff, diffName: string, taskId: string | null, deps: ReviewEachDeps): Promise<WaveReviewerRun | null> {
  const dir = waveReviewsDir(fold.id);
  // The wave's base: the same role prompt at every resume of the session.
  const { prompts } = await loadTaskFiles(deps.exec, fold.repo, fold.base);
  const env: Record<string, string> = { PI_CACHE_RETENTION: "long", FACTORY_REVIEW_WAVE: fold.id };
  if (taskId !== null) env.FACTORY_REVIEW_TASK = taskId;
  if (fold.plan !== null) env.FACTORY_REVIEW_PLAN = fold.plan;
  const model = fold.overrides.models?.reviewer ?? null;
  const run = await runReviewer(deps.exec, { cwd: dir, dir, sessionId: fold.id, tools: REVIEWER_TOOLS, model, rolePrompt: prompts.reviewer, prompt, diff, diffName, env, cancelled: deps.cancelled });
  if (run.status === "aborted") return null;
  return { ...run, verdict: run.status !== "ok" ? "failed" : approvedFrom(run.status, run.findings) ? "approved" : "rejected" };
}

/** Runs the reviewer on the task `key` in its `round` and answers the `task_review` event; null when cut short. */
async function reviewTask(fold: WaveFold, key: string, record: TaskRecord, round: number, deps: ReviewEachDeps): Promise<NewWaveEvent | null> {
  const spec = fold.tasks.find((task) => task.key === key);
  if (spec === undefined) return null;
  const { exec } = deps;
  const worktree = record.worktree;
  const base = await git(exec, worktree, ["merge-base", "HEAD", `refs/heads/${fold.branch}`]);
  const tree = await snapshotTree(exec, worktree);
  const previous = fold.taskReviews.filter((review) => review.taskId === record.id && review.round < round).at(-1);
  const since = previous !== undefined && previous.base === base ? previous : null;
  const diff = await treeDiff(exec, worktree, since?.tree ?? base, tree);
  const contracts = await contractsSection(fold);
  const prompt = [
    `Review task ${key} "${spec.title}", round ${round}, of the wave "${fold.title}" (it merges into ${fold.branch}).`,
    `Its worktree is ${worktree}: read its files there by absolute path. read_diff shows ${since === null ? "its whole change against its base" : `what changed since the tree you judged in its round ${since.round}`}; it is the only diff you get.`,
    `Earlier tool results in this session are stubs starting with ${STUB_PREFIX}: judge this task from read_diff and its files. Your own earlier verdicts on it stay above.`,
    `Only blocker and major findings send the task back to its coder; minor ones are kept and never start a round. Finish with ${VERDICT_TOOL}.`,
    "",
    "## The task's request",
    "",
    spec.request,
    ...contracts.lines,
  ].join("\n");
  deps.log(`review of task ${key}, round ${round}`);
  const run = await runWaveReviewer(fold, prompt, diff, `${key}-round-${round}`, record.id, deps);
  if (run === null) return null;
  const { sessionId, model, verdict, status, findings, usage, wallMs } = run;
  return { kind: "task_review", key, taskId: record.id, round, tree, base, contracts: contracts.hash, sessionId, model, verdict, status, findings, usage, wallMs };
}

/**
 * The end of a wave's review: one pass of the wave's reviewer session on how its tasks fit together, the wave's
 * whole change (`diff`, against the target) behind `read_diff`. Null when cut short.
 */
export async function reviewFit(fold: WaveFold, input: { root: string; round: number; diff: TaskDiff }, deps: ReviewEachDeps): Promise<WaveReviewerRun | null> {
  const contracts = await contractsSection(fold);
  const prompt = [
    `Review how the tasks of the wave "${fold.title}" fit together (wave review round ${input.round}): every task is done and merged into ${fold.branch}, the wave is rebased onto ${fold.target} and its merge_gates passed.`,
    `Its review worktree is ${input.root}: read its files there by absolute path. read_diff shows the wave's whole change against ${fold.target}; it is the only diff you get.`,
    `You judged each task on its own above (earlier tool results are stubs starting with ${STUB_PREFIX}). Judge now only what lies between the tasks: interfaces that do not match, the same thing built twice, one task undoing another, a piece of the request no task covered.`,
    `Only blocker and major findings count; the factory turns them into one fix: task of the wave, so do not call start_fix in this pass. Finish with ${VERDICT_TOOL}.`,
    "",
    "## The wave's tasks",
    "",
    ...fold.tasks.filter((task) => task.taskId !== null).map((task) => `- ${task.key}: ${task.title}`),
    "",
    "## The wave's request",
    "",
    fold.request,
    ...contracts.lines,
  ].join("\n");
  deps.log(`fit pass, wave review round ${input.round}`);
  return runWaveReviewer(fold, prompt, input.diff, `wave-round-${input.round}`, null, deps);
}

/** The `fix:` task of a fit pass's blocker and major findings (`start_fix`'s input). */
export function fitFix(round: number, findings: readonly Finding[]): { title: string; request: string } {
  return {
    title: `fix: how the wave's tasks fit together (wave review round ${round})`,
    request: [`The wave's reviewer, judging how the wave's tasks fit together, found:`, "", rejectingLines(findings), "", "Fix them on the wave's branch; your change is reviewed like every task's."].join("\n"),
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
    usage: review.usage,
    wallMs: review.wallMs,
  };
  return `/factory reviewed ${JSON.stringify({ round: review.round, review: data })}`;
}

/**
 * One step of the wave's review queue: reviews (or hands over again) the first task resting `reviewing`. True when it
 * did something (look again), false when nothing waits or the review was cut short.
 */
export async function reviewNext(fold: WaveFold, states: TaskStates, deps: ReviewEachDeps): Promise<boolean> {
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
    let review = fold.taskReviews.find((candidate) => candidate.taskId === record.id && candidate.round === state.round);
    if (review === undefined) {
      const event = await reviewTask(fold, task.key, record, state.round, deps);
      if (event === null) return false;
      const written = await appendWaveEvents(fold.id, (now) => (now.taskReviews.some((candidate) => candidate.taskId === record.id && candidate.round === state.round) ? null : [event]));
      if (written === null) return true;
      review = written[0] as WaveTaskReview & { kind: "task_review" };
    }
    const count = deps.delivered.get(handled) ?? 0;
    if (count >= DELIVERIES) {
      deps.log(`task ${task.key} stays reviewing round ${state.round} after ${count} hand-overs of its verdict; a restart tries again`);
      continue;
    }
    deps.delivered.set(handled, count + 1);
    const file = await reviewerSession(waveReviewsDir(fold.id), fold.id);
    const deliver = deps.deliver ?? messageTask;
    await deliver(record, reviewedCommand(review, file), deps.env).catch((error: unknown) => deps.log(`handing task ${task.key} its verdict: ${errorText(error)}`));
    deps.log(`task ${task.key} round ${state.round}: ${review.verdict}`);
    return true;
  }
  return false;
}
