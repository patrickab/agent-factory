import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callAction } from "./core.ts";
import { caseDir, git, makeRepo, useCoreFixture } from "./core-test-kit.ts";
import { proofView, type ProofView } from "./gates-prove.ts";
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
  return { started, answer, proof: await proofView(started.id) };
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
    expect(started.commit).toBe(git(repo, "rev-parse", "main"));
    expect([answer.timedOut, answer.attention]).toEqual([false, []]);
    expect(proof).toMatchObject({ state: "passed", flaky: [], failing: null, interrupted: false, origin: ORIGIN });
    expect(proof.steps.map((step) => [step.command.split(" ")[0], step.passed])).toEqual([
      ["test", true],
      ["sh", true],
    ]);
    expectWorktreeGone(repo, proof);
    expect(pendingNotices([], [], new Set(), { gates: [proof] }).map((notice) => [notice.key, notice.origin])).toEqual([[`proof:${proof.id}:passed`, ORIGIN]]);
  });

  test("failing: a step that fails twice stops the proof, needs attention, keeps its output in a log", async () => {
    const repo = repoWith(['merge_gates:', '  - [sh, -c, "echo the suite is broken; exit 1"]', "  - [touch, never-run]", ""].join("\n"));
    const { answer, proof } = await prove(repo);
    expect(answer.attention).toEqual([proof.id]);
    expect(proof.state).toBe("failing");
    expect(proof.steps).toHaveLength(1);
    expect(readFileSync(proof.failing?.log ?? "", "utf8")).toContain("the suite is broken");
    expectWorktreeGone(repo, proof);
    const [notice] = pendingNotices([], [], new Set(), { gates: [proof] });
    expect(notice.key).toBe(`proof:${proof.id}:failing`);
    expect(notice.text).not.toContain(caseDir);
  });
});
