/**
 * The pipeline of one round, as control flow over injected steps (`PipelineSteps`). No Pi, no git, no spawn of its own.
 * - A passed `auto` round ends in `merging` and does not merge: the caller merges once it knows the run was not aborted
 * - A rebase conflict becomes a `conflict` round, a merge gate failing on the rebased branch a `gates` round
 * - A hook or gate that exits `INFRA_EXIT` (75, EX_TEMPFAIL) says the environment is broken, not the change: the task
 *   ends `blocked` without feedback to the coder
 */
import { COMMIT_MESSAGE_PROMPT, commitMessageFallback, parseCommitMessage } from "./commitmsg.ts";
import { protectedPaths, type FactoryConfig } from "./config.ts";
import { runGateStep } from "./flaky-rerun.ts";
import type { TaskDiff } from "./git.ts";
import type { MergeOutcome } from "./merge.ts";
import type { CommandResult } from "./run.ts";
import {
  commandFeedback,
  conflictFeedback,
  customDraft,
  feedbackDraft,
  gateData,
  INFRA_EXIT,
  passed,
  protectedFeedback,
  reviewFeedback,
  roundsUsed,
  stateDraft,
  COMMIT_ASK_TYPE,
  type CommitAskDraft,
  type Draft,
  type ReviewData,
  type Snapshot,
  type State,
  type Trigger,
} from "./state.ts";
import { errorText } from "./util.ts";

export interface PipelineSteps {
  status(text: string): void;
  cancelled(): boolean;
  /** True when a user message is queued: it starts a coder turn as soon as the round's pipeline returns. */
  pendingMessages(): boolean;
  config(): FactoryConfig;
  /** Runs a hook or gate in the task's checkout. */
  /** `env`: added to the command's environment (a gate's test slot). */
  runCommand(argv: string[], env?: Record<string, string>): Promise<CommandResult>;
  diff(): Promise<TaskDiff>;
  review(round: number, diff: TaskDiff): Promise<ReviewData>;
  merge(config: FactoryConfig): Promise<MergeOutcome>;
  /** The conflicting files of a rebase in progress in the task's worktree, null when none is. */
  openRebase(): Promise<string[] | null>;
  /** True when a passed round asks the coder for the commit message before it ends. */
  askCommitMessage(): boolean;
  /**
   * True when the task belongs to a wave: a passed round rests `reviewing` for the wave's reviewer instead of the
   * task's own review, approve or merge.
   */
  inWave(): Promise<boolean>;
}

export interface RoundResult {
  entries: Draft[];
  /** True when the entries end with feedback and the coder runs the next round. */
  continue: boolean;
  /** Set when the entries end with the commit message ask: the state the round passed into, once answered. */
  commitAsk?: State;
}

export function commitAskDraft(round: number): CommitAskDraft {
  return { type: "custom_message", customType: COMMIT_ASK_TYPE, content: COMMIT_MESSAGE_PROMPT, display: true, details: { round } };
}

/**
 * The entries after the coder answered the commit message ask of a round that passed into `passedInto`: the message
 * (the task title when the answer is not a valid one) and that state, or a message round when a user message is queued.
 */
export function commitAnswerDrafts(snapshot: Snapshot, answer: string, passedInto: State, pendingMessages: boolean): RoundResult {
  const message = parseCommitMessage(answer) ?? commitMessageFallback(snapshot.task.title);
  const entries: Draft[] = [customDraft("factory-commit-message", message), stateDraft(passedInto, snapshot.round, "passed")];
  return pendingMessages ? { entries: [...entries, ...messageRoundDrafts(snapshot.round)], continue: true } : { entries, continue: false };
}

function lastLine(output: string): string {
  const lines = output.trim().split("\n");
  return (lines[lines.length - 1] ?? "").slice(0, 200);
}

/**
 * The round a queued message gets after round `round` ended. That message starts a coder turn right after the
 * boundary, with no `before_agent_start`.
 */
export function messageRoundDrafts(round: number): Draft[] {
  return [customDraft("factory-round", { round: round + 1, trigger: "message" }), stateDraft("running", round + 1, "message")];
}

/**
 * A problem found in the snapshot's round: the next coder round, its feedback and `running` (a round in progress is
 * `running` already), or the feedback and `blocked`, `max_rounds: <trigger>`, when the run used up its `maxRounds`.
 */
function nextRound(snapshot: Snapshot, trigger: Trigger, text: string): RoundResult {
  const { round } = snapshot;
  const feedback = feedbackDraft(round, trigger, text);
  if (roundsUsed(snapshot) >= snapshot.task.settings.maxRounds) return { entries: [feedback, stateDraft("blocked", round, `max_rounds: ${trigger}`)], continue: false };
  const running = snapshot.state === "running" ? [] : [stateDraft("running", round + 1, trigger)];
  return { entries: [customDraft("factory-round", { round: round + 1, trigger }), feedback, ...running], continue: true };
}

/** The entries after `merging`: the merge gates, the merge and the state it ends in. */
export async function runMerge(snapshot: Snapshot, config: FactoryConfig, steps: PipelineSteps): Promise<Draft[]> {
  const { round } = snapshot;
  steps.status(`round ${round}: merge`);
  const { gates, result } = await steps.merge(config);
  const drafts: Draft[] = gates.map((gate) => customDraft("factory-gate", gate));
  // Nothing was merged: the coder resolves the conflict or the failed gate in a round of its own, unless cancelled.
  const problem = (trigger: Trigger, text: string): Draft[] => [...drafts, ...nextRound(snapshot, trigger, text).entries];
  switch (result.kind) {
    case "conflict":
      if (steps.cancelled()) return [...drafts, stateDraft("cancelled", round, "cancelled")];
      return problem("conflict", conflictFeedback(round, snapshot.task.mainBranch, result.files, false));
    case "gate_failed": {
      const { argv, result: gate } = result.gate;
      if (steps.cancelled()) return [...drafts, stateDraft("cancelled", round, "cancelled")];
      if (gate.exitCode === INFRA_EXIT && !gate.killed) return [...drafts, stateDraft("blocked", round, `infra: ${lastLine(gate.output)}`)];
      return problem("gates", `After the rebase onto ${snapshot.task.mainBranch}: ${commandFeedback(round, argv, gate)}`);
    }
    case "dirty":
      return [...drafts, stateDraft("blocked", round, "dirty")];
    case "merged": {
      const { merge } = result;
      // A failed `after_merge` hook cannot undo the merge: the task is done, and says what is left to do.
      return [...drafts, customDraft("factory-merge", merge), stateDraft("done", round, merge.error ? "merged, after_merge failed" : "merged")];
    }
    case "failed":
      drafts.push(customDraft("factory-merge", result.merge));
      drafts.push(steps.cancelled() ? stateDraft("cancelled", round, "cancelled") : stateDraft("blocked", round, "merge_failed"));
      return drafts;
  }
}

/** Everything after a coder turn: hooks, gates, protected paths, review, then `merging` or the wait for approve. */
export async function runRound(snapshot: Snapshot, steps: PipelineSteps): Promise<RoundResult> {
  const { round, task } = snapshot;
  const drafts: Draft[] = [];
  const messageRound = (): RoundResult => {
    drafts.push(...messageRoundDrafts(round));
    return { entries: drafts, continue: true };
  };
  const end = (state: State, reason: string): RoundResult => {
    drafts.push(stateDraft(state, round, reason));
    return state !== "cancelled" && steps.pendingMessages() ? messageRound() : { entries: drafts, continue: false };
  };
  const problem = (trigger: Trigger, text: string): RoundResult => {
    const next = nextRound(snapshot, trigger, text);
    drafts.push(...next.entries);
    return next.continue || !steps.pendingMessages() ? { entries: drafts, continue: next.continue } : messageRound();
  };

  try {
    const config = steps.config();
    const conflicts = await steps.openRebase();
    if (conflicts) return problem("conflict", conflictFeedback(round, task.mainBranch, conflicts, true));
    for (const argv of config.gates) {
      steps.status(`round ${round}: gates ${argv.join(" ")}`);
      // A failed gate runs once more before it counts (`runGateStep`).
      const { result, flaky } = await runGateStep(argv, (env) => steps.runCommand(argv, env), steps.cancelled);
      drafts.push(customDraft("factory-gate", gateData(round, "gates", argv, result, flaky)));
      if (steps.cancelled()) return end("cancelled", "cancelled");
      if (result.exitCode === INFRA_EXIT && !result.killed) return end("blocked", `infra: ${lastLine(result.output)}`);
      if (!passed(result)) return problem("gates", commandFeedback(round, argv, result));
    }

    steps.status(`round ${round}: diff`);
    const diff = await steps.diff();
    // Nothing differs from the diff base, whatever opened the round: nothing to review, approve or merge.
    if (diff.paths.length === 0) return end("done", "no_changes");
    const touched = protectedPaths(diff.paths, config.protected);
    if (touched.length > 0) return problem("protected", protectedFeedback(round, touched));

    const byWave = await steps.inWave();
    if (task.settings.review && !byWave) {
      steps.status(`round ${round}: review`);
      const review = await steps.review(round, diff);
      drafts.push(customDraft("factory-review", review));
      if (steps.cancelled() || review.status === "aborted") return end("cancelled", "cancelled");
      if (review.status === "ok" && !review.approved) return problem("review", reviewFeedback(round, review.findings));
      if (review.status !== "ok" && review.status !== "no_diff") return end("blocked", `review_${review.status}`);
    }

    // The message is about a change that is neither approved nor merged yet: it goes first.
    if (steps.pendingMessages()) return messageRound();
    const passedInto: State = byWave ? "reviewing" : task.settings.merge === "review" ? "waiting_approve" : "merging";
    if (steps.askCommitMessage()) {
      drafts.push(commitAskDraft(round));
      return { entries: drafts, continue: true, commitAsk: passedInto };
    }
    return end(passedInto, "passed");
  } catch (error) {
    return steps.cancelled() ? end("cancelled", "cancelled") : end("blocked", `pipeline_error: ${errorText(error)}`);
  }
}

/**
 * The entries of the wave reviewer's verdict on a task resting `reviewing` in the snapshot's round (`/factory
 * reviewed`): the `factory-review` entry, then `merging` when it approves; with a blocker or major finding the next
 * round and its feedback (only those findings), or `blocked`, `max_rounds: review`, when the run's rounds are used up;
 * `blocked`, `review_<status>`, when the reviewer gave no verdict.
 */
export function reviewedDrafts(snapshot: Snapshot, review: ReviewData): RoundResult {
  const { round } = snapshot;
  const entries: Draft[] = [customDraft("factory-review", review)];
  if (review.status !== "ok") return { entries: [...entries, stateDraft("blocked", round, `review_${review.status}`)], continue: false };
  if (review.approved) return { entries: [...entries, stateDraft("merging", round, "approved")], continue: false };
  const next = nextRound(snapshot, "review", reviewFeedback(round, review.findings.filter((finding) => finding.severity !== "minor")));
  return { entries: [...entries, ...next.entries], continue: next.continue };
}
