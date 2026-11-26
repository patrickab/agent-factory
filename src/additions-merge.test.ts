/**
 * The additions-only merge over real git repos in a temp dir: a wave branch and a target that both moved since the
 * branch was cut, replayed with `replayAdditions` / `resolveAdditions`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replayAdditions, resolveAdditions, resolveHunks } from "./additions-merge.ts";
import { runCommand } from "./run.ts";

const savedEnv = { ...process.env };
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "factory-additions-test-")));
let caseDir: string;
let caseCount = 0;

beforeEach(() => {
  caseDir = join(scratch, `case-${++caseCount}`);
  mkdirSync(caseDir);
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "test",
    GIT_COMMITTER_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_EMAIL: "test@example.com",
  });
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(cwd: string, files: Record<string, string>, message: string): string {
  for (const [file, text] of Object.entries(files)) writeFileSync(join(cwd, file), text);
  git(cwd, "add", "-A");
  git(cwd, "commit", "--quiet", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

const LIST = "import a\nimport b\n\nconst list = [\n  1,\n  2,\n];\n";

/** A repo on `main` holding `files`, the branch `wave` off it checked out in the worktree `work`. Returns both paths. */
function repoWith(files: Record<string, string>): { repo: string; work: string } {
  const repo = join(caseDir, "repo");
  mkdirSync(repo);
  git(repo, "init", "--quiet", "-b", "main");
  commit(repo, files, "init");
  const work = join(caseDir, "work");
  git(repo, "worktree", "add", "--quiet", "-b", "wave", work, "main");
  return { repo, work };
}

const show = (repo: string, rev: string, file: string) => `${git(repo, "show", `${rev}:${file}`)}\n`;

describe("resolveAdditions", () => {
  test("both sides add at one place: ours (the target's) then theirs, every commit kept with its author and message", async () => {
    const { repo, work } = repoWith({ "list.ts": LIST, "notes.md": "# Notes\n\n- one\n" });
    commit(work, { "list.ts": LIST.replace("  2,\n", "  2,\n  wave,\n") }, "feat: wave adds to the list");
    commit(work, { "notes.md": "# Notes\n\n- one\n- wave\n", "list.ts": LIST.replace("import b\n", "import b\nimport w\n").replace("  2,\n", "  2,\n  wave,\n") }, "feat: wave adds a note and an import");
    commit(repo, { "list.ts": LIST.replace("import b\n", "import b\nimport m\n").replace("  2,\n", "  2,\n  main,\n"), "notes.md": "# Notes\n\n- one\n- main\n" }, "main: adds");
    const resolved = await resolveAdditions(runCommand, work, "main");
    expect(resolved).toEqual({ onto: git(repo, "rev-parse", "main"), files: ["list.ts", "notes.md"] });
    expect(git(work, "log", "--format=%s", "wave")).toBe("feat: wave adds a note and an import\nfeat: wave adds to the list\nmain: adds\ninit");
    expect(show(repo, "wave", "list.ts")).toBe("import a\nimport b\nimport m\nimport w\n\nconst list = [\n  1,\n  2,\n  main,\n  wave,\n];\n");
    expect(show(repo, "wave", "notes.md")).toBe("# Notes\n\n- one\n- main\n- wave\n");
    // The first commit carries only its own addition on top of the target.
    expect(show(repo, "wave~1", "notes.md")).toBe("# Notes\n\n- one\n- main\n");
    expect(git(work, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(work, "list.ts"), "utf8")).toBe(show(repo, "wave", "list.ts"));
  });

  test("lines both sides added the same at a hunk's start or end are kept with each side: ours whole, then theirs whole", async () => {
    const { repo, work } = repoWith({ "list.ts": LIST });
    commit(work, { "list.ts": LIST.replace("  2,\n", "  2,\n  shared,\n  wave,\n  end,\n") }, "wave");
    commit(repo, { "list.ts": LIST.replace("  2,\n", "  2,\n  shared,\n  main,\n  end,\n") }, "main");
    expect(await resolveAdditions(runCommand, work, "main")).toEqual({ onto: git(repo, "rev-parse", "main"), files: ["list.ts"] });
    const merged = show(repo, "wave", "list.ts");
    expect(merged).toContain("  main,\n");
    expect(merged).toContain("  wave,\n");
    expect(merged.indexOf("  main,\n")).toBeLessThan(merged.indexOf("  wave,\n"));
    expect(merged.match(/ {2}end,\n/g)?.length).toBe(2);
  });

  test("two functions appended on both sides: both kept with their closing braces", async () => {
    const base = "export const x = 1;\n";
    const { repo, work } = repoWith({ "f.ts": base });
    const wave = "\nexport function wave() {\n  return 1;\n}\n";
    const main = "\nexport function main() {\n  return 2;\n}\n";
    commit(work, { "f.ts": base + wave }, "wave adds a function");
    commit(repo, { "f.ts": base + main }, "main adds a function");
    expect(await resolveAdditions(runCommand, work, "main")).toEqual({ onto: git(repo, "rev-parse", "main"), files: ["f.ts"] });
    expect(show(repo, "wave", "f.ts")).toBe(base + main + wave);
  });

  test("two fenced blocks appended on both sides: two blocks", async () => {
    const base = "# Doc\n";
    const { repo, work } = repoWith({ "doc.md": base });
    const wave = "\n```sh\nwave\n```\n";
    const main = "\n```sh\nmain\n```\n";
    commit(work, { "doc.md": base + wave }, "wave adds a block");
    commit(repo, { "doc.md": base + main }, "main adds a block");
    expect(await resolveAdditions(runCommand, work, "main")).toEqual({ onto: git(repo, "rev-parse", "main"), files: ["doc.md"] });
    expect(show(repo, "wave", "doc.md")).toBe(base + main + wave);
  });

  test("a file added on both sides: one file, ours whole then theirs whole", async () => {
    const { repo, work } = repoWith({ "a.txt": "a\n" });
    commit(work, { "new.md": "# New\n\nwave's line\n" }, "wave adds new.md");
    commit(repo, { "new.md": "# New\n\nmain's line\n" }, "main adds new.md");
    expect(await resolveAdditions(runCommand, work, "main")).toEqual({ onto: git(repo, "rev-parse", "main"), files: ["new.md"] });
    expect(show(repo, "wave", "new.md")).toBe("# New\n\nmain's line\n# New\n\nwave's line\n");
  });

  test("one side changes a base line: not resolved, the branch stays", async () => {
    const { repo, work } = repoWith({ "list.ts": LIST });
    const head = commit(work, { "list.ts": LIST.replace("  2,\n", "  2,\n  wave,\n") }, "wave");
    commit(repo, { "list.ts": LIST.replace("  2,\n", "  two,\n  main,\n") }, "main changes 2");
    const result = await resolveAdditions(runCommand, work, "main");
    expect(result).toEqual({ refused: expect.stringContaining("list.ts has a hunk that changes or removes a line of the base") });
    expect(git(work, "rev-parse", "HEAD")).toBe(head);
    expect(git(work, "status", "--porcelain")).toBe("");
  });

  test("one side removes a base line: not resolved", async () => {
    const { work, repo } = repoWith({ "list.ts": LIST });
    commit(work, { "list.ts": LIST.replace("  2,\n", "  2,\n  wave,\n") }, "wave");
    commit(repo, { "list.ts": LIST.replace("  2,\n", "") }, "main removes 2");
    expect(await resolveAdditions(runCommand, work, "main")).toEqual({ refused: expect.stringContaining("list.ts has a hunk") });
  });

  test("a file removed on one side and changed on the other: not resolved", async () => {
    const { work, repo } = repoWith({ "list.ts": LIST });
    commit(work, { "list.ts": LIST.replace("  2,\n", "  2,\n  wave,\n") }, "wave");
    git(repo, "rm", "--quiet", "list.ts");
    git(repo, "commit", "--quiet", "-m", "main removes it");
    expect("refused" in (await resolveAdditions(runCommand, work, "main"))).toBe(true);
  });

  test("a later commit that changes a line: not resolved, though the first one was additions", async () => {
    const { repo, work } = repoWith({ "list.ts": LIST });
    commit(work, { "list.ts": LIST.replace("  2,\n", "  2,\n  wave,\n") }, "wave adds");
    const head = commit(work, { "list.ts": LIST.replace("  2,\n", "  2,\n  wave,\n").replace("  1,\n", "  one,\n") }, "wave changes 1");
    commit(repo, { "list.ts": LIST.replace("  2,\n", "  2,\n  main,\n").replace("  1,\n", "  uno,\n") }, "main adds and changes 1");
    expect(await resolveAdditions(runCommand, work, "main")).toEqual({ refused: expect.stringMatching(/^[0-9a-f]{8}: list\.ts has a hunk/) });
    expect(git(work, "rev-parse", "HEAD")).toBe(head);
  });

  test("no conflict: the plain replay, no file resolved", async () => {
    const { repo, work } = repoWith({ "a.txt": "a\n" });
    commit(work, { "b.txt": "b\n" }, "wave");
    const main = commit(repo, { "c.txt": "c\n" }, "main");
    const replay = await replayAdditions(runCommand, work, "wave", "main");
    expect(replay).toEqual({ head: expect.any(String), files: [] });
    if ("head" in replay) expect(git(repo, "rev-parse", `${replay.head}^`)).toBe(main);
  });
});

describe("resolveHunks", () => {
  const m = (char: string, label = "") => `${char.repeat(41)}${label}`;
  const conflict = (ours: string, base: string, theirs: string) => `${m("<", " ours")}\n${ours}${m("|", " base")}\n${base}${m("=")}\n${theirs}${m(">", " theirs")}\n`;

  test("an empty base: ours then theirs", () => {
    expect(resolveHunks(`a\n${conflict("m\n", "", "w\n")}b\n`, 1)).toBe("a\nm\nw\nb\n");
  });

  test("a common start or end is kept with each side; identical sides once", () => {
    expect(resolveHunks(conflict("f() {\n}\n", "", "g() {\n}\n"), 1)).toBe("f() {\n}\ng() {\n}\n");
    expect(resolveHunks(conflict("x\n}\n", "", "x\n}\n"), 1)).toBe("x\n}\n");
  });

  test("a base line in a hunk, or markers that do not add up: null", () => {
    expect(resolveHunks(`a\n${conflict("m\n", "x\n", "w\n")}`, 1)).toBeNull();
    expect(resolveHunks(`a\n${conflict("m\n", "", "w\n")}`, 2)).toBeNull();
    expect(resolveHunks(`a\n${m("<", " ours")}\nm\n`, 1)).toBeNull();
  });

  test("git's own markers in the file are text", () => {
    expect(resolveHunks(`<<<<<<< HEAD\n${conflict("m\n", "", "w\n")}`, 1)).toBe("<<<<<<< HEAD\nm\nw\n");
  });
});
