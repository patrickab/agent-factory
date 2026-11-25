import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { changedTests, reachedTests } from "./changed-tests.ts";

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

describe("reachedTests", () => {
  test("a changed source reaches its own test and every test importing it, transitively", () => {
    expect(reachedTests(["src/a.ts"], sources)).toEqual(["src/a.test.ts", "src/b.test.ts", "src/lib/c.test.ts"]);
    expect(reachedTests(["src/lib/c.ts"], sources)).toEqual(["src/lib/c.test.ts"]);
  });

  test("a changed test runs itself only", () => {
    expect(reachedTests(["src/d.test.ts"], sources)).toEqual(["src/d.test.ts"]);
  });

  test("a source without a test next to it reaches the tests importing it, a dynamic import too", () => {
    expect(reachedTests(["src/no-test.ts"], sources)).toEqual(["src/uses-no-test.test.ts"]);
  });

  test("nothing reached: a change outside the sources, or a test that is gone", () => {
    expect(reachedTests(["README.md", "factory.yaml"], sources)).toEqual([]);
    expect(reachedTests(["src/gone.test.ts"], sources)).toEqual([]);
  });

  test("a deleted source still reaches the tests that import it", () => {
    const without = new Map(sources);
    without.delete("src/a.ts");
    expect(reachedTests(["src/a.ts"], without)).toEqual(["src/a.test.ts", "src/b.test.ts", "src/lib/c.test.ts"]);
  });
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
});
