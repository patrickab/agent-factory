/**
 * Additions-only merge: a wave's rebase onto its target that conflicts only where both sides added lines at one place.
 *
 * - `replayAdditions` replays the commits of `head` since the target onto the target's tip, one at a time with
 *   plumbing (`git merge-tree --write-tree`, author and message kept, no ref written): a dry run. A commit whose merge
 *   conflicts is resolved when every conflicting file is a content conflict (`CONFLICT (contents)`, also a file added
 *   on both sides) and every hunk of it (`git merge-file --diff3`, own markers) has an empty base: both sides only added
 *   lines, neither changed nor removed one. Each such hunk becomes ours (the target's lines) then theirs (the wave's),
 *   both whole; a hunk whose two sides are identical is kept once. Anything else (a changed or removed base line,
 *   modify/delete, rename, binary, mode, a merge commit) is refused with why
 * - `resolveAdditions` moves the checked-out branch of a clean worktree to that replay (`git reset --keep`)
 * - Never git's `union` driver: it keeps both versions of changed lines
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./git.ts";
import type { Exec } from "./run.ts";

/** The replayed head and the files whose additions were resolved, or why the conflict is not additions-only. */
export type AdditionsReplay = { head: string; files: string[] } | { refused: string };

const MAX_OUTPUT = 16_000_000;
/** The markers of `merge-file` here: longer than git's, labelled, so a line of the file is hardly ever one of them. */
const MARKER_SIZE = 41;
const OURS = `${"<".repeat(MARKER_SIZE)} ours`;
const BASE = `${"|".repeat(MARKER_SIZE)} base`;
const SPLIT = "=".repeat(MARKER_SIZE);
const THEIRS = `${">".repeat(MARKER_SIZE)} theirs`;
/** `merge-tree` message types that a resolvable conflict may carry. */
const RESOLVABLE_MESSAGES = new Set(["Auto-merging", "CONFLICT (contents)"]);
const REGULAR_MODES = new Set(["100644", "100755"]);

type Stage = { mode: string; oid: string };
type Conflicted = { path: string; stages: Map<number, Stage> };

/** `git merge-tree --write-tree -z` of `theirs` onto `ours` from `base`: the tree, the conflicted stages, the message types. */
async function mergeTree(exec: Exec, cwd: string, base: string, ours: string, theirs: string): Promise<{ tree: string; conflicted: Conflicted[]; messages: string[] }> {
  const result = await exec(["git", "merge-tree", "--write-tree", "-z", `--merge-base=${base}`, ours, theirs], { cwd, maxStdoutChars: MAX_OUTPUT });
  if (result.killed || (result.exitCode !== 0 && result.exitCode !== 1) || result.stdoutTruncated) throw new Error(`git merge-tree: ${result.output.trim()}`);
  const fields = result.stdout.split("\0");
  const tree = fields[0] ?? "";
  if (result.exitCode === 0) return { tree, conflicted: [], messages: [] };
  const conflicted = new Map<string, Conflicted>();
  let index = 1;
  // Conflicted file info, `<mode> <object> <stage>\t<path>`, ends with an empty field.
  for (; index < fields.length && fields[index] !== ""; index++) {
    const match = /^(\d+) ([0-9a-f]+) (\d)\t(.*)$/s.exec(fields[index]);
    if (!match) throw new Error(`git merge-tree: unexpected line ${JSON.stringify(fields[index])}`);
    const [, mode, oid, stage, path] = match;
    const entry = conflicted.get(path) ?? { path, stages: new Map() };
    entry.stages.set(Number(stage), { mode, oid });
    conflicted.set(path, entry);
  }
  // Informational messages: `<count>`, the paths, the type, the message.
  const messages: string[] = [];
  for (index++; index < fields.length && fields[index] !== ""; ) {
    const count = Number(fields[index]);
    if (!Number.isInteger(count) || count < 0) throw new Error(`git merge-tree: unexpected message field ${JSON.stringify(fields[index])}`);
    index += 1 + count;
    messages.push(fields[index] ?? "");
    index += 2;
  }
  return { tree, conflicted: [...conflicted.values()], messages };
}

/** The lines of `text`, each with its line end. */
function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** A line without its line end. */
function bare(line: string): string {
  return line.replace(/\r?\n$/, "");
}

/** Ours then theirs, both whole (a common start or end is no duplicate: two functions both end in `}`); identical sides once. */
function bothAdded(ours: string[], theirs: string[]): string[] {
  if (ours.length === theirs.length && ours.every((line, index) => line === theirs[index])) return ours;
  return [...ours, ...theirs];
}

/**
 * The `merge-file --diff3` output resolved: each hunk with an empty base becomes ours then theirs. Null when a hunk
 * has base lines (one side changed or removed one) or the markers do not add up to `conflicts`.
 */
export function resolveHunks(merged: string, conflicts: number): string | null {
  const out: string[] = [];
  let ours: string[] = [];
  let base: string[] = [];
  let theirs: string[] = [];
  let state: "text" | "ours" | "base" | "theirs" = "text";
  let seen = 0;
  for (const line of lines(merged)) {
    const marker = bare(line);
    if (state === "text" && marker === OURS) {
      state = "ours";
      ours = [];
      base = [];
      theirs = [];
    } else if (state === "ours" && marker === BASE) state = "base";
    else if (state === "base" && marker === SPLIT) state = "theirs";
    else if (state === "theirs" && marker === THEIRS) {
      if (base.length > 0) return null;
      out.push(...bothAdded(ours, theirs));
      state = "text";
      seen++;
    } else if (state === "text") out.push(line);
    else if (state === "ours") ours.push(line);
    else if (state === "base") base.push(line);
    else theirs.push(line);
  }
  if (state !== "text" || seen !== conflicts || seen === 0) return null;
  return out.join("");
}

/** The resolved blob of one conflicted file, or why it is not additions-only. */
async function resolveFile(exec: Exec, cwd: string, file: Conflicted, emptyBlob: string, scratch: string): Promise<{ mode: string; oid: string } | { refused: string }> {
  const ours = file.stages.get(2);
  const theirs = file.stages.get(3);
  const base = file.stages.get(1);
  if (ours === undefined || theirs === undefined) return { refused: `${file.path} is removed on one side` };
  if (!REGULAR_MODES.has(ours.mode) || ours.mode !== theirs.mode || (base !== undefined && base.mode !== ours.mode)) return { refused: `${file.path} changes its mode or is no regular file` };
  const argv = ["git", "merge-file", "-p", "--diff3", `--marker-size=${MARKER_SIZE}`, "-L", "ours", "-L", "base", "-L", "theirs", "--object-id", ours.oid, base?.oid ?? emptyBlob, theirs.oid];
  const result = await exec(argv, { cwd, maxStdoutChars: MAX_OUTPUT });
  if (result.killed || result.stdoutTruncated || result.exitCode === null || result.exitCode < 1 || result.exitCode > 127) return { refused: `${file.path} cannot be merged as text` };
  const resolved = resolveHunks(result.stdout, result.exitCode);
  if (resolved === null) return { refused: `${file.path} has a hunk that changes or removes a line of the base` };
  const path = join(scratch, "blob");
  await writeFile(path, resolved);
  return { mode: ours.mode, oid: await git(exec, cwd, ["hash-object", "-w", "--no-filters", path]) };
}

/**
 * `head`'s commits since `onto` replayed onto `onto`, every conflict resolved as additions, author and message kept.
 * Writes objects, no ref.
 */
export async function replayAdditions(exec: Exec, cwd: string, head: string, onto: string): Promise<AdditionsReplay> {
  const tip = await git(exec, cwd, ["rev-parse", "--verify", `${onto}^{commit}`]);
  const base = await git(exec, cwd, ["merge-base", head, tip]);
  if ((await git(exec, cwd, ["rev-list", "--min-parents=2", `${base}..${head}`])) !== "") return { refused: "the branch holds a merge commit" };
  const scratch = await mkdtemp(join(tmpdir(), "factory-additions-"));
  try {
    const emptyBlob = await git(exec, cwd, ["hash-object", "-w", "/dev/null"]);
    const files = new Set<string>();
    let parent = tip;
    for (const commit of (await git(exec, cwd, ["rev-list", "--reverse", `${base}..${head}`])).split("\n").filter(Boolean)) {
      const merged = await mergeTree(exec, cwd, `${commit}^`, parent, commit);
      let tree = merged.tree;
      if (merged.conflicted.length > 0) {
        const other = merged.messages.find((type) => !RESOLVABLE_MESSAGES.has(type));
        if (other !== undefined) return { refused: `${commit.slice(0, 8)}: ${other}` };
        const env = { GIT_INDEX_FILE: join(scratch, "index") };
        await git(exec, cwd, ["read-tree", tree], env);
        for (const file of merged.conflicted) {
          const resolved = await resolveFile(exec, cwd, file, emptyBlob, scratch);
          if ("refused" in resolved) return { refused: `${commit.slice(0, 8)}: ${resolved.refused}` };
          await git(exec, cwd, ["update-index", "--cacheinfo", `${resolved.mode},${resolved.oid},${file.path}`], env);
          files.add(file.path);
        }
        tree = await git(exec, cwd, ["write-tree"], env);
      }
      const [name = "", email = "", date = "", ...message] = (await git(exec, cwd, ["show", "-s", "--format=%an%n%ae%n%ad%n%B", "--date=raw", commit])).split("\n");
      const env = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date };
      parent = await git(exec, cwd, ["commit-tree", "--no-gpg-sign", tree, "-p", parent, "-m", message.join("\n")], env);
    }
    return { head: parent, files: [...files].sort() };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * The branch checked out in the clean worktree `root` replayed onto the tip of `target` with its additions-only
 * conflicts resolved: the branch is moved there (`git reset --keep`). The tip it sits on and the files resolved, or
 * why it stays as it is.
 */
export async function resolveAdditions(exec: Exec, root: string, target: string): Promise<{ onto: string; files: string[] } | { refused: string }> {
  const head = await git(exec, root, ["rev-parse", "HEAD"]);
  const onto = await git(exec, root, ["rev-parse", "--verify", `refs/heads/${target}^{commit}`]);
  const replay = await replayAdditions(exec, root, head, onto);
  if ("refused" in replay) return replay;
  await git(exec, root, ["reset", "--quiet", "--keep", replay.head]);
  return { onto, files: replay.files };
}
