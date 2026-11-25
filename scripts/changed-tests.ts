#!/usr/bin/env bun
/**
 * A wave's task gate (`task_gates` in `factory.yaml`): runs the test files a change since `$FACTORY_BASE` reaches.
 *
 * - Changed: `git diff --name-only $FACTORY_BASE` (committed and uncommitted) and untracked files
 * - Reached: a changed `*.test.ts`, the test next to a changed source (`x.ts` -> `x.test.ts`), and every test that
 *   imports a changed file, transitively over relative imports (`./`, `../`)
 * - Runs them with `bun test`, exits with its code. Nothing reached: exit 0. `FACTORY_BASE` unset: exit 75 (infra)
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const INFRA_EXIT = 75;
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

if (import.meta.main) {
  const base = process.env.FACTORY_BASE;
  if (!base) {
    console.log("changed-tests: FACTORY_BASE is not set (the commit the change starts from)");
    process.exit(INFRA_EXIT);
  }
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"])[0].trim();
  const tests = changedTests(root, base);
  if (tests.length === 0) {
    console.log(`changed-tests: the change since ${base.slice(0, 12)} reaches no test`);
    process.exit(0);
  }
  console.log(`changed-tests: ${tests.length} test file(s): ${tests.join(" ")}`);
  // The tests run without FACTORY_BASE: it is this gate's input, and tests that check a command's environment would see it.
  const { FACTORY_BASE: _base, ...env } = process.env;
  const run = Bun.spawnSync(["bun", "test", ...tests.map((path) => `./${path}`)], { cwd: root, env, stdout: "inherit", stderr: "inherit" });
  process.exit(run.exitCode ?? 1);
}
