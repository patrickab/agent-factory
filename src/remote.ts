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
 * - `landOnForge`, a `squash` wave's landing in place of `publishMerge`: the branch pushed, merged on the forge with
 *   squash and branch deletion, its commit (`merged`) fetched and checked to carry the gated tree. Origin's target not
 *   the local one, no request, no supported forge, or a refusal with the request still open: the wave lands locally and
 *   `publishTarget` pushes the target, the reason in its event. Never a second landing: origin's target that already is
 *   this wave's landing (parent the local target, the gated tree) is taken as it is
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
export type RemoteWave = Pick<WaveDeclaration, "id" | "repo" | "title" | "request" | "tag" | "target" | "overrides"> & { branch: string; remote: WaveRemote | null };

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

/** How a `squash` wave lands with `remote` on (`landOnForge`). */
export type ForgeLanding =
  /** The forge's squash commit, fetched, with the gated tree: the local target moves to it. */
  | { kind: "forge"; commit: string }
  /** Nothing merged on the forge: the wave lands locally, then `publishTarget` pushes the target with `reason`. */
  | { kind: "local"; reason: string }
  /** Nothing moves locally: the wave blocks (`infra`) with `error`. */
  | { kind: "blocked"; error: string };

/** The block of a forge merge whose commit is not here (yet): `waves.retry` fetches again. */
export const FORGE_BEHIND = "merged on the forge, the local target is behind";

function failure(error: unknown): string {
  return error instanceof RemoteError ? error.message : oneLine(errorText(error));
}

/** Origin's target commit (`git ls-remote`), null when origin has no such branch. */
async function originTip(exec: Exec, wave: RemoteWave): Promise<string | null> {
  const out = await run(exec, wave.repo, ["git", "ls-remote", "origin", `refs/heads/${wave.target}`]);
  return out.trim().split(/\s+/)[0] || null;
}

async function treeOf(exec: Exec, wave: RemoteWave, commit: string): Promise<string> {
  return (await run(exec, wave.repo, ["git", "rev-parse", "--verify", `${commit}^{tree}`])).trim();
}

/** Origin's target fetched; `commit` must be here then. */
async function fetchTarget(exec: Exec, wave: RemoteWave, commit: string): Promise<void> {
  await run(exec, wave.repo, ["git", "fetch", "--quiet", "--no-tags", "origin", `refs/heads/${wave.target}`]);
  await run(exec, wave.repo, ["git", "rev-parse", "--verify", "--quiet", `${commit}^{commit}`]);
}

/** The request's state as the forge reports it (`open`, `merged`, `closed`, ...) and its commit on the target when merged. */
async function requestState(exec: Exec, wave: RemoteWave, forge: Forge, request: string): Promise<{ state: string; commit: string | null }> {
  const argv = forge === "github" ? ["gh", "pr", "view", request, "--json", "state,mergeCommit"] : ["glab", "mr", "view", request, "--output", "json"];
  const data = JSON.parse(await run(exec, wave.repo, argv)) as Record<string, unknown>;
  const state = String(data.state ?? "unknown").toLowerCase();
  const sha = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
  const commit = forge === "github" ? sha((data.mergeCommit as { oid?: unknown } | null | undefined)?.oid) : (sha(data.merge_commit_sha) ?? sha(data.squash_commit_sha));
  return { state: state === "opened" ? "open" : state, commit };
}

/**
 * The forge's commit `merged` fetched and checked: its tree must be `head`'s (the gated tree). A failed fetch blocks
 * with `FORGE_BEHIND` (`waves.retry` runs this again), another tree blocks too; each recorded in a `remote` event.
 */
export async function fetchForgeLanding(wave: RemoteWave, merged: string, head: string, exec: Exec = runCommand): Promise<ForgeLanding> {
  try {
    await fetchTarget(exec, wave, merged);
  } catch (error) {
    const text = `${FORGE_BEHIND}: ${failure(error)}`;
    await record(wave, { error: text });
    return { kind: "blocked", error: `${text}; waves.retry fetches it again` };
  }
  const [tree, gated] = await Promise.all([treeOf(exec, wave, merged), treeOf(exec, wave, head)]).catch((error: unknown) => [failure(error), null]);
  if (tree === gated) return { kind: "forge", commit: merged };
  const text = `the forge's commit ${merged.slice(0, 12)} has not the gated tree${gated === null ? `: ${tree}` : ""}; nothing moved locally`;
  await record(wave, { error: text });
  return { kind: "blocked", error: text };
}

/**
 * A `squash` wave with `remote` on, in place of the local move: `head` the gated tip, `target` the local target it sits
 * on, `message` the squash's (subject, blank line, body). Merges on the forge only when origin's target is `target`
 * and a request is known; see `ForgeLanding`. Records `merged` before the fetch, so a retry resumes there.
 */
export async function landOnForge(wave: RemoteWave, landing: { head: string; target: string; message: string }, exec: Exec = runCommand): Promise<ForgeLanding> {
  const { head, target, message } = landing;
  const local = (reason: string): ForgeLanding => ({ kind: "local", reason });
  let forge: Forge | null;
  let origin: string | null;
  try {
    forge = forgeOf(await originUrl(exec, wave.repo));
    origin = await originTip(exec, wave);
  } catch (error) {
    return local(failure(error));
  }
  if (origin !== target) {
    // An earlier run's forge landing whose record was lost: origin's target on the local one with the gated tree.
    if (origin !== null) {
      const earlier = await fetchTarget(exec, wave, origin)
        .then(async () => (await run(exec, wave.repo, ["git", "rev-parse", "--verify", `${origin}^`])).trim() === target && (await treeOf(exec, wave, origin)) === (await treeOf(exec, wave, head)))
        .catch(() => false);
      if (earlier) {
        await record(wave, { merged: origin, error: null });
        return { kind: "forge", commit: origin };
      }
    }
    return local(`${wave.target} on origin is ${origin === null ? "missing" : origin.slice(0, 12)}, not the local ${target.slice(0, 12)}`);
  }
  if (forge === null) return local("unsupported: the origin is neither GitHub nor GitLab");
  const request = wave.remote?.number ?? wave.remote?.url ?? null;
  if (request === null) return local("no request is known");
  try {
    await pushBranch(exec, wave);
  } catch (error) {
    return local(failure(error));
  }
  const [subject = "", ...rest] = message.split("\n");
  const body = rest.join("\n").replace(/^\n+/, "");
  const argv =
    forge === "github"
      ? ["gh", "pr", "merge", String(request), "--squash", "--delete-branch", "--subject", subject, "--body", body]
      : ["glab", "mr", "merge", String(request), "--squash", "--remove-source-branch", "--yes", "--squash-message", message];
  let refused: string | null = null;
  try {
    await run(exec, wave.repo, argv);
  } catch (error) {
    refused = failure(error);
  }
  const state = await requestState(exec, wave, forge, String(request)).catch((error: unknown) => ({ state: "unknown", commit: null, error: failure(error) }));
  if (state.state !== "merged") {
    if (refused === null) {
      // The merge said yes, the request does not say merged: nothing may land a second time, nothing is known to fetch.
      const text = `${FORGE_BEHIND}: the request is ${state.state}${"error" in state ? ` (${state.error})` : ""}`;
      await record(wave, { error: text });
      return { kind: "blocked", error: text };
    }
    if (state.state === "open") return local(`the forge refused the merge: ${refused}`);
    const text = `the forge refused the merge (${refused}) and the request is ${state.state}: nothing moved`;
    await record(wave, { error: text });
    return { kind: "blocked", error: text };
  }
  const merged = state.commit ?? (await originTip(exec, wave).catch(() => null));
  if (merged === null || merged === target) {
    const text = `${FORGE_BEHIND}: its commit is not known`;
    await record(wave, { error: text });
    return { kind: "blocked", error: text };
  }
  await record(wave, { merged, error: null });
  return fetchForgeLanding(wave, merged, head, exec);
}

/**
 * After a `squash` wave landed locally with `remote` on: the target pushed (the branch is gone); `reason`, why the forge
 * did not merge it, stays in the event's `error`.
 */
export async function publishTarget(wave: RemoteWave, reason: string | null, exec: Exec = runCommand): Promise<WaveRemote | null> {
  if (wave.overrides.remote !== true) return wave.remote;
  const landed = reason === null ? null : `landed locally: ${reason}`;
  let fields: Partial<WaveRemote>;
  try {
    await originUrl(exec, wave.repo);
    await run(exec, wave.repo, ["git", "push", "origin", `refs/heads/${wave.target}:refs/heads/${wave.target}`]);
    fields = { pushed: (await run(exec, wave.repo, ["git", "rev-parse", "--verify", `refs/heads/${wave.target}^{commit}`])).trim(), error: landed };
  } catch (error) {
    fields = { error: landed === null ? failure(error) : `${landed}; ${failure(error)}` };
  }
  return record(wave, fields);
}
