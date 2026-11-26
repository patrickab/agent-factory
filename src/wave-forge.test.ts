/**
 * A `squash` wave with `remote` on lands on its forge (`remote.ts` `landOnForge`, `wave-runner.ts` `merge`), over real
 * git repos in a temp dir: the origin a bare repo reached through `insteadOf`, a fake `gh`/`glab` on PATH that really
 * squash-merges there, the reviewer a fake `pi` that approves.
 */
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { caseDigits, caseSerial, caseTests } from "./test-case.ts";
import { callAction } from "./core.ts";
import { worktreePath } from "./launch.ts";
import { writeTask, type TaskRecord } from "./tasks.ts";
import { stopWaveRunners } from "./wave-poke.ts";
import { runWave, squashMessage, waveCommitsRef } from "./wave-runner.ts";
import { appendWaveEvent, createWave, listWaves, lockWave, unlockWave, wavePath, type WaveView } from "./waves.ts";
import { FORGE_BEHIND } from "./remote.ts";

const test = caseTests();
const savedEnv = { ...process.env };
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "factory-wave-forge-test-")));
const fakeBin = join(scratch, "bin");

mkdirSync(fakeBin);
writeFileSync(
  join(fakeBin, "pi"),
  `#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
if (!args.includes("json")) process.exit(3);
const dir = args[args.indexOf("--session-dir") + 1];
const id = "11111111-2222-4333-8444-555555555555";
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "2026-01-01T00-00-00-000Z_" + id + ".jsonl"), JSON.stringify({ type: "session", id }) + "\\n");
const emit = (record) => console.log(JSON.stringify(record));
emit({ type: "session", id });
emit({ type: "tool_execution_end", toolName: "submit_verdict", isError: false, result: { details: { findings: [] } } });
emit({ type: "message_end", message: { role: "assistant", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
`,
);
chmodSync(join(fakeBin, "pi"), 0o755);

let caseDir: string;
let caseCount = 0;

beforeEach(() => {
  caseDir = join(scratch, `case-${++caseCount}`);
  mkdirSync(caseDir);
  Object.assign(process.env, {
    PATH: `${fakeBin}:${savedEnv.PATH ?? ""}`,
    HOME: scratch,
    PI_CODING_AGENT_DIR: join(caseDir, "agent"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "test",
    GIT_COMMITTER_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_EMAIL: "test@example.com",
  });
});

afterEach(async () => {
  for (const wave of await listWaves()) await stopWaveRunners(wave.declaration.id);
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitOk(cwd: string, ...args: string[]): boolean {
  try {
    git(cwd, ...args);
    return true;
  } catch {
    return false;
  }
}

function commit(cwd: string, file: string, text: string, message: string): string {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", "-A");
  git(cwd, "commit", "--quiet", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

const RUN = randomBytes(2).toString("hex");
const WAVE = (): string => `34000000-${RUN}-4000-8000-${caseDigits()}`;
const BRANCH = "main-forge-w1";
const TAG = "forge/w1";
const REF = () => waveCommitsRef({ id: WAVE(), tag: TAG });
const taskId = (n: number) => `44000000-${RUN}-4000-8000-${caseDigits(caseSerial() * 10 + n)}`;

/**
 * A repo on `main` with `factory.yaml` (`config`), the wave's branch off it holding one commit per task (`files`), the
 * tasks' records with `done` sessions, and the wave's log. Returns the repo.
 */
async function waveRepo(overrides: object = { squash: true, remote: true }, files = ["b", "c"], config = 'gates:\n  - ["true"]\n'): Promise<string> {
  const repo = join(caseDir, "repo");
  mkdirSync(repo);
  git(repo, "init", "--quiet", "-b", "main");
  writeFileSync(join(repo, "factory.yaml"), config);
  commit(repo, "a.txt", "a\n", "init");
  const base = git(repo, "rev-parse", "main");
  git(repo, "branch", BRANCH);
  const work = join(caseDir, "work");
  git(repo, "worktree", "add", "--quiet", work, BRANCH);
  for (const file of files) commit(work, `${file}.txt`, `${file}\n`, `feat: add ${file}`);
  git(repo, "worktree", "remove", work);
  await createWave({ id: WAVE(), repo, tag: TAG, plan: null, title: "Wave one", request: "r", branch: BRANCH, target: "main", base, origin: null, createdAt: "2026-01-01T00:00:00.000Z", overrides });
  const specs = files.map((file, index) => ({ key: file, title: `Add ${file}`, request: `add ${file}`, after: index === 0 ? [] : [files[index - 1]] }));
  await appendWaveEvent(WAVE(), { kind: "tasks", tasks: specs });
  for (const [index, spec] of specs.entries()) {
    const record: TaskRecord = {
      id: taskId(index + 1),
      repo,
      worktree: join(caseDir, `task-${spec.key}`),
      branch: `task-${spec.key}`,
      title: spec.title,
      sessionId: `session-${RUN}-${caseSerial()}-${spec.key}`,
      sessionDir: join(caseDir, "sessions"),
      createdAt: `2026-01-01T00:00:0${index + 1}.000Z`,
      tag: TAG,
      plan: null,
      wave: WAVE(),
      origin: null,
    };
    await writeTask(record);
    mkdirSync(record.sessionDir, { recursive: true });
    const entry = { type: "custom", customType: "factory-state", data: { state: "done", round: 1, reason: "r" } };
    writeFileSync(join(record.sessionDir, `2026-01-01T00-00-00-000Z_${record.sessionId}.jsonl`), `${JSON.stringify(entry)}\n`);
    await appendWaveEvent(WAVE(), { kind: "task", key: spec.key, taskId: record.id, sessionId: record.sessionId });
  }
  return repo;
}

const getWave = async () => ((await callAction("waves.get", { id: WAVE() })) as { wave: WaveView }).wave;
const kinds = async () => ((await callAction("waves.timeline", { id: WAVE() })) as { events: { kind: string; stage?: string }[] }).events.map((event) => event.stage ?? event.kind);
const reviewWorktree = (repo: string) => worktreePath(repo, `wave-${WAVE().slice(0, 8)}-review`);
const branchExists = (repo: string) => gitOk(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH}`);

/** Cuts the wave's log back to before its `merge` event: as if its runner died after the target moved. */
function forgetLanding(): void {
  const lines = readFileSync(wavePath(WAVE()), "utf8").split("\n").filter(Boolean);
  const at = lines.findIndex((line) => (JSON.parse(line) as { kind?: string }).kind === "merge");
  expect(at).toBeGreaterThan(0);
  writeFileSync(wavePath(WAVE()), `${lines.slice(0, at).join("\n")}\n`);
}

/** The fake `gh`/`glab`: logs its argv, opens one request, squash-merges it in the bare origin, reports its state. */
const FAKE_FORGE = `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
const name = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_FORGE_LOG, JSON.stringify([name, ...args]) + "\\n");
const bare = process.env.FAKE_FORGE_ORIGIN;
const mode = process.env.FAKE_FORGE_MODE ?? "";
const file = join(bare, "fake-request.json");
const read = () => JSON.parse(readFileSync(file, "utf8"));
const save = (data) => writeFileSync(file, JSON.stringify(data));
const git = (...argv) => execFileSync("git", argv, { cwd: bare, encoding: "utf8" }).trim();
const opt = (flag) => args[args.indexOf(flag) + 1];
const gh = name === "gh";
if (args[1] === "create") {
  if (mode === "no-request") { console.error("create failed"); process.exit(1); }
  save({ branch: opt(gh ? "--head" : "--source-branch"), target: opt(gh ? "--base" : "--target-branch"), state: "open", commit: null });
  console.log(gh ? "https://github.com/acme/app/pull/7" : "https://gitlab.com/acme/app/-/merge_requests/7");
} else if (args[1] === "merge") {
  const request = read();
  if (mode.startsWith("refuse")) {
    if (mode === "refuse-closed") save({ ...request, state: "closed" });
    console.error("merge refused: checks pending");
    process.exit(1);
  }
  const message = gh ? opt("--subject") + "\\n\\n" + opt("--body") : opt("--squash-message");
  const parent = git("rev-parse", "refs/heads/" + request.target);
  const tree = git("rev-parse", (mode === "other-tree" ? parent : "refs/heads/" + request.branch) + "^{tree}");
  const commit = git("commit-tree", tree, "-p", parent, "-m", message);
  git("update-ref", "refs/heads/" + request.target, commit, parent);
  git("update-ref", "-d", "refs/heads/" + request.branch);
  save({ ...request, state: "merged", commit });
  // The fetch that follows fails: origin cannot be read from the repository any more (pushes still go).
  if (mode === "break-fetch") execFileSync("git", ["config", "remote.origin.uploadpack", "false"]);
  // The local target moves meanwhile (somebody commits to it by hand): the factory's move must fail.
  if (mode === "move-local") {
    const local = execFileSync("git", ["rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim();
    const moved = execFileSync("git", ["commit-tree", local + "^{tree}", "-p", local, "-m", "main: by hand"], { encoding: "utf8" }).trim();
    execFileSync("git", ["update-ref", "refs/heads/main", moved, local]);
  }
} else if (args[1] === "view") {
  const { state, commit } = read();
  console.log(JSON.stringify(gh ? { state: state.toUpperCase(), mergeCommit: commit === null ? null : { oid: commit } } : { state: state === "open" ? "opened" : state, merge_commit_sha: null, squash_commit_sha: commit }));
}
`;

const forgeLog = () => join(caseDir, "forge.log");
const calls = (): string[][] => (existsSync(forgeLog()) ? readFileSync(forgeLog(), "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]) : []);
const merges = () => calls().filter((call) => call[2] === "merge");

beforeEach(() => {
  const bin = join(caseDir, "forge-bin");
  mkdirSync(bin);
  for (const name of ["gh", "glab"]) {
    writeFileSync(join(bin, name), FAKE_FORGE);
    chmodSync(join(bin, name), 0o755);
  }
  // No real gh or glab is reachable: a directory holding one is left out of PATH (bun's own is kept).
  const system = (savedEnv.PATH ?? "").split(":").filter((dir) => dir !== "" && !existsSync(join(dir, "gh")) && !existsSync(join(dir, "glab")));
  process.env.PATH = [bin, fakeBin, dirname(process.execPath), ...system].join(":");
  process.env.FAKE_FORGE_LOG = forgeLog();
});

/** A bare repo as `origin` holding `main`, reached through `insteadOf` from `url`, so the forge is the URL's. */
function origin(repo: string, url = "https://github.com/acme/app.git"): string {
  const bare = join(caseDir, "origin.git");
  git(caseDir, "init", "--quiet", "--bare", bare);
  git(repo, "remote", "add", "origin", url);
  git(repo, "config", `url.${bare}.insteadOf`, url);
  git(repo, "push", "--quiet", "origin", "main");
  process.env.FAKE_FORGE_ORIGIN = bare;
  return bare;
}

const message = (subjects: string[]) => squashMessage({ id: WAVE(), tag: TAG, title: "Wave one" }, subjects);
const remoteEvents = async () => ((await callAction("waves.timeline", { id: WAVE() })) as { events: Record<string, unknown>[] }).events.filter((event) => event.kind === "remote");

/** Landed on the forge: local and origin's target on the forge's commit (parent `from`, the gated tree), the ref, no branch. */
async function expectForgeLanded(repo: string, bare: string, from: string): Promise<WaveView> {
  const wave = await getWave();
  expect(wave.stage).toBe("merged");
  const main = git(repo, "rev-parse", "main");
  expect(git(bare, "rev-parse", "main")).toBe(main);
  expect(wave.remote?.merged).toBe(main);
  expect(git(repo, "rev-parse", "main^")).toBe(from);
  expect(git(repo, "show", "-s", "--format=%B", "main")).toBe(message(["feat: add b", "feat: add c"]));
  expect(git(repo, "rev-parse", "main^{tree}")).toBe(git(repo, "rev-parse", `${REF()}^{tree}`));
  expect(git(repo, "log", "--reverse", "--format=%s", `${from}..${REF()}`)).toBe("feat: add b\nfeat: add c");
  expect(branchExists(repo)).toBe(false);
  expect(gitOk(bare, "rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH}`)).toBe(false);
  expect(existsSync(reviewWorktree(repo))).toBe(false);
  expect(wave.merge).toEqual({ at: expect.any(String), from, to: main, queueMs: expect.any(Number), ref: REF(), commits: 2 });
  expect((await kinds()).filter((kind) => kind === "merge")).toHaveLength(1);
  expect(merges()).toHaveLength(1);
  return wave;
}

/** Landed locally: one local squash commit on `from`; `pushed` says whether origin's target got it. */
async function expectLocalLanded(repo: string, bare: string, from: string, pushed: boolean): Promise<WaveView> {
  const wave = await getWave();
  expect(wave.stage).toBe("merged");
  const main = git(repo, "rev-parse", "main");
  expect(git(repo, "rev-parse", "main^")).toBe(from);
  expect(git(repo, "show", "-s", "--format=%B", "main")).toBe(message(["feat: add b", "feat: add c"]));
  expect(branchExists(repo)).toBe(false);
  expect(git(bare, "rev-parse", "main") === main).toBe(pushed);
  expect(wave.remote?.merged ?? null).toBeNull();
  expect(wave.merge).toMatchObject({ from, to: main, ref: REF(), commits: 2 });
  expect((await kinds()).filter((kind) => kind === "merge")).toHaveLength(1);
  return wave;
}

/** `waves.retry` with the runner held off, then the runner by hand. */
async function retry(): Promise<void> {
  await lockWave(WAVE());
  try {
    await callAction("waves.retry", { id: WAVE() });
  } finally {
    await unlockWave(WAVE());
  }
  expect(await runWave(WAVE())).toBe(0);
}

describe("a squash wave on its forge", () => {
  test("GitHub: the forge squash-merges it with the wave's message, the local target moves to its commit, nothing pushed after", async () => {
    const repo = await waveRepo();
    const bare = origin(repo);
    const init = git(repo, "rev-parse", "main");
    expect(await runWave(WAVE())).toBe(0);
    await expectForgeLanded(repo, bare, init);
    const [merge] = merges();
    expect(merge).toEqual(["gh", "pr", "merge", "7", "--squash", "--delete-branch", "--subject", "Wave one", "--body", message(["feat: add b", "feat: add c"]).split("\n\n").slice(1).join("\n\n")]);
    // No pending push, no push of the target: the forge has it.
    expect((await remoteEvents()).some((event) => event.error !== undefined && event.error !== null)).toBe(false);
    expect((await kinds()).slice(-3)).toEqual(["remote", "merge", "merged"]);
  });

  test("GitLab: glab merges with squash, the source branch removed, the whole message", async () => {
    const repo = await waveRepo();
    const bare = origin(repo, "git@gitlab.example.com:acme/app.git");
    const init = git(repo, "rev-parse", "main");
    expect(await runWave(WAVE())).toBe(0);
    await expectForgeLanded(repo, bare, init);
    expect(merges()[0]).toEqual(["glab", "mr", "merge", "7", "--squash", "--remove-source-branch", "--yes", "--squash-message", message(["feat: add b", "feat: add c"])]);
  });

  test("origin's target differs from the local one: no forge merge, the local landing, its refused push recorded", async () => {
    const repo = await waveRepo();
    const bare = origin(repo);
    const init = git(repo, "rev-parse", "main");
    // Origin's main gets a commit the local main lacks.
    const other = join(caseDir, "other");
    git(caseDir, "clone", "--quiet", "--branch", "main", bare, other);
    commit(other, "x.txt", "x\n", "origin: add x");
    git(other, "push", "--quiet", "origin", "main");
    const theirs = git(bare, "rev-parse", "main");
    expect(await runWave(WAVE())).toBe(0);
    const wave = await expectLocalLanded(repo, bare, init, false);
    expect(merges()).toEqual([]);
    expect(git(bare, "rev-parse", "main")).toBe(theirs);
    expect(wave.remote?.error).toContain(`landed locally: main on origin is ${theirs.slice(0, 12)}`);
    expect(wave.remote?.error).toContain("git push exited");
  });

  test("no request: the local landing, the target pushed, the reason recorded", async () => {
    process.env.FAKE_FORGE_MODE = "no-request";
    const repo = await waveRepo();
    const bare = origin(repo);
    const init = git(repo, "rev-parse", "main");
    expect(await runWave(WAVE())).toBe(0);
    const wave = await expectLocalLanded(repo, bare, init, true);
    expect(merges()).toEqual([]);
    expect(wave.remote?.error).toBe("landed locally: no request is known");
    expect(wave.remote?.pushed).toBe(git(repo, "rev-parse", "main"));
  });

  test("an unsupported forge: the local landing, the target pushed, the reason recorded", async () => {
    const repo = await waveRepo();
    const bare = origin(repo, "https://git.example.com/acme/app.git");
    const init = git(repo, "rev-parse", "main");
    expect(await runWave(WAVE())).toBe(0);
    const wave = await expectLocalLanded(repo, bare, init, true);
    expect(calls()).toEqual([]);
    expect(wave.remote?.error).toBe("landed locally: unsupported: the origin is neither GitHub nor GitLab");
  });

  test("the forge refuses and the request stays open: the local landing, the target pushed, the refusal recorded", async () => {
    process.env.FAKE_FORGE_MODE = "refuse";
    const repo = await waveRepo();
    const bare = origin(repo);
    const init = git(repo, "rev-parse", "main");
    expect(await runWave(WAVE())).toBe(0);
    const wave = await expectLocalLanded(repo, bare, init, true);
    expect(merges()).toHaveLength(1);
    expect(wave.remote?.error).toContain("landed locally: the forge refused the merge: gh pr exited 1: merge refused");
  });

  test("the forge refuses and the request is closed: blocked, nothing moved", async () => {
    process.env.FAKE_FORGE_MODE = "refuse-closed";
    const repo = await waveRepo();
    const bare = origin(repo);
    const init = git(repo, "rev-parse", "main");
    expect(await runWave(WAVE())).toBe(0);
    const wave = await getWave();
    expect([wave.stage, wave.reason]).toEqual(["blocked", "infra"]);
    expect(git(repo, "rev-parse", "main")).toBe(init);
    expect(git(bare, "rev-parse", "main")).toBe(init);
    expect(wave.remote?.error).toContain("the request is closed");
  });

  test("merged on the forge, the fetch failed: blocked, the local target behind; waves.retry resumes at the fetch", async () => {
    process.env.FAKE_FORGE_MODE = "break-fetch";
    const repo = await waveRepo();
    const bare = origin(repo);
    const init = git(repo, "rev-parse", "main");
    expect(await runWave(WAVE())).toBe(0);
    const blocked = await getWave();
    expect([blocked.stage, blocked.reason]).toEqual(["blocked", "infra"]);
    expect(blocked.detail).toContain(FORGE_BEHIND);
    expect(git(repo, "rev-parse", "main")).toBe(init);
    expect(blocked.remote?.merged).toBe(git(bare, "rev-parse", "main"));
    const reviews = (await kinds()).filter((kind) => kind === "review").length;

    git(repo, "config", "--unset", "remote.origin.uploadpack");
    delete process.env.FAKE_FORGE_MODE;
    await retry();
    await expectForgeLanded(repo, bare, init);
    // From the fetch: no second review, no second merge on the forge.
    expect((await kinds()).filter((kind) => kind === "review")).toHaveLength(reviews);
    expect((await kinds()).slice(-5)).toEqual(["blocked", "reviewing", "merging", "merge", "merged"]);
  });

  test("the forge's commit has another tree: blocked, nothing moved locally", async () => {
    process.env.FAKE_FORGE_MODE = "other-tree";
    const repo = await waveRepo();
    origin(repo);
    const init = git(repo, "rev-parse", "main");
    expect(await runWave(WAVE())).toBe(0);
    const wave = await getWave();
    expect([wave.stage, wave.reason]).toEqual(["blocked", "infra"]);
    expect(wave.detail).toContain("has not the gated tree");
    expect(git(repo, "rev-parse", "main")).toBe(init);
  });

  test("a rerun after the move: no second merge on the forge, one merge event", async () => {
    const repo = await waveRepo();
    const bare = origin(repo);
    const init = git(repo, "rev-parse", "main");
    expect(await runWave(WAVE())).toBe(0);
    forgetLanding();
    expect(await runWave(WAVE())).toBe(0);
    await expectForgeLanded(repo, bare, init);
  });

  test("a rerun after the forge merged but before its record and the move: origin's target is taken, never merged twice", async () => {
    const repo = await waveRepo();
    const bare = origin(repo);
    const init = git(repo, "rev-parse", "main");
    expect(await runWave(WAVE())).toBe(0);
    // Back to before the forge's merge was recorded, the local target and branch as they were.
    const lines = readFileSync(wavePath(WAVE()), "utf8").split("\n").filter(Boolean);
    const at = lines.findIndex((line) => "merged" in (JSON.parse(line) as object) && (JSON.parse(line) as { kind?: string }).kind === "remote");
    expect(at).toBeGreaterThan(0);
    writeFileSync(wavePath(WAVE()), `${lines.slice(0, at).join("\n")}\n`);
    git(repo, "update-ref", "refs/heads/main", init);
    git(repo, "branch", BRANCH, REF());
    expect(await runWave(WAVE())).toBe(0);
    await expectForgeLanded(repo, bare, init);
  });

  test("of one commit: lands as the forge's commit, recognised as landed, also on a rerun", async () => {
    const repo = await waveRepo({ squash: true, remote: true }, ["b"]);
    const bare = origin(repo);
    const init = git(repo, "rev-parse", "main");
    const check = async () => {
      const wave = await getWave();
      expect(wave.stage).toBe("merged");
      const main = git(repo, "rev-parse", "main");
      expect(git(bare, "rev-parse", "main")).toBe(main);
      expect(wave.remote?.merged).toBe(main);
      expect(git(repo, "rev-parse", "main^")).toBe(init);
      expect(git(repo, "rev-parse", "main^{tree}")).toBe(git(repo, "rev-parse", `${REF()}^{tree}`));
      expect(git(repo, "show", "-s", "--format=%B", "main")).toBe(message(["feat: add b"]));
      expect(branchExists(repo)).toBe(false);
      expect(wave.merge).toEqual({ at: expect.any(String), from: init, to: main, queueMs: expect.any(Number), ref: REF(), commits: 1 });
      expect((await kinds()).filter((kind) => kind === "merge")).toHaveLength(1);
      expect(merges()).toHaveLength(1);
    };
    expect(await runWave(WAVE())).toBe(0);
    await check();
    forgetLanding();
    expect(await runWave(WAVE())).toBe(0);
    await check();
  });

  test("the local target moved after the forge merged it: blocked, nothing lands a second time", async () => {
    process.env.FAKE_FORGE_MODE = "move-local";
    const repo = await waveRepo();
    const bare = origin(repo);
    const init = git(repo, "rev-parse", "main");
    expect(await runWave(WAVE())).toBe(0);
    const wave = await getWave();
    expect([wave.stage, wave.reason]).toEqual(["blocked", "infra"]);
    expect(wave.detail).toContain("moved here meanwhile");
    // The forge holds the one landing; the local target only the commit made by hand.
    expect(merges()).toHaveLength(1);
    expect(git(bare, "rev-parse", "main^")).toBe(init);
    expect(wave.remote?.merged).toBe(git(bare, "rev-parse", "main"));
    expect(git(repo, "log", "--format=%s", "main")).toBe("main: by hand\ninit");
    expect(wave.merge).toBeNull();
  });
});
