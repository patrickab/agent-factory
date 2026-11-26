#!/usr/bin/env bun
/**
 * The test gate (`task_gates` and `merge_gates` in `factory.yaml`): runs the test files a change reaches, several at once.
 *
 * - The change starts at `$FACTORY_BASE` (a wave's task), else at the merge base with the default branch (a merge gate, a
 *   local run); `--all`, or no base at all, runs every test file
 * - Changed: `git diff --name-only $FACTORY_BASE` (committed and uncommitted) and untracked files
 * - Reached: a changed `*.test.ts`, the test next to a changed source (`x.ts` -> `x.test.ts`), and every test that
 *   imports a changed file, transitively over relative imports (`./`, `../`)
 * - Runs them one `bun test` process per file, the cores but two at once (`FACTORY_TEST_JOBS` overrides), at low priority.
 *   A failed file runs once more alone and passes as flaky when it passes then. Nothing reached: exit 0
 * - Every file it reran is named in the gate helper's trailer, its output's last line (`gateMarks`): a flaky one is
 *   recorded `flaky`, and the helper does not run the whole step again
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { rerunsTrailer } from "../src/flaky-rerun.ts";

const SOURCE = /\.(ts|tsx|mts|js|mjs)$/;
const TEST = /\.test\.(ts|tsx|mts|js|mjs)$/;
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;

/** The repo-relative paths `content` (the file at `path`) imports relatively, resolved against `exists`. */
export function relativeImports(path: string, content: string, exists: (path: string) => boolean): string[] {
  const found: string[] = [];
  for (const match of content.matchAll(IMPORT)) {
    const raw = normalize(join(dirname(path), match[1]));
    const candidates = SOURCE.test(raw) ? [raw] : [`${raw}.ts`, `${raw}.tsx`, join(raw, "index.ts"), raw];
    // A file the change deleted still names its importers: the first candidate stands for it.
    found.push(candidates.find(exists) ?? candidates[0]);
  }
  return found;
}

/**
 * The test files `changed` reaches among `sources` (repo-relative path -> content, every source file of the tree),
 * sorted. Only tests that exist in `sources` are returned.
 */
export function reachedTests(changed: string[], sources: Map<string, string>): string[] {
  const exists = (path: string) => sources.has(path);
  const importers = new Map<string, string[]>();
  for (const [path, content] of sources) {
    for (const target of relativeImports(path, content, exists)) {
      const list = importers.get(target) ?? [];
      list.push(path);
      importers.set(target, list);
    }
  }
  const reached = new Set<string>();
  const queue = [...changed.map(normalize)];
  while (queue.length > 0) {
    const path = queue.pop()!;
    if (reached.has(path)) continue;
    reached.add(path);
    queue.push(...(importers.get(path) ?? []));
  }
  const tests = new Set<string>();
  for (const path of reached) {
    if (TEST.test(path)) tests.add(path);
    else if (SOURCE.test(path)) tests.add(path.replace(SOURCE, ".test.$1"));
  }
  return [...tests].filter(exists).sort();
}

function git(root: string, args: string[]): string[] {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().split("\0").filter((path) => path !== "");
}

/** The test files the change since `base` reaches in the checkout at `root`. A rename counts as both its paths. */
export function changedTests(root: string, base: string): string[] {
  const untracked = git(root, ["ls-files", "-z", "--others", "--exclude-standard"]);
  const changed = [...git(root, ["diff", "--name-only", "--no-renames", "-z", base]), ...untracked];
  const sources = new Map<string, string>();
  for (const path of [...git(root, ["ls-files", "-z"]), ...untracked]) {
    if (SOURCE.test(path) && existsSync(join(root, path))) sources.set(path, readFileSync(join(root, path), "utf8"));
  }
  return reachedTests(changed, sources);
}

/** The commit a merge gate's change starts from: the merge base with the default branch (origin's HEAD, `main`, `master`), null when none resolves. */
export function defaultBase(root: string): string | null {
  for (const ref of ["origin/HEAD", "main", "master"]) {
    const result = Bun.spawnSync(["git", "merge-base", "HEAD", ref], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode === 0) return result.stdout.toString().trim();
  }
  return null;
}

/** Every test file of the checkout at `root`. */
export function allTests(root: string): string[] {
  return [...git(root, ["ls-files", "-z"]), ...git(root, ["ls-files", "-z", "--others", "--exclude-standard"])].filter((path) => TEST.test(path) && existsSync(join(root, path))).sort();
}

/** How many test files run at once: `FACTORY_TEST_JOBS`, else the cores but two (the machine stays usable), at least one. */
export function jobCount(env: Record<string, string | undefined>, cores: number): number {
  const asked = Number(env.FACTORY_TEST_JOBS);
  return Number.isInteger(asked) && asked > 0 ? asked : Math.max(1, cores - 2);
}

export interface FileResult { file: string; passed: boolean; output: string; seconds: number }

/**
 * Runs `files`, one `bun test` process per file, `jobs` at once and at low priority, the larger files first.
 * A file that fails is run once more alone after the others: passing then, it passes and is named flaky (a test that
 * only fails beside others is a timing problem, not a broken change).
 */
export async function runFiles(root: string, files: string[], jobs: number, env: Record<string, string | undefined>): Promise<{ results: FileResult[]; flaky: string[] }> {
  const size = (file: string) => readFileSync(join(root, file)).length;
  const queue = [...files].sort((a, b) => size(b) - size(a));
  const children = new Set<ReturnType<typeof Bun.spawn>>();
  const stop = () => { for (const child of children) child.kill(); process.exit(130); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const runOne = async (file: string): Promise<FileResult> => {
    const started = Date.now();
    const child = Bun.spawn(["nice", "-n", "10", "bun", "test", `./${file}`], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    children.add(child);
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    children.delete(child);
    return { file, passed: code === 0, output: out + err, seconds: (Date.now() - started) / 1000 };
  };
  const results: FileResult[] = [];
  const worker = async () => {
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) results.push(await runOne(file));
  };
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, worker));
  const flaky: string[] = [];
  for (const failed of results.filter((result) => !result.passed)) {
    const again = await runOne(failed.file);
    if (!again.passed) continue;
    flaky.push(failed.file);
    Object.assign(failed, again);
  }
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  return { results: results.sort((a, b) => a.file.localeCompare(b.file)), flaky };
}

/** The gate helper's trailer (`innerReruns`): the files that passed only alone (`flaky`) and those that failed alone too (`reran`); null when none reran. */
export function gateMarks(results: readonly FileResult[], flaky: readonly string[]): string | null {
  return rerunsTrailer(flaky, results.filter((result) => !result.passed).map((result) => result.file));
}

if (import.meta.main) {
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"])[0].trim();
  const everything = process.argv.includes("--all");
  const base = everything ? null : process.env.FACTORY_BASE || defaultBase(root);
  // No base (no default branch to compare with): everything runs, the safe side.
  const tests = base ? changedTests(root, base) : allTests(root);
  if (tests.length === 0) {
    console.log(`changed-tests: the change since ${base?.slice(0, 12)} reaches no test`);
    process.exit(0);
  }
  const jobs = jobCount(process.env, navigator.hardwareConcurrency);
  console.log(`changed-tests: ${tests.length} test file(s)${base ? ` reached since ${base.slice(0, 12)}` : " (all)"}, ${jobs} at once`);
  // The tests run without FACTORY_BASE: it is this gate's input, and tests that check a command's environment would see it.
  const { FACTORY_BASE: _base, ...env } = process.env;
  const started = Date.now();
  const { results, flaky } = await runFiles(root, tests, jobs, env);
  const failed = results.filter((result) => !result.passed);
  for (const result of failed) console.log(`\n== ${result.file}: failed\n${result.output.trimEnd()}`);
  for (const result of results.filter((entry) => entry.passed)) console.log(`ok ${result.file} ${result.seconds.toFixed(1)}s${flaky.includes(result.file) ? " (flaky: failed beside the others, passed alone)" : ""}`);
  console.log(`changed-tests: ${results.length - failed.length} passed, ${failed.length} failed in ${((Date.now() - started) / 1000).toFixed(0)}s${failed.length > 0 ? `: ${failed.map((result) => result.file).join(" ")}` : ""}`);
  // The last line: the gate helper reads its trailer there only.
  const trailer = gateMarks(results, flaky);
  if (trailer !== null) console.log(trailer);
  process.exit(failed.length === 0 ? 0 : 1);
}
