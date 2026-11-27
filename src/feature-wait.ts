/** `tasks.wait`: a supervisor's completion signal (`core-wait.ts`). */
import { card, proofCard, taskCard, taskState, waveCard, waveState } from "./cards.ts";
import { WAIT_TIMEOUT_MS } from "./core-shared.ts";
import { WAIT_HANDLERS, type WaitAnswer } from "./core-wait.ts";
import { feature, spec, TAG_FILTER } from "./feature.ts";
import type { Handlers } from "./feature.ts";
import { short } from "./util.ts";

export const WAIT = feature({
  name: "wait",
  actions: {
    "tasks.wait": spec(
      "Wait until the watched tasks and waves rest or one needs attention, or the timeout passes. A task rests with no runner in waiting_approve, waiting_answer, blocked, done or cancelled, or interrupted; it needs attention resting and not done (a cancelled task of a watched wave left the wave and needs none). A wave rests merged or cancelled; it needs attention rejected, blocked, waiting_approve, interrupted, or building with tasks that can never start (a task they wait for was cancelled or removed) while none of its tasks runs, or queued after a wave that was cancelled; a queued wave that can still start keeps the wait going; its tasks resting while it builds, reviews or merges is not the end. Answers {tasks, waves, attention: task and wave ids, timedOut}",
      {
        ids: { type: "array", items: { type: "string" }, description: "Watch these tasks (ids or unique prefixes); give exactly one of ids, tag and wave" },
        tag: {
          ...TAG_FILTER,
          description: "Watch the tasks and the waves whose tag is this one or lies under it, those started during the wait too; give exactly one of ids, tag and wave",
        },
        wave: { type: "string", description: "Watch this wave (id or unique prefix) and its tasks; give exactly one of ids, tag and wave" },
        timeoutMs: { type: "integer", minimum: WAIT_TIMEOUT_MS.minimum, maximum: WAIT_TIMEOUT_MS.maximum, description: `Default: ${WAIT_TIMEOUT_MS.default}` },
      },
      [],
      false,
      // One row per watched subject, then the cards of those that need attention: the agent reads them in full.
      (params, result: WaitAnswer) => {
        const wanted = new Set(result.attention);
        const proofs = result.proofs ?? [];
        const shownWaves = new Set(result.waves.map((wave) => wave.id));
        const rows = [
          ...result.waves.map((wave) => ({ label: `wave ${short(wave.id)}`, text: `${waveState(wave)}  ${wave.counts.done}/${wave.counts.total}  ${wave.tag}` })),
          ...result.tasks.filter((task) => task.wave === null || !shownWaves.has(task.wave)).map((task) => ({ label: `task ${short(task.id)}`, text: `${taskState(task)}  ${task.title}` })),
          ...proofs.map((proof) => ({ label: `proof ${short(proof.id)}`, text: `${proof.interrupted ? "interrupted" : proof.state}  ${proof.branch}` })),
        ];
        const timeout = typeof params.timeoutMs === "number" ? params.timeoutMs : WAIT_TIMEOUT_MS.default;
        const title = result.timedOut ? `the wait timed out after ${Math.round(timeout / 1000)} s` : wanted.size > 0 ? `${wanted.size} need${wanted.size === 1 ? "s" : ""} a ruling` : rows.length === 0 ? "nothing to wait for" : "everything rests";
        return [
          card("action", wanted.size > 0 ? "attention" : "quiet", title, { rows }),
          ...result.waves.filter((wave) => wanted.has(wave.id)).map((wave) => waveCard(wave, `wave ${wave.tag}`, "attention")),
          ...result.tasks.filter((task) => wanted.has(task.id)).map((task) => taskCard(task, `task ${short(task.id)}`, "attention")),
          ...proofs.filter((proof) => wanted.has(proof.id)).map((proof) => proofCard(proof, `the gates of ${proof.branch}`, "attention")),
        ];
      },
    ),
  },
  get handlers(): Handlers {
    return WAIT_HANDLERS;
  },
});
