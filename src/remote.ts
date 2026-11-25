/**
 * A wave on its origin's forge (repository setting `remote`, stored resolved in the wave's declaration). The only
 * module that runs `git push`, `gh` or `glab`; the factory stays the source of truth, the forge only shows the wave.
 *
 * - `publishWave`, after the review's rebase: pushes the wave's branch only (`--force-with-lease`; the target is left
 *   alone until the merge), then opens the pull/merge request against the target once; a request the log already
 *   holds is reused
 * - `commentReview`, after a review's verdict is recorded: the verdict and its findings as a comment on the request
 * - `publishMerge`, after the fast-forward: pushes the wave's branch and the target, so the forge shows the request
 *   merged with its commits. `mergePending` is the `remote` event the merge's own append records before its stage
 *   change: a runner that dies before the push leaves the log saying the push is missing, never silent
 * - The forge is the origin URL's as configured (`remote.origin.url`, before any `insteadOf`): a host naming github
 *   runs `gh`, one naming gitlab runs `glab`; any other is recorded `unsupported` (the pushes still happen)
 * - Every step appends a `remote` event (the fields it learnt; `error` null on success, the failure's text otherwise).
 *   Nothing throws: a failure (a refused push, a missing CLI, a timeout, a removed wave) is recorded and the wave goes
 *   on. Each command has a time limit and never prompts
 * - `remote` off: no command runs at all
 */
import { runCommand, type Exec } from "./run.ts";
import { errorText, outputTail } from "./util.ts";
import { appendWaveEvent, type NewWaveEvent, type WaveDeclaration, type WaveRemote, type WaveReview } from "./waves.ts";

export type Forge = "github" | "gitlab";

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

/** The wave as these steps need it: its declaration and what the log knows of the forge. */
export type RemoteWave = Pick<WaveDeclaration, "id" | "repo" | "title" | "request" | "tag" | "branch" | "target" | "overrides"> & { remote: WaveRemote | null };

/** A push or forge call that takes longer is ended and recorded as failed. */
const COMMAND_TIMEOUT_MS = 120_000;
/** No command may wait for a credential or a choice: there is nobody to answer. */
const NO_PROMPT_ENV = { GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", NO_PROMPT: "1", GLAB_NO_PROMPT: "1" };

/** The forge of an origin URL (`https://host/...`, `git@host:...`, `ssh://git@host/...`); null for any other. */
export function forgeOf(url: string): Forge | null {
  const host = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?([^/:]+)/i.exec(url.trim())?.[1]?.toLowerCase() ?? "";
  if (host.includes("github")) return "github";
  if (host.includes("gitlab")) return "gitlab";
  return null;
}

/** A failed step: why, in one line. */
class RemoteError extends Error {}

async function run(exec: Exec, cwd: string, argv: string[]): Promise<string> {
  const result = await exec(argv, { cwd, env: NO_PROMPT_ENV, timeoutMs: COMMAND_TIMEOUT_MS, maxStdoutChars: 100_000 });
  if (result.exitCode === 0) return result.stdout;
  const how = result.timedOut ? "timed out" : result.exitCode === null ? "could not run" : `exited ${result.exitCode}`;
  throw new RemoteError(`${argv.slice(0, 2).join(" ")} ${how}: ${oneLine(outputTail(result.output)) || "no output"}`);
}

/** Appends a `remote` event; a wave removed meanwhile (or any write error) is only logged. */
async function record(wave: RemoteWave, fields: Partial<WaveRemote>): Promise<WaveRemote> {
  const remote = { ...(wave.remote ?? { number: null, url: null, pushed: null, error: null }), ...fields };
  try {
    await appendWaveEvent(wave.id, { kind: "remote", ...fields });
  } catch (error) {
    console.error(`wave ${wave.id.slice(0, 8)}: the remote event was not recorded: ${errorText(error)}`);
  }
  return remote;
}

/** Runs one step; its failure is recorded as the event's `error`. Returns what the log knows of the forge now. */
async function step(wave: RemoteWave, act: () => Promise<Partial<WaveRemote>>): Promise<WaveRemote | null> {
  if (wave.overrides.remote !== true) return wave.remote;
  let fields: Partial<WaveRemote>;
  try {
    fields = { ...(await act()), error: null };
  } catch (error) {
    fields = { error: error instanceof RemoteError ? error.message : oneLine(errorText(error)) };
  }
  return record(wave, fields);
}

async function originUrl(exec: Exec, repo: string): Promise<string> {
  const result = await exec(["git", "config", "--get", "remote.origin.url"], { cwd: repo, maxStdoutChars: 10_000 });
  const url = result.stdout.trim();
  if (result.exitCode !== 0 || url === "") throw new RemoteError("the repository has no origin remote");
  return url;
}

/** Pushes the wave's branch (force-with-lease: it was rebased); the branch's commit. */
async function pushBranch(exec: Exec, wave: RemoteWave): Promise<string> {
  await originUrl(exec, wave.repo);
  const head = (await run(exec, wave.repo, ["git", "rev-parse", "--verify", `refs/heads/${wave.branch}^{commit}`])).trim();
  await run(exec, wave.repo, ["git", "push", "--force-with-lease", "origin", `refs/heads/${wave.branch}:refs/heads/${wave.branch}`]);
  return head;
}

/** The request's URL and number from the CLI's output: its last URL, the number its path ends with. */
function requestOf(output: string): { url: string; number: number | null } {
  const url = output.match(/https?:\/\/\S+/g)?.at(-1);
  if (url === undefined) throw new RemoteError(`the request was opened but its URL is not in the output: ${oneLine(output) || "no output"}`);
  const number = /\/(?:pull|merge_requests)\/(\d+)/.exec(url)?.[1];
  return { url, number: number === undefined ? null : Number(number) };
}

function requestBody(wave: RemoteWave): string {
  return `${wave.request}\n\n---\nWave \`${wave.tag}\` of the agent factory: the factory reviews and merges it, this request only shows it.\n`;
}

async function openRequest(exec: Exec, wave: RemoteWave, forge: Forge): Promise<{ url: string; number: number | null }> {
  const title = wave.title;
  const argv =
    forge === "github"
      ? ["gh", "pr", "create", "--base", wave.target, "--head", wave.branch, "--title", title, "--body", requestBody(wave)]
      : ["glab", "mr", "create", "--source-branch", wave.branch, "--target-branch", wave.target, "--title", title, "--description", requestBody(wave), "--yes"];
  return requestOf(await run(exec, wave.repo, argv));
}

/**
 * After the review's rebase: the branch pushed, the request opened unless the log holds one. Returns
 * what the log knows of the forge now (the same `remote` when the setting is off).
 */
export async function publishWave(wave: RemoteWave, exec: Exec = runCommand): Promise<WaveRemote | null> {
  if (wave.overrides.remote !== true) return wave.remote;
  const pushed = await step(wave, async () => ({ pushed: await pushBranch(exec, wave) }));
  if (pushed?.error !== null) return pushed;
  const now = { ...wave, remote: pushed };
  if (pushed.url !== null || pushed.number !== null) return pushed;
  return step(now, async () => {
    const url = await originUrl(exec, wave.repo);
    const forge = forgeOf(url);
    if (forge === null) throw new RemoteError(`unsupported: the origin ${url} is neither GitHub nor GitLab, no request opened`);
    return openRequest(exec, wave, forge);
  });
}

/** The comment of a review: its verdict, then one line per finding. */
export function reviewComment(review: Pick<WaveReview, "round" | "verdict" | "status" | "findings">): string {
  const head = `**Factory review, round ${review.round}: ${review.verdict}**${review.verdict === "failed" ? ` (${review.status})` : ""}`;
  if (review.findings.length === 0) return `${head}\n\nNo findings.\n`;
  const lines = review.findings.map((finding) => `- **${finding.severity}** \`${finding.file}${finding.line === null ? "" : `:${finding.line}`}\`: ${finding.text}`);
  return `${head}\n\n${lines.join("\n")}\n`;
}

/** After a review's verdict is recorded: the verdict as a comment on the request. Nothing without a request. */
export async function commentReview(wave: RemoteWave, review: Pick<WaveReview, "round" | "verdict" | "status" | "findings">, exec: Exec = runCommand): Promise<WaveRemote | null> {
  if (wave.overrides.remote !== true || wave.remote === null || (wave.remote.number === null && wave.remote.url === null)) return wave.remote;
  const request = String(wave.remote.number ?? wave.remote.url);
  return step(wave, async () => {
    const forge = forgeOf(await originUrl(exec, wave.repo));
    if (forge === null) throw new RemoteError("unsupported: the origin is neither GitHub nor GitLab, no comment posted");
    const body = reviewComment(review);
    await run(exec, wave.repo, forge === "github" ? ["gh", "pr", "comment", request, "--body", body] : ["glab", "mr", "note", request, "--message", body]);
    return {};
  });
}

/** What the log says between a merge and its push: the push is pending (cleared by `publishMerge`'s event). */
export const MERGE_PUSH_PENDING = "the merge is not pushed yet (pending)";

/** The `remote` event the merge records with its stage change, before `publishMerge` runs; none when `remote` is off. */
export function mergePending(wave: Pick<RemoteWave, "overrides">): NewWaveEvent[] {
  return wave.overrides.remote === true ? [{ kind: "remote", error: MERGE_PUSH_PENDING }] : [];
}

/** After the fast-forward: the branch and the target pushed; `pushed` is the target's new commit. */
export async function publishMerge(wave: RemoteWave, exec: Exec = runCommand): Promise<WaveRemote | null> {
  return step(wave, async () => {
    await pushBranch(exec, wave);
    await run(exec, wave.repo, ["git", "push", "origin", `refs/heads/${wave.target}:refs/heads/${wave.target}`]);
    return { pushed: (await run(exec, wave.repo, ["git", "rev-parse", "--verify", `refs/heads/${wave.target}^{commit}`])).trim() };
  });
}
