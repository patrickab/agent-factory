/** Gate proofs: a branch's merge_gates proven in the background (`gates-prove.ts`). */
import { proofCard, safeCard } from "./cards.ts";
import { proofBlock, proofHeader } from "./agent-view.ts";
import { feature, REPO, spec } from "./feature.ts";
import type { Handlers } from "./feature.ts";
import { PROOF_HANDLERS, type ProofView } from "./gates-prove.ts";
import type { Notice } from "./notify.ts";

/** An ended or interrupted proof of a Pi session: key `proof:<id>:<event>`. */
function proofNotices(proofs: readonly ProofView[]): Notice[] {
  const notices: Notice[] = [];
  for (const proof of proofs) {
    if (proof.origin === null || (proof.state === "running" && !proof.interrupted)) continue;
    const event = proof.interrupted ? "interrupted" : proof.state;
    const what = event === "passed" ? "pass" : event === "flaky" ? "pass, flaky" : event === "failing" ? "fail" : "were interrupted";
    const title = `the gates of ${proof.branch} ${what}`;
    const tone = event === "failing" || event === "interrupted" ? "attention" : "quiet";
    notices.push({ key: `proof:${proof.id}:${event}`, origin: proof.origin, text: `factory: ${title}\n${proofBlock(proof)}`, card: safeCard("proof", title, () => proofCard(proof, title, tone)) });
  }
  return notices;
}

export const GATES = feature({
  name: "gates",
  actions: {
    "gates.prove": spec(
      "Prove a branch's merge_gates in the background: a fresh worktree of its tip (hooks.after_create run), every step once more when it fails; passed, flaky (passed on the rerun, with the failing test names) or failing. Reported to the declaring Pi session; tasks.wait {ids} watches it. Answers {proof}",
      { repo: REPO, branch: { type: "string", description: "The branch whose tip is proven. Default: the repository's branch" } },
      ["repo"],
      true,
    ),
  },
  get handlers(): Handlers {
    return PROOF_HANDLERS;
  },
  renderers: {
    "gates.prove": (_params, result: { proof: ProofView }) => `started ${proofHeader(result.proof)}`,
  },
  cards: {
    "gates.prove": (_params, result: { proof: ProofView }) => proofCard(result.proof, `proving the gates of ${result.proof.branch}`),
  },
  notices: (items) => proofNotices(items as readonly ProofView[]),
  toolBlurb: '"gates.prove" runs a branch\'s merge_gates in the background before a wave is declared on it: passed, flaky or failing.',
});
