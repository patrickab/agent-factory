import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { callAction } from "./core.ts";
import { caseDir, expectError, git, makeRepo, until, useCoreFixture } from "./core-test-kit.ts";
import { PROOF_KEEP_MS, PROOF_RUNNER_PATH, proofsDir, type ProofView } from "./gates-prove.ts";
import { worktreePath } from "./launch.ts";
import { pendingNotices } from "./notify.ts";
import { procStart } from "./queue.ts";

useCoreFixture();

const ORIGIN = "session-of-the-supervisor";

/** A repo on `main` whose `factory.yaml` holds `yaml`. */
function repoWith(yaml: string, name?: string): string {
  const repo = makeRepo(true, name);
  writeFileSync(join(repo, "factory.yaml"), yaml);
  git(repo, "commit", "--quiet", "-am", "gates");
  return repo;
}

type WaitAnswer = { proofs: ProofView[]; attention: string[]; timedOut: boolean };

/** Starts a proof of `repo`'s main and waits until it ends. */
async function prove(repo: string): Promise<{ started: ProofView; answer: WaitAnswer; proof: ProofView }> {
  const { proof: started } = (await callAction("gates.prove", {}, { cwd: repo, origin: ORIGIN })) as { proof: ProofView };
  const answer = (await callAction("tasks.wait", { ids: [started.id.slice(0, 8)], timeoutMs: 60_000 })) as WaitAnswer;
  const { proof } = (await callAction("gates.get", { id: started.id.slice(0, 8) })) as { proof: ProofView };
  return { started, answer, proof };
}

/** The worktree of the proof is gone, from the disk and from git. */
function expectWorktreeGone(repo: string, proof: ProofView): void {
  expect(existsSync(worktreePath(repo, `proof-${proof.id.slice(0, 8)}`))).toBe(false);
  expect(git(repo, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(1);
}

describe("gates.prove", () => {
  test("passed: after_create runs in a fresh worktree of the tip, every merge gate passes, the whole tree is the change", async () => {
    const repo = repoWith(
      [
        "hooks:",
        "  after_create:",
        '    - [sh, -c, "echo installed > hooked.txt"]',
        "merge_gates:",
        "  - [test, -f, hooked.txt]",
        '  - [sh, -c, "test \\"$FACTORY_BASE\\" = \\"$(git hash-object -t tree /dev/null)\\""]',
        "",
      ].join("\n"),
    );
    const { started, answer, proof } = await prove(repo);
    expect(started.state).toBe("running");
    expect(started.branch).toBe("main");
    expect(started.commit).toBe(git(repo, "rev-parse", "main"));
    expect(answer.timedOut).toBe(false);
    expect(answer.attention).toEqual([]);
    expect(answer.proofs.map((view) => view.state)).toEqual(["passed"]);
    expect(proof).toMatchObject({ state: "passed", flaky: [], failing: null, interrupted: false, origin: ORIGIN });
    expect(proof.steps.map((step) => [step.command.split(" ")[0], step.passed])).toEqual([
      ["test", true],
      ["sh", true],
    ]);
    expectWorktreeGone(repo, proof);
    const notices = pendingNotices([], [], new Set(), { gates: [proof] });
    expect(notices.map((notice) => [notice.key, notice.origin])).toEqual([[`proof:${proof.id}:passed`, ORIGIN]]);
    expect(notices[0].text).toStartWith("factory: the gates of main pass\nproof ");
    expect(pendingNotices([], [], new Set([`proof:${proof.id}:passed`]), { gates: [proof] })).toEqual([]);
  });

  test("flaky: a step that fails and passes on its rerun names its failing tests; no attention", async () => {
    process.env.PROOF_MARK = join(caseDir, "failed-once");
    const repo = repoWith(['merge_gates:', '  - [sh, -c, "test -f \\"$PROOF_MARK\\" || { touch \\"$PROOF_MARK\\"; echo \\"(fail) a timing test\\"; exit 1; }"]', ""].join("\n"));
    const { answer, proof } = await prove(repo);
    expect(answer.attention).toEqual([]);
    expect(proof).toMatchObject({ state: "flaky", flaky: ["a timing test"], failing: null });
    expect(proof.steps[0]).toMatchObject({ passed: true, flaky: ["a timing test"] });
    expectWorktreeGone(repo, proof);
    const [notice] = pendingNotices([], [], new Set(), { gates: [proof] });
    expect(notice.key).toBe(`proof:${proof.id}:flaky`);
    expect(notice.text).toContain("pass, flaky");
    expect(notice.text).toContain("flaky: a timing test");
  });

  test("failing: a step that fails twice stops the proof, needs attention, keeps its output in a log", async () => {
    const repo = repoWith(['merge_gates:', '  - [sh, -c, "echo the suite is broken; exit 1"]', "  - [touch, never-run]", ""].join("\n"));
    const { answer, proof } = await prove(repo);
    expect(answer.attention).toEqual([proof.id]);
    expect(proof.state).toBe("failing");
    expect(proof.steps).toHaveLength(1);
    expect(proof.failing?.step).toBe("sh -c echo the suite is broken; exit 1");
    expect(proof.failing?.tail).toContain("the suite is broken");
    expect(readFileSync(proof.failing?.log ?? "", "utf8")).toContain("the suite is broken");
    expectWorktreeGone(repo, proof);
    const [notice] = pendingNotices([], [], new Set(), { gates: [proof] });
    expect(notice.key).toBe(`proof:${proof.id}:failing`);
    expect(notice.text).toContain("factory: the gates of main fail");
    expect(notice.text).toContain("the suite is broken");
    expect(notice.text).not.toContain(caseDir);
  });

  test("a failing after_create hook fails the proof before any gate runs", async () => {
    const repo = repoWith(["hooks:", "  after_create:", '    - [sh, -c, "echo no packages here; exit 3"]', "merge_gates:", "  - [touch, never-run]", ""].join("\n"));
    const { answer, proof } = await prove(repo);
    expect(answer.attention).toEqual([proof.id]);
    expect(proof.state).toBe("failing");
    expect(proof.steps).toEqual([]);
    expect(proof.failing?.step).toBe("hooks.after_create");
    expect(proof.failing?.tail).toContain("no packages here");
    expectWorktreeGone(repo, proof);
  });

  test("a failing after_create hook's whole output is in the failing log, not its tail", async () => {
    const repo = repoWith(["hooks:", "  after_create:", '    - [sh, -c, "echo first line; seq 1 500; echo last line; exit 3"]', "merge_gates:", "  - [touch, never-run]", ""].join("\n"));
    const { proof } = await prove(repo);
    expect(proof.failing?.tail).not.toContain("first line");
    const log = readFileSync(proof.failing?.log ?? "", "utf8");
    expect(log).toContain("first line\n1\n2\n");
    expect(log).toContain("500\nlast line");
  });

  test("refused without a committed factory.yaml; gates.get of an unknown id is not_found", async () => {
    const repo = makeRepo(false);
    await expectError(callAction("gates.prove", {}, { cwd: repo }), "refused", "has no factory.yaml");
    await expectError(callAction("gates.prove", { branch: "nope" }, { cwd: repo }), "not_found", "no local branch nope");
    await expectError(callAction("gates.get", { id: "0000" }), "not_found", "no proof");
    await expectError(callAction("tasks.wait", { ids: ["0000"] }), "not_found", "no task");
  });

  test("a proof whose runner died without an end is interrupted and needs attention", async () => {
    const id = crypto.randomUUID();
    const dir = join(caseDir, "agent", "factory", "proofs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), `${JSON.stringify({ id, repo: caseDir, branch: "main", commit: "0".repeat(40), origin: ORIGIN, createdAt: "2026-01-01T00:00:00.000Z", unknown: 1 })}\n`);
    writeFileSync(join(dir, `${id}.pid`), "999999999 1\n");
    const answer = (await callAction("tasks.wait", { ids: [id] })) as WaitAnswer;
    expect(answer.attention).toEqual([id]);
    expect(answer.proofs[0]).toMatchObject({ state: "running", running: false, interrupted: true });
    expect(pendingNotices([], [], new Set(), { gates: answer.proofs }).map((notice) => notice.key)).toEqual([`proof:${id}:interrupted`]);
  });
});

describe("a proof whose runner is gone", () => {
  /** A proof of `repo` declared at `createdAt`, its runner noted as `pid` (none: no note). */
  function proofRecord(repo: string, createdAt: string, pid?: string): string {
    const id = crypto.randomUUID();
    const dir = join(caseDir, "agent", "factory", "proofs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), `${JSON.stringify({ id, repo, branch: "main", commit: git(repo, "rev-parse", "main"), origin: ORIGIN, createdAt })}\n`);
    if (pid !== undefined) writeFileSync(join(dir, `${id}.pid`), pid);
    return id;
  }

  const get = async (id: string) => ((await callAction("gates.get", { id })) as { proof: ProofView }).proof;

  test("no runner note: running while it may still be spawned, interrupted a few seconds after its declaration", async () => {
    const repo = repoWith("merge_gates: []\n");
    expect(await get(proofRecord(repo, new Date().toISOString()))).toMatchObject({ running: true, interrupted: false });
    expect(await get(proofRecord(repo, new Date(Date.now() - 60_000).toISOString()))).toMatchObject({ running: false, interrupted: true });
  });

  test("the runner notes itself: started without gates.prove, it reads as running, not interrupted", async () => {
    const repo = repoWith('merge_gates:\n  - [sh, -c, "sleep 2"]\n');
    const id = proofRecord(repo, "2026-01-01T00:00:00.000Z");
    const runner = Bun.spawn(["bun", PROOF_RUNNER_PATH, id], { env: process.env, stdout: "ignore", stderr: "ignore" });
    await Bun.sleep(1_000);
    expect(await get(id)).toMatchObject({ state: "running", running: true, interrupted: false });
    await runner.exited;
    expect(await get(id)).toMatchObject({ state: "passed", interrupted: false });
  });

  test("its leftover worktree is removed by the next gates.get of it and by the next gates.prove in its repo", async () => {
    const repo = repoWith("merge_gates: []\n");
    for (const act of [(id: string) => get(id), () => callAction("gates.prove", {}, { cwd: repo, origin: ORIGIN })]) {
      const id = proofRecord(repo, "2026-01-01T00:00:00.000Z", "999999999 1\n");
      const path = worktreePath(repo, `proof-${id.slice(0, 8)}`);
      git(repo, "worktree", "add", "--quiet", "--detach", path, "main");
      writeFileSync(join(path, "scratch.txt"), "left by the killed runner");
      await act(id);
      expect(existsSync(path)).toBe(false);
      expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(path);
    }
  });

  test("its runner is judged as the merge queue judges a ticket's owner, a zombie as gone", async () => {
    const repo = repoWith("merge_gates: []\n");
    const old = "2026-01-01T00:00:00.000Z";
    const own = `${process.pid} ${await procStart(process.pid)}\n`;
    expect(await get(proofRecord(repo, old, own))).toMatchObject({ running: true, interrupted: false });
    // A reused pid: the start time differs.
    expect(await get(proofRecord(repo, old, `${process.pid} 1\n`))).toMatchObject({ running: false, interrupted: true });
    // A child that ended and that its parent (exec'd into sleep) never reaps.
    const parent = Bun.spawn(["/bin/sh", "-c", "true & echo $!; exec /bin/sleep 5"], { stdout: "pipe" });
    try {
      const reader = parent.stdout.getReader();
      const pid = Number(new TextDecoder().decode((await reader.read()).value).trim());
      reader.releaseLock();
      await until(async () => (await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "")).includes(") Z "));
      expect(await get(proofRecord(repo, old, `${pid} ${await procStart(pid)}\n`))).toMatchObject({ running: false, interrupted: true });
    } finally {
      parent.kill();
    }
  });

  test("gates.prove reads only its repo's proofs and removes the records of those that rest and are older than PROOF_KEEP_MS", async () => {
    const repo = repoWith("merge_gates: []\n");
    const elsewhere = repoWith("merge_gates: []\n", "elsewhere");
    const long = new Date(Date.now() - PROOF_KEEP_MS - 60_000).toISOString();
    const ended = (id: string) => appendFileSync(join(proofsDir(), `${id}.jsonl`), `${JSON.stringify({ kind: "end", state: "passed", at: long })}\n`);
    const oldEnded = proofRecord(repo, long, "999999999 1\n");
    ended(oldEnded);
    const oldInterrupted = proofRecord(repo, long, "999999999 1\n");
    const recent = proofRecord(repo, new Date(Date.now() - 60_000).toISOString(), "999999999 1\n");
    ended(recent);
    const otherRepo = proofRecord(elsewhere, long, "999999999 1\n");
    ended(otherRepo);
    await callAction("gates.prove", {}, { cwd: repo, origin: ORIGIN });
    for (const id of [oldEnded, oldInterrupted]) {
      expect(existsSync(join(proofsDir(), `${id}.jsonl`))).toBe(false);
      expect(existsSync(join(proofsDir(), `${id}.pid`))).toBe(false);
    }
    for (const id of [recent, otherRepo]) expect(existsSync(join(proofsDir(), `${id}.jsonl`))).toBe(true);
  });
});
