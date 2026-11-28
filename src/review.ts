/**
 * The reviewer child: a Pi that sees the diff through `read_diff` and answers only through `submit_verdict`. One
 * launch per review (`runReviewer`), for a task's own review and a wave's reviewer session.
 * - The reviewer has no time limit: it runs until it answers or is cancelled
 * - It has a shell but never edits: a worktree it changed is put back and its verdict is void (`failed`)
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git, nulList, snapshotTree, type TaskDiff } from "./git.ts";
import { runCommand, type Exec } from "./run.ts";
import { approvedFrom, type Finding, type ReviewData, type ReviewStatus, type Severity, type Task } from "./state.ts";
import { addUsage, jsonLines, NO_USAGE, piUsage, type Usage } from "./util.ts";

export const VERDICT_TOOL = "submit_verdict";
export const REVIEW_DIFF_ENV = "FACTORY_REVIEW_DIFF";
/** How an earlier review's tool result reaches the reviewer's model (`pi/reviewer-tool.ts`). */
export const STUB_PREFIX = "[reviewed]";
const REVIEWER_TOOL_EXTENSION = join(import.meta.dirname, "pi", "reviewer-tool.ts");
/** The factory's part of every reviewer's system prompt; a repository's `.factory/agents/reviewer.md` follows it. */
const REVIEWER_RULES =
  "Your shell is for answering questions efficiently, run in the worktree the review names: the code before the change (`git show $FACTORY_BASE:<path>`, $FACTORY_BASE being the commit the reviewed change starts at), what changed (`git log $FACTORY_BASE..HEAD`, `git diff $FACTORY_BASE -- <path>`), a search, or one test file (the way the repository's factory.yaml or AGENTS.md names to run one, if it names one). " +
  "You never write, edit, format or generate files, never commit, and never fix what you find: you review, and your findings (and start_fix where you have it) are the instructions for a coder. " +
  "A worktree you changed is put back and your verdict is void.";
const SEVERITIES: readonly Severity[] = ["blocker", "major", "minor"];
const PATCH_MAX_CHARS = 200_000;
const PATHS_MAX = 500;
/** The child's JSONL stream: the session line, the verdict call and the usage of every message. */
const REVIEWER_STDOUT_MAX_CHARS = 32_000_000;

/**
 * The patch as the reviewer gets it: every changed path first, then the patch cut at `maxChars` with a line that
 * says so. The list survives any cut, so the reviewer knows which files it has not seen.
 */
export function reviewPatch(diff: Pick<TaskDiff, "paths" | "patch">, maxChars: number): string {
  const listed = diff.paths.slice(0, PATHS_MAX).map((path) => `- ${path}`);
  if (diff.paths.length > PATHS_MAX) listed.push(`- and ${diff.paths.length - PATHS_MAX} more`);
  const header = `Changed files (${diff.paths.length}):\n${listed.join("\n")}\n\n`;
  if (diff.patch.length <= maxChars) return header + diff.patch;
  return (
    `${header}${diff.patch.slice(0, maxChars)}\n\n` +
    `[patch cut here: ${diff.patch.length - maxChars} more characters. Read the files listed at the top that the patch does not show.]\n`
  );
}

/** The file sections of a `git diff` patch with the path each names (`diff --git a/<path> b/<path>`), in order. */
function sections(patch: string): { path: string; text: string }[] {
  const parts = patch.split(/^(?=diff --git )/m).filter((part) => part !== "");
  return parts.map((text) => {
    const head = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
    const match = / b\/(.*)$/.exec(head);
    return { path: match?.[1] ?? "", text };
  });
}

function wanted(path: string, paths: readonly string[]): boolean {
  return paths.some((want) => {
    const clean = want.replace(/^\.\//, "").replace(/\/+$/, "");
    return path === clean || path.startsWith(`${clean}/`);
  });
}

/** `read_diff`'s text of the diff file `json` (`{paths, patch}`): all of it, or only `paths` when given. */
export function readDiffText(json: string, paths?: readonly string[]): string {
  const diff = JSON.parse(json) as { paths: string[]; patch: string };
  if (diff.patch.trim() === "") return "Nothing changed since the tree you judged last.";
  if (paths === undefined || paths.length === 0) return reviewPatch(diff, PATCH_MAX_CHARS);
  const chosen = diff.paths.filter((path) => wanted(path, paths));
  const patch = sections(diff.patch)
    .filter((section) => wanted(section.path, paths))
    .map((section) => section.text)
    .join("");
  if (chosen.length === 0) return `None of ${paths.join(", ")} changed. Changed: ${diff.paths.join(", ")}`;
  return reviewPatch({ paths: chosen, patch }, PATCH_MAX_CHARS);
}

/** The request file as the reviewer gets it: the task's request, then every follow-up message of the user in order. */
export function reviewRequest(task: Pick<Task, "title" | "request">, followUps: string[]): string {
  const request = `# ${task.title}\n\n${task.request}\n`;
  if (followUps.length === 0) return request;
  const messages = followUps.map((text, index) => `### Message ${index + 1}\n\n${text}\n`);
  return `${request}\n## Follow-up messages from the user\n\n${messages.join("\n")}`;
}

/** The findings of a `submit_verdict` call, or a string that says what is wrong with `value`. */
export function parseFindings(value: unknown): Finding[] | string {
  if (!Array.isArray(value)) return "findings is not an array";
  const findings: Finding[] = [];
  for (const [index, raw] of value.entries()) {
    if (typeof raw !== "object" || raw === null) return `findings[${index}] is not an object`;
    const finding = raw as Record<string, unknown>;
    if (typeof finding.file !== "string" || finding.file === "") return `findings[${index}].file is not a string`;
    const line = finding.line ?? null;
    if (line !== null && !(typeof line === "number" && Number.isInteger(line))) return `findings[${index}].line is not an integer or null`;
    if (!SEVERITIES.includes(finding.severity as Severity)) return `findings[${index}].severity is not one of ${SEVERITIES.join(", ")}`;
    if (typeof finding.text !== "string" || finding.text === "") return `findings[${index}].text is not a string`;
    findings.push({ file: finding.file, line, severity: finding.severity as Severity, text: finding.text });
  }
  return findings;
}

export interface ReviewerOutput {
  /** Findings of the last valid `submit_verdict` call, null without one. */
  findings: Finding[] | null;
  sessionId: string | null;
  usage: Usage;
}

/** Reads the reviewer's JSONL stdout. Lines that are not JSON are skipped (a killed run ends mid-line). */
export function readReviewerOutput(stdout: string): ReviewerOutput {
  const output: ReviewerOutput = { findings: null, sessionId: null, usage: NO_USAGE };
  for (const event of jsonLines<any>(stdout)) {
    if (event.type === "session" && typeof event.id === "string") output.sessionId = event.id;
    if (event.type === "tool_execution_end" && event.toolName === VERDICT_TOOL && !event.isError) {
      const findings = parseFindings(event.result?.details?.findings);
      if (typeof findings !== "string") output.findings = findings;
    }
    if (event.type === "message_end" && event.message?.role === "assistant") output.usage = addUsage(output.usage, piUsage(event.message.usage));
  }
  return output;
}

/** The reviewer's session file `<time>_<id>.jsonl` in `dir`, null before its first run. */
export async function reviewerSession(dir: string, id: string): Promise<string | null> {
  const name = (await readdir(dir).catch(() => [] as string[])).find((entry) => entry.endsWith(`_${id}.jsonl`));
  return name === undefined ? null : join(dir, name);
}

export interface ReviewerRun {
  status: ReviewStatus;
  /** Empty unless `status` is `ok`. */
  findings: Finding[];
  sessionId: string | null;
  sessionFile: string | null;
  model: string | null;
  usage: Usage;
  wallMs: number;
  /** What the reviewer changed in its worktree (put back, `status` failed): paths, or that HEAD moved; empty: nothing. */
  edited: string[];
}

export interface ReviewerLaunch {
  cwd: string;
  /** The worktree under review, compared before and after the run. */
  worktree: string;
  /** The commit the reviewed change starts at: `FACTORY_BASE` in the reviewer's environment. */
  base: string;
  /** The session directory; the diff file goes there too. */
  dir: string;
  /** Resume (or create) this session; absent: a new one. */
  sessionId?: string;
  tools: string;
  /** `provider/model` for the child, null for its own default. */
  model: string | null;
  rolePrompt: string | undefined;
  prompt: string;
  diff: Pick<TaskDiff, "paths" | "patch">;
  /** The diff file's name in `dir`, without `.diff.json`. */
  diffName: string;
  env?: Record<string, string>;
  cancelled: () => boolean;
  /** The wave's or the task's log. */
  log: (text: string) => void;
}

/** One run of a reviewer child: the diff behind `read_diff`, the verdict read from its stdout. */
export async function runReviewer(exec: Exec, input: ReviewerLaunch): Promise<ReviewerRun> {
  await mkdir(input.dir, { recursive: true });
  const diffFile = join(input.dir, `${input.diffName}.diff.json`);
  await writeFile(diffFile, JSON.stringify({ paths: input.diff.paths, patch: input.diff.patch }));
  const argv = ["pi", "--mode", "json", "-p", "--tools", input.tools, "-ne", "-e", REVIEWER_TOOL_EXTENSION, "--no-skills", "--no-prompt-templates", "--no-themes", "--session-dir", input.dir];
  if (input.sessionId) argv.push("--session-id", input.sessionId);
  if (input.model) argv.push("--model", input.model);
  argv.push("--append-system-prompt", input.rolePrompt ? `${REVIEWER_RULES}\n\n${input.rolePrompt}` : REVIEWER_RULES);
  argv.push(input.prompt);
  // The worktree as it starts, its own uncommitted work included (a task's change is not committed before its merge).
  // `runCommand`: what a cancel does not stop, so a changed worktree is always put back.
  const head = () => git(runCommand, input.worktree, ["rev-parse", "HEAD"]);
  const start = { head: await head(), tree: await snapshotTree(runCommand, input.worktree) };
  // No `timeoutMs`: a review takes as long as the change needs; only a cancel ends it early.
  const env = { ...input.env, [REVIEW_DIFF_ENV]: diffFile, FACTORY_BASE: input.base };
  const child = await exec(argv, { cwd: input.cwd, env, maxStdoutChars: REVIEWER_STDOUT_MAX_CHARS });
  const end = { head: await head(), tree: await snapshotTree(runCommand, input.worktree) };
  const edited = nulList(await git(runCommand, input.worktree, ["diff", "--name-only", "-z", start.tree, end.tree]));
  if (end.head !== start.head) edited.push(`HEAD moved to ${end.head.slice(0, 12)}`);
  if (edited.length > 0) {
    for (const args of [["reset", "--quiet", "--hard", start.head], ["clean", "-fdq"], ["read-tree", "--reset", "-u", "HEAD", start.tree], ["reset", "--quiet"]]) await git(runCommand, input.worktree, args);
    input.log(`the reviewer changed its worktree (${edited.join(", ")}): put back, its verdict is void`);
  }
  const output = readReviewerOutput(child.stdout);
  // A killed or failed run never yields a verdict, even when a verdict call is already in the stream.
  let status: ReviewStatus = "ok";
  if (child.killed || input.cancelled()) status = "aborted";
  else if (child.exitCode !== 0 || edited.length > 0) status = "failed";
  else if (output.findings === null) status = "malformed";
  return {
    status,
    findings: status === "ok" ? (output.findings ?? []) : [],
    sessionId: output.sessionId,
    sessionFile: output.sessionId === null ? null : await reviewerSession(input.dir, output.sessionId),
    model: input.model,
    usage: output.usage,
    wallMs: child.durationMs,
    edited,
  };
}

export interface ReviewInput {
  exec: Exec;
  root: string;
  round: number;
  task: Task;
  /** The user's messages to the task after its request (`followUpMessages`): part of the task. */
  followUps: string[];
  diff: TaskDiff;
  model: string | null;
  rolePrompt: string | undefined;
  /** Holds this task's reviewer sessions, request and diff files. */
  reviewsDir: string;
  cancelled: () => boolean;
}

/** A task's own review (outside a wave): a fresh reviewer on the task's request and its diff. */
export async function runReview(input: ReviewInput): Promise<ReviewData> {
  const { round, model, reviewsDir } = input;
  if (input.diff.patch.trim() === "") {
    return { round, status: "no_diff", approved: false, findings: [], model, sessionFile: null, usage: NO_USAGE, wallMs: 0 };
  }
  await mkdir(reviewsDir, { recursive: true });
  // The request goes into a file: as an argument a long one would exceed the argv limit.
  const requestFile = join(reviewsDir, `round-${round}.request.md`);
  await writeFile(requestFile, reviewRequest(input.task, input.followUps));
  const prompt =
    `Review the change of a task. The task is in ${requestFile}: read it with the read tool; read_diff shows its diff. Its worktree is the current directory. ` +
    `Look at the surrounding code where the diff alone is not enough, then finish with ${VERDICT_TOOL}. ` +
    `Follow-up messages from the user in the task file are part of the task: a change one of them asks for is on-request.`;
  const tools = `read,grep,find,ls,bash,read_diff,${VERDICT_TOOL}`;
  const launch = { cwd: input.root, worktree: input.root, base: input.diff.base, dir: reviewsDir, tools, model, rolePrompt: input.rolePrompt, prompt, diff: input.diff, diffName: `round-${round}` };
  // A task outside a wave: its Pi's stderr is the task's log.
  const run = await runReviewer(input.exec, { ...launch, cancelled: input.cancelled, log: (text) => console.error(`review: ${text}`) });
  const { status, findings, sessionFile, usage, wallMs } = run;
  return { round, status, approved: approvedFrom(status, findings), findings, model, sessionFile, usage, wallMs };
}
