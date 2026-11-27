import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { changedTests, reachedTests, runFiles } from "./changed-tests.ts";

/** A fixture tree: a chain a <- b <- c (c imports b imports a), each with its test, and an unrelated d. */
const TREE: Record<string, string> = {
  "src/a.ts": "export const a = 1;\n",
  "src/a.test.ts": 'import { a } from "./a.ts";\n',
  "src/b.ts": 'import { a } from "./a.ts";\nexport const b = a;\n',
  "src/b.test.ts": 'import { b } from "./b";\n',
  "src/lib/c.ts": 'import { b } from "../b.ts";\nexport const c = b;\n',
  "src/lib/c.test.ts": 'import { c } from "./c.ts";\n',
  "src/d.ts": 'import { x } from "external";\nexport const d = 1;\n',
  "src/d.test.ts": 'import { d } from "./d.ts";\n',
  "src/no-test.ts": "export const n = 1;\n",
  "src/uses-no-test.test.ts": 'const n = await import("./no-test.ts");\n',
};
const sources = new Map(Object.entries(TREE));

test("a changed source reaches its own test and every test importing it, transitively; a deleted one too", () => {
  const without = new Map(sources);
  without.delete("src/a.ts");
  const cases: [string[], Map<string, string>, string[]][] = [
    [["src/a.ts"], sources, ["src/a.test.ts", "src/b.test.ts", "src/lib/c.test.ts"]],
    [["src/a.ts"], without, ["src/a.test.ts", "src/b.test.ts", "src/lib/c.test.ts"]],
    [["src/d.test.ts"], sources, ["src/d.test.ts"]],
    [["src/no-test.ts"], sources, ["src/uses-no-test.test.ts"]],
    [["README.md", "src/gone.test.ts"], sources, []],
  ];
  for (const [changed, tree, reached] of cases) expect(reachedTests(changed, tree)).toEqual(reached);
});

describe("changedTests", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "factory-changed-tests-")));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const gitIn = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const commit = () => {
    gitIn("add", "-A");
    gitIn("-c", "user.name=Factory Test", "-c", "user.email=factory@test.invalid", "commit", "--quiet", "-m", "x");
    return gitIn("rev-parse", "HEAD");
  };

  test("reads the change since the base from git: committed, uncommitted and untracked", () => {
    gitIn("init", "--quiet", "--initial-branch", "main");
    for (const [path, text] of Object.entries(TREE)) write(path, text);
    const base = commit();
    expect(changedTests(root, base)).toEqual([]);

    write("src/lib/c.ts", 'import { b } from "../b.ts";\nexport const c = b + 1;\n');
    commit();
    expect(changedTests(root, base)).toEqual(["src/lib/c.test.ts"]);

    write("src/d.ts", "export const d = 2;\n");
    expect(changedTests(root, base)).toEqual(["src/d.test.ts", "src/lib/c.test.ts"]);

    write("src/e.ts", 'import { a } from "./a.ts";\n');
    write("src/e.test.ts", 'import "./e.ts";\n');
    expect(changedTests(root, base)).toEqual(["src/d.test.ts", "src/e.test.ts", "src/lib/c.test.ts"]);
  });

  test("a renamed source reaches the tests of its old path too", () => {
    const base = commit();
    gitIn("mv", "src/no-test.ts", "src/moved.ts");
    commit();
    expect(changedTests(root, base)).toEqual(["src/uses-no-test.test.ts"]);
  });
});

describe("running the reached files", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "changed-tests-run-")));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString().trim();
  git("init", "-q", "-b", "main");
  write("ok.test.ts", 'import { expect, test } from "bun:test";\ntest("ok", () => expect(1).toBe(1));\n');
  write("bad.test.ts", 'import { expect, test } from "bun:test";\ntest("bad", () => expect(1).toBe(2));\n');
  // Fails on its first run only: the marker file it leaves makes the second one pass.
  write("once.test.ts", 'import { expect, test } from "bun:test";\nimport { existsSync, writeFileSync } from "node:fs";\ntest("once", () => { const seen = existsSync("seen"); writeFileSync("seen", ""); expect(seen).toBe(true); });\n');
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");

  test("a failing file fails with its output, a file that passes alone on its second run is flaky", async () => {
    const { results, flaky } = await runFiles(root, ["ok.test.ts", "bad.test.ts", "once.test.ts"], 2, process.env);
    expect(results.map((result) => [result.file, result.passed])).toEqual([["bad.test.ts", false], ["ok.test.ts", true], ["once.test.ts", true]]);
    expect(results[0].output).toContain("bad");
    expect(flaky).toEqual(["once.test.ts"]);
  });
});
