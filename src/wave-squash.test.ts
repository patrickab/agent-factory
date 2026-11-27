/**
 * A `squash` wave lands as one commit (`wave-runner.ts` `merge`, `merge.ts` `squashCommit`), over real git repos in a
 * temp dir: the wave's tasks are records whose sessions say `done`, their work commits on the wave's branch, the
 * reviewer a fake `pi` on PATH that approves.
 */
import { describe, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { caseTests } from "./test-case.ts";
import { callAction } from "./core.ts";
import { lockWave, waveLockPath, wavePath } from "./wave-poke.ts";
import { unlockFile } from "./lock.ts";
import { runWave, waveCommitsRef } from "./wave-runner.ts";
import { BRANCH, caseDir, commit, getWave, reviewWorktree, TAG, useWaveFixture, WAVE, waveRepo } from "./wave-test-kit.ts";
import { readWave } from "./waves.ts";

const test = caseTests();
useWaveFixture();

function gitOk(cwd: string, ...args: string[]): boolean {
  try {
    git(cwd, ...args);
    return true;
  } catch {
    return false;
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const REF = () => waveCommitsRef({ id: WAVE(), tag: TAG });
const kinds = async () => (await readWave(WAVE())).events.map((event) => ("stage" in event ? event.stage : event.kind));
const branchExists = (repo: string) => gitOk(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH}`);

/** Cuts the wave's log back to before its `merge` event: as if its runner died after the target moved. */
function forgetLanding(): void {
  const lines = readFileSync(wavePath(WAVE()), "utf8").split("\n").filter(Boolean);
  const at = lines.findIndex((line) => (JSON.parse(line) as { kind?: string }).kind === "merge");
  expect(at).toBeGreaterThan(0);
  writeFileSync(wavePath(WAVE()), `${lines.slice(0, at).join("\n")}\n`);
}

/** What a landed squash wave of `subjects` on `from` must look like: one commit, the ref, no branch, one merge event. */
async function expectLanded(repo: string, from: string, subjects: string[]): Promise<void> {
  const wave = await getWave();
  expect(wave.stage).toBe("merged");
  const main = git(repo, "rev-parse", "main");
  expect(git(repo, "rev-parse", "main^")).toBe(from);
  expect(git(repo, "log", "--reverse", "--format=%s", `${from}..${REF()}`)).toBe(subjects.join("\n"));
  expect(git(repo, "rev-parse", "main^{tree}")).toBe(git(repo, "rev-parse", `${REF()}^{tree}`));
  expect(branchExists(repo)).toBe(false);
  expect(existsSync(reviewWorktree(repo))).toBe(false);
  expect(wave.merge).toEqual({ at: expect.any(String), from, to: main, ref: REF(), commits: subjects.length });
  expect((await kinds()).filter((kind) => kind === "merge")).toHaveLength(1);
}

describe("a squash wave", () => {
  test("a rerun after the move, the branch still there: no second commit, the branch deleted, one merge event", async () => {
    const repo = await waveRepo(undefined, "done", { squash: true });
    const init = git(repo, "rev-parse", "main");
    expect(await runWave(WAVE())).toBe(0);
    const landed = git(repo, "rev-parse", "main");
    forgetLanding();
    git(repo, "branch", BRANCH, REF());
    expect(await runWave(WAVE())).toBe(0);
    expect(git(repo, "rev-parse", "main")).toBe(landed);
    await expectLanded(repo, init, ["feat: add b", "feat: add c"]);
  });

  test("a rerun after the branch was deleted: the landing is recognised from git, one merge event", async () => {
    const repo = await waveRepo(undefined, "done", { squash: true });
    const init = git(repo, "rev-parse", "main");
    expect(await runWave(WAVE())).toBe(0);
    const landed = git(repo, "rev-parse", "main");
    forgetLanding();
    expect(await runWave(WAVE())).toBe(0);
    expect(git(repo, "rev-parse", "main")).toBe(landed);
    await expectLanded(repo, init, ["feat: add b", "feat: add c"]);
  });

  test("the target moved between the merge gates and the move: rebased again, then one commit on the new tip", async () => {
    // The gate commits to main on its 2nd and 3rd run: after the review's run and after the merge's first.
    const count = join(caseDir, "gate-runs");
    const repoPath = join(caseDir, "repo");
    const gate = `echo run >> ${count}; n=$(wc -l < ${count}); if [ $n -ge 2 ] && [ $n -le 3 ]; then echo $n > ${repoPath}/m$n.txt && git -C ${repoPath} add m$n.txt && git -C ${repoPath} commit --quiet -m "main: m$n"; fi`;
    const repo = await waveRepo(`gates:\n  - ["true"]\nmerge_gates:\n  - ["sh", "-c", ${JSON.stringify(gate)}]\n`, "done", { squash: true, merge: "review" });
    await runWave(WAVE());
    expect((await getWave()).stage).toBe("waiting_approve");
    commit(repo, "d.txt", "d\n", "main: add d");
    // Held: the approve's poke starts no runner of its own.
    await lockWave(WAVE());
    try {
      await callAction("waves.approve", { id: WAVE() });
    } finally {
      await unlockFile(waveLockPath(WAVE()));
    }
    expect(await runWave(WAVE())).toBe(0);
    const runs = readFileSync(count, "utf8").split("\n").filter(Boolean).length;
    // The review's run, then the merge's three: two found the target moved after them.
    expect(runs).toBe(4);
    expect(git(repo, "log", "--format=%s", "main")).toBe("Wave one\nmain: m3\nmain: m2\nmain: add d\ninit");
    await expectLanded(repo, git(repo, "rev-parse", "main^"), ["feat: add b", "feat: add c"]);
  }, 30_000);

  test("squash off: the task commits land as they are, the branch stays, no ref, the merge event as before", async () => {
    const repo = await waveRepo();
    const init = git(repo, "rev-parse", "main");
    expect(await runWave(WAVE())).toBe(0);
    const wave = await getWave();
    expect(git(repo, "log", "--format=%s", "main")).toBe("feat: add c\nfeat: add b\ninit");
    expect(git(repo, "rev-parse", BRANCH)).toBe(git(repo, "rev-parse", "main"));
    expect(git(repo, "for-each-ref", "refs/factory/waves")).toBe("");
    expect(wave.merge).toEqual({ at: expect.any(String), from: init, to: git(repo, "rev-parse", "main") });
  });
});
