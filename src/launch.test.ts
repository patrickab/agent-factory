import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { defaultBranch, deleteTask, launchTask, liveRunners, taskInboxPath, unmergedWork } from "./launch.ts";
import { saveSettings } from "./settings.ts";
import { listTasks, taskLogPath } from "./tasks.ts";

const savedEnv = { ...process.env };
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "test";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "test@example.com";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "factory-launch-test-")));
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
// A real `agent-worktree` that slipped through would write under `$HOME/git/worktrees`: keep that inside scratch too.
process.env.HOME = scratch;

/**
 * `launchTask` starts a runner: a fake `pi` that exits before it answers stands first on every PATH of these tests, so
 * no real Pi ever runs.
 */
const piBin = join(scratch, "pi-bin");
mkdirSync(piBin);
writeFileSync(join(piBin, "pi"), "#!/bin/sh\nexit 0\n");
chmodSync(join(piBin, "pi"), 0o755);

/** A PATH without any directory that holds `agent-worktree`: the plain `git worktree add` path. */
const pathWithoutAgentWorktree = [
  piBin,
  ...(savedEnv.PATH ?? "").split(":").filter((dir) => dir !== "" && !existsSync(join(dir, "agent-worktree"))),
].join(":");

/** Waits until no runner of a task this test file started is alive. */
async function runnersEnded(): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (const record of await listTasks()) {
    while ((await liveRunners(record)).length > 0) {
      if (Date.now() > deadline) throw new Error("a runner did not end");
      await Bun.sleep(50);
    }
  }
}

/**
 * A fake `agent-worktree` that puts worktrees under `<scratch>/fake-worktrees`, never under `~/git/worktrees`.
 * `FAKE_AW_FAIL=1`: `create` fails after its `git worktree add`. `remove` deletes the branch checked out, as the real one does.
 */
const fakeBin = join(scratch, "bin");
mkdirSync(fakeBin);
writeFileSync(
  join(fakeBin, "agent-worktree"),
  `#!/bin/sh
set -e
root="${join(scratch, "fake-worktrees")}"
case "$1" in
  create)
    name="$2"; base="$4"
    [ "$5" = "--background" ] || { echo "missing --background" >&2; exit 2; }
    mkdir -p "$root"
    git worktree add --quiet -b "$name" "$root/$name" "$base" >&2
    [ "$FAKE_AW_FAIL" = "1" ] && { echo "venv failed" >&2; exit 1; }
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
chmodSync(join(fakeBin, "agent-worktree"), 0o755);

afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  rmSync(scratch, { recursive: true, force: true });
});

let caseDir: string;
let caseCount = 0;
beforeEach(() => {
  caseDir = join(scratch, `case-${++caseCount}`);
  mkdirSync(caseDir);
  process.env.PATH = `${piBin}:${fakeBin}:${savedEnv.PATH}`;
});
afterEach(async () => {
  await runnersEnded();
  process.env.PATH = savedEnv.PATH;
  delete process.env.FAKE_AW_FAIL;
  rmSync(join(scratch, "agent"), { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A repo at `<caseDir>/<name>` with one commit on `branch`, a `factory.yaml` in it unless `files` maps it to null. */
function makeRepo(name: string, branch: string, files: Record<string, string | null> = {}): string {
  const repo = join(caseDir, name);
  mkdirSync(repo);
  git(repo, "init", "--quiet", "-b", branch);
  writeFileSync(join(repo, "a.txt"), "a\n");
  for (const [file, text] of Object.entries({ "factory.yaml": "gates: []\n", ...files })) if (text !== null) writeFileSync(join(repo, file), text);
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "init");
  return repo;
}

describe("defaultBranch", () => {
  test("the branch origin/HEAD names", async () => {
    const upstream = makeRepo("upstream", "trunk");
    git(caseDir, "clone", "--quiet", upstream, "clone");
    const clone = join(caseDir, "clone");
    git(clone, "branch", "--quiet", "main");
    expect(await defaultBranch(clone)).toBe("trunk");
  });

});

describe("launchTask", () => {
  test("agent-worktree on PATH: a worktree on a new branch from the resolved branch, and the record", async () => {
    const repo = makeRepo("repo", "main");
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
    expect(record.sessionDir).toBe(join(scratch, "agent", "factory", "sessions", `--${record.repo.slice(1).replaceAll("/", "-")}--`));
    expect(record.sessionId).not.toBe("");
    expect([record.tag, record.plan, record.wave]).toEqual([userInfo().username, null, null]);
    expect(await listTasks()).toEqual([record]);
    await runnersEnded();
    // The fake pi exits before it answers: the runner that got the start command says so in the task's log.
    expect(readFileSync(taskLogPath(record.id), "utf8")).toContain("before it answered the prompt");
  });

  test("a target branch that does not exist locally: refused before any worktree", async () => {
    const repo = makeRepo("repo", "main");
    await expect(launchTask({ repo, title: "t", request: "r", overrides: { branch: "nope" } })).rejects.toThrow(
      "branch nope does not exist locally",
    );
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
  });

  test("a target branch without factory.yaml: refused before any worktree", async () => {
    const repo = makeRepo("repo", "main", { "factory.yaml": null });
    const refusal = launchTask({ repo, title: "t", request: "r" });
    await expect(refusal).rejects.toMatchObject({ code: "refused" });
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
  });

  for (const [label, usesAgentWorktree] of [
    ["git worktree add", false],
    ["agent-worktree", true],
  ] as const) {
    test(`a failing hooks.after_create removes the worktree, the branch and the record (${label})`, async () => {
      if (!usesAgentWorktree) process.env.PATH = pathWithoutAgentWorktree;
      const repo = makeRepo("repo", "main", { "factory.yaml": 'hooks:\n  after_create:\n    - ["sh", "-c", "echo boom >&2; exit 3"]\n' });
      await expect(launchTask({ repo, title: "Broken", request: "r" })).rejects.toThrow(/hooks\.after_create sh -c .*exit 3.*boom/s);
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

describe("launchTask failures", () => {
  /** No worktree but the main checkout, no branch and no directory named `<prefix>-*`, no record. */
  async function nothingLeft(repo: string, prefix: string): Promise<void> {
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
    expect(git(repo, "branch", "--list", `${prefix}-*`)).toBe("");
    for (const root of [join(caseDir, "worktrees", "repo"), join(scratch, "fake-worktrees")]) {
      const left = existsSync(root) ? readdirSync(root).filter((name) => name.startsWith(`${prefix}-`)) : [];
      expect(left).toEqual([]);
    }
    expect(await listTasks()).toEqual([]);
  }

  test("an abort kills the running hooks.after_create and undoes the launch", async () => {
    process.env.PATH = pathWithoutAgentWorktree;
    const repo = makeRepo("repo", "main", { "factory.yaml": 'hooks:\n  after_create:\n    - ["sleep", "30"]\n' });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const started = Date.now();
    await expect(launchTask({ repo, title: "Slow", request: "r", signal: controller.signal })).rejects.toThrow("the start was aborted");
    expect(Date.now() - started).toBeLessThan(8000);
    await nothingLeft(repo, "slow");
  }, 15_000);

  test("a repo path outside any git repository is refused naming it", async () => {
    await expect(launchTask({ repo: caseDir, title: "t", request: "r" })).rejects.toThrow(`${caseDir} is not inside a git repository`);
  });
});

describe("deleteTask", () => {
  test("removes the task's own branch through git, never the branch checked out in its worktree", async () => {
    const repo = makeRepo("repo", "main");
    git(repo, "branch", "--quiet", "precious");
    const record = await launchTask({ repo, title: "Switch", request: "r" });
    git(record.worktree, "checkout", "--quiet", "precious");
    writeFileSync(taskInboxPath(record.id), `${JSON.stringify({ text: "hi" })}\n`);
    writeFileSync(`${taskInboxPath(record.id)}.read`, "0\n");
    await runnersEnded();
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
    const repo = makeRepo("repo", "main");
    const worktree = join(caseDir, "u-wt");
    git(repo, "worktree", "add", "--quiet", "-b", "u", worktree);
    git(repo, "config", "status.showUntrackedFiles", "no");
    writeFileSync(join(worktree, "forgotten.txt"), "work\n");
    const record = { id: "i", repo, worktree, branch: "u", title: "u", sessionId: "test-session-s", sessionDir: caseDir, createdAt: "x", tag: "t", plan: null, wave: null, origin: null };
    expect(await unmergedWork(record, "main")).toEqual({ commits: 0, dirty: true });
  });
});
