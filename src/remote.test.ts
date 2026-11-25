import { describe, expect, test } from "bun:test";
import { commentReview, forgeOf, publishMerge, publishWave, reviewComment } from "./remote.ts";
import type { Exec } from "./run.ts";

describe("remote", () => {
  test("the forge of an origin URL", () => {
    expect(forgeOf("https://github.com/acme/app.git")).toBe("github");
    expect(forgeOf("git@github.com:acme/app.git")).toBe("github");
    expect(forgeOf("ssh://git@gitlab.example.com:2222/acme/app.git")).toBe("gitlab");
    expect(forgeOf("https://git.example.com/acme/app.git")).toBeNull();
    expect(forgeOf("/srv/git/app.git")).toBeNull();
  });

  test("a review's comment: verdict and one line per finding", () => {
    expect(reviewComment({ round: 2, verdict: "approved", status: "ok", findings: [] })).toBe("**Factory review, round 2: approved**\n\nNo findings.\n");
    expect(reviewComment({ round: 1, verdict: "rejected", status: "ok", findings: [{ severity: "major", file: "a.ts", line: null, text: "wrong" }] })).toBe(
      "**Factory review, round 1: rejected**\n\n- **major** `a.ts`: wrong\n",
    );
  });

  test("off: no command runs at all", async () => {
    const ran: string[][] = [];
    const exec: Exec = async (argv) => {
      ran.push(argv);
      throw new Error("no command may run");
    };
    const wave = { id: "x", repo: "/r", title: "t", request: "r", tag: "a/b", branch: "main-a-b", target: "main", overrides: {}, remote: null };
    expect(await publishWave(wave, exec)).toBeNull();
    expect(await commentReview({ ...wave, remote: { number: 1, url: null, pushed: null, error: null } }, { round: 1, verdict: "approved", status: "ok", findings: [] }, exec)).toEqual({ number: 1, url: null, pushed: null, error: null });
    expect(await publishMerge(wave, exec)).toBeNull();
    expect(ran).toEqual([]);
  });
});
