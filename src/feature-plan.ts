/** `tasks.update`, `waves.update`: a declared plan adjusted (`core-plan.ts`). */
import { waveReceipt } from "./agent-view.ts";
import { PLAN_HANDLERS } from "./core-plan.ts";
import { feature, ID, spec, WAVE_ID } from "./feature.ts";
import type { Handlers } from "./feature.ts";
import type { WaveView } from "./waves.ts";

export const PLAN = feature({
  name: "plan",
  actions: {
    "tasks.update": spec(
      "Change a task of a wave: a pending one's title, request, after (keys of the wave, no cycle) and model; a running one's (or waiting_answer, blocked) title and request only, its coder is told old and new. Refused when done, cancelled or merging: add a task with waves.add. Answers {wave, key, changed, delivery}",
      {
        id: { ...ID, description: "The task id or a unique prefix of it, a pending task's too (waves.get shows it)" },
        title: { type: "string" },
        request: { type: "string", description: "The full, self-contained task for the coder" },
        after: { type: "array", items: { type: "string" }, description: "Keys of the wave this task waits for (pending only)" },
        model: { type: "string", enum: ["small", "big"], description: "Which of the wave's models its coder runs with (pending only)" },
      },
      ["id"],
      true,
    ),
    "waves.update": spec(
      "Change a wave's title or its reviewer's instructions (request) before it is merged or cancelled; a review that runs keeps the text it started with. Answers {wave, changed}",
      { id: WAVE_ID, title: { type: "string" }, request: { type: "string", description: "The reviewer's instructions for the wave's whole diff" } },
      ["id"],
      true,
    ),
  },
  get handlers(): Handlers {
    return PLAN_HANDLERS;
  },
  renderers: {
    "tasks.update": (_params, result: { wave: WaveView; key: string; changed: boolean; delivery: string }) => {
      if (!result.changed) return waveReceipt("", result.wave, [`task ${result.key}: nothing changed`]);
      const told: Record<string, string> = { pending: "starts with it", sent: "its coder was told", kept: "its coder is told at its next turn", starting: "its coder is told as it starts" };
      return waveReceipt("", result.wave, [`task ${result.key} updated, ${told[result.delivery] ?? result.delivery}`]);
    },
    "waves.update": (_params, result: { wave: WaveView; changed: boolean }) => waveReceipt("", result.wave, [result.changed ? "updated, the next review reads it" : "nothing changed"]),
  },
  toolBlurb:
    '"tasks.update" and "waves.update" adjust a declared plan (a pending task fully, a started one its title and request); coders report what cost runtime or context with their feedback tool, "waves.get" lists it.',
});
