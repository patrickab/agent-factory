import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { caseDir, git, makeRepo, runnerEnded, scratch, testPath, until, useCoreFixture } from "./core-test-kit.ts";
import { defaultBranch, deleteTask, launchTask, taskInboxPath, unmergedWork } from "./launch.ts";
import { saveSettings } from "./settings.ts";
import { listTasks } from "./tasks.ts";

useCoreFixture();

/** Waits until no runner of a task this test started is alive. */
async function runnersEnded(): Promise<void> {
  for (const record of await listTasks()) await until(() => runnerEnded(record));
}

/**
 * A fake `agent-worktree`, first on PATH, that puts worktrees under `<scratch>/fake-worktrees`, never under
 * `~/git/worktrees`. `remove` deletes the branch checked out, as the real one does.
 */
function withAgentWorktree(): void {
  const bin = join(caseDir, "aw-bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "agent-worktree"),
    `#!/bin/sh
set -e
root="${join(scratch, "fake-worktrees")}"
case "$1" in
  create)
    name="$2"; base="$4"
    [ "$5" = "--background" ] || { echo "missing --background" >&2; exit 2; }
    mkdir -p "$root"
    git worktree add --quiet -b "$name" "$root/$name" "$base" >&2
    echo "setting up"
    echo "$root/$name"
    ;;
  remove)
    branch="$(git -C "$2" symbolic-ref --short HEAD)"
    git worktree remove --force "$2" >&2
    git branch -D "$branch" >&2
    echo "$2"
    ;;
esac
`,
  );
  chmodSync(join(bin, "agent-worktree"), 0o755);
  process.env.PATH = `${bin}:${testPath}`;
}

/** A repo with `factory.yaml` committed as `config` (none: null). */
function repoWith(config: string | null, name = "repo"): string {
  const repo = makeRepo(false, name);
  if (config === null) return repo;
  writeFileSync(join(repo, "factory.yaml"), config);
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "config");
  return repo;
}

describe("defaultBranch", () => {
  test("the branch origin/HEAD names", async () => {
    const upstream = makeRepo(true, "upstream");
    git(upstream, "branch", "-m", "trunk");
    git(caseDir, "clone", "--quiet", upstream, "clone");
    const clone = join(caseDir, "clone");
    git(clone, "branch", "--quiet", "main");
    expect(await defaultBranch(clone)).toBe("trunk");
  });

});

describe("launchTask", () => {
  test("agent-worktree on PATH: a worktree on a new branch from the resolved branch, and the record", async () => {
    withAgentWorktree();
    const repo = makeRepo();
    git(repo, "checkout", "--quiet", "-b", "feature");
    writeFileSync(join(repo, "f.txt"), "f\n");
    git(repo, "add", "-A");
    git(repo, "commit", "--quiet", "-m", "feature");
    git(repo, "checkout", "--quiet", "main");
    await saveSettings(repo, { branch: "feature" });

    const record = await launchTask({ repo, title: "Add a Greeting!", request: "say hi" });

    expect(record.repo).toBe(repo);
    expect(record.branch).toMatch(/^add-a-greeting-[0-9a-f]{8}$/);
    expect(record.branch.endsWith(record.id.slice(0, 8))).toBe(true);
    expect(record.worktree).toBe(join(scratch, "fake-worktrees", record.branch));
    expect(git(record.worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(record.branch);
    expect(git(record.worktree, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "feature"));
    expect(record.sessionDir).toBe(join(caseDir, "agent", "factory", "sessions", `--${record.repo.slice(1).replaceAll("/", "-")}--`));
    expect(record.sessionId).not.toBe("");
    expect([record.tag, record.plan, record.wave]).toEqual([userInfo().username, null, null]);
    expect(await listTasks()).toEqual([record]);
  });

  test("a target branch without factory.yaml: refused before any worktree", async () => {
    const repo = repoWith(null);
    const refusal = launchTask({ repo, title: "t", request: "r" });
    await expect(refusal).rejects.toMatchObject({ code: "refused" });
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
  });

  test("hooks.after_create of one repository run one launch at a time; another repository is not held", async () => {
    const spans = join(caseDir, "spans");
    const hook = (tag: string) => `hooks:\n  after_create:\n    - ["sh", "-c", "echo ${tag} start $(date +%s%N) >> ${spans}; sleep 0.4; echo ${tag} end $(date +%s%N) >> ${spans}"]\n`;
    const [a, b] = [repoWith(hook("a")), repoWith(hook("b"), "other")];
    await Promise.all([a, a, b].map((repo, i) => launchTask({ repo, title: `T${i}`, request: "r" })));
    const lines = readFileSync(spans, "utf8").trim().split("\n").map((line) => line.split(" "));
    const times = (tag: string, kind: string) => lines.filter((l) => l[0] === tag && l[1] === kind).map((l) => BigInt(l[2]!)).sort((x, y) => (x < y ? -1 : 1));
    const [starts, ends] = [times("a", "start"), times("a", "end")];
    expect(starts[1]! >= ends[0]!).toBe(true);
    expect(times("b", "start")[0]! < ends[0]!).toBe(true);
    await runnersEnded();
  });

  for (const [label, usesAgentWorktree] of [
    ["git worktree add", false],
    ["agent-worktree", true],
  ] as const) {
    test(`a failing hooks.after_create removes the worktree, the branch and the record (${label})`, async () => {
      if (usesAgentWorktree) withAgentWorktree();
      const repo = repoWith('hooks:\n  after_create:\n    - ["sh", "-c", "echo boom >&2; exit 3"]\n');
      await expect(launchTask({ repo, title: "Broken", request: "r" })).rejects.toThrow();
      expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
      expect(git(repo, "branch", "--list", "broken-*")).toBe("");
      for (const root of [join(caseDir, "worktrees", "repo"), join(scratch, "fake-worktrees")]) {
        const left = existsSync(root) ? readdirSync(root).filter((name) => name.startsWith("broken-")) : [];
        expect(left).toEqual([]);
      }
      expect(await listTasks()).toEqual([]);
    });
  }
});

describe("deleteTask", () => {
  test("removes the task's own branch through git, never the branch checked out in its worktree", async () => {
    withAgentWorktree();
    const repo = makeRepo();
    git(repo, "branch", "--quiet", "precious");
    const record = await launchTask({ repo, title: "Switch", request: "r" });
    git(record.worktree, "checkout", "--quiet", "precious");
    await runnersEnded();
    writeFileSync(taskInboxPath(record.id), `${JSON.stringify({ text: "hi" })}\n`);
    writeFileSync(`${taskInboxPath(record.id)}.read`, "0\n");
    await deleteTask(record);
    expect(existsSync(taskInboxPath(record.id))).toBe(false);
    expect(existsSync(`${taskInboxPath(record.id)}.read`)).toBe(false);
    expect(git(repo, "branch", "--list", "precious")).toBe("precious");
    expect(git(repo, "branch", "--list", record.branch)).toBe("");
    expect(existsSync(record.worktree)).toBe(false);
    expect(await listTasks()).toEqual([]);
  });
});

describe("unmergedWork", () => {

  test("an untracked file makes the worktree dirty even with status.showUntrackedFiles=no", async () => {
    const repo = makeRepo();
    const worktree = join(caseDir, "u-wt");
    git(repo, "worktree", "add", "--quiet", "-b", "u", worktree);
    git(repo, "config", "status.showUntrackedFiles", "no");
    writeFileSync(join(worktree, "forgotten.txt"), "work\n");
    const record = { id: "i", repo, worktree, branch: "u", title: "u", sessionId: "test-session-s", sessionDir: caseDir, createdAt: "x", tag: "t", plan: null, wave: null, origin: null, start: "" };
    expect(await unmergedWork(record, "main")).toEqual({ commits: 0, dirty: true });
  });
});
