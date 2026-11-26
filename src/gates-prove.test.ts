import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callAction } from "./core.ts";
import { caseDir, expectError, git, makeRepo, useCoreFixture } from "./core-test-kit.ts";
import type { ProofView } from "./gates-prove.ts";
import { worktreePath } from "./launch.ts";
import { pendingNotices } from "./notify.ts";

useCoreFixture();

const ORIGIN = "session-of-the-supervisor";

/** A repo on `main` whose `factory.yaml` holds `yaml`. */
function repoWith(yaml: string): string {
  const repo = makeRepo();
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
    const notices = pendingNotices([], [], new Set(), [], [proof]);
    expect(notices.map((notice) => [notice.key, notice.origin])).toEqual([[`proof:${proof.id}:passed`, ORIGIN]]);
    expect(notices[0].text).toStartWith("factory: the gates of main pass\nproof ");
    expect(pendingNotices([], [], new Set([`proof:${proof.id}:passed`]), [], [proof])).toEqual([]);
  });

  test("flaky: a step that fails and passes on its rerun names its failing tests; no attention", async () => {
    process.env.PROOF_MARK = join(caseDir, "failed-once");
    const repo = repoWith(['merge_gates:', '  - [sh, -c, "test -f \\"$PROOF_MARK\\" || { touch \\"$PROOF_MARK\\"; echo \\"(fail) a timing test\\"; exit 1; }"]', ""].join("\n"));
    const { answer, proof } = await prove(repo);
    expect(answer.attention).toEqual([]);
    expect(proof).toMatchObject({ state: "flaky", flaky: ["a timing test"], failing: null });
    expect(proof.steps[0]).toMatchObject({ passed: true, flaky: ["a timing test"] });
    expectWorktreeGone(repo, proof);
    const [notice] = pendingNotices([], [], new Set(), [], [proof]);
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
    const [notice] = pendingNotices([], [], new Set(), [], [proof]);
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
    expect(pendingNotices([], [], new Set(), [], answer.proofs).map((notice) => notice.key)).toEqual([`proof:${id}:interrupted`]);
  });
});
