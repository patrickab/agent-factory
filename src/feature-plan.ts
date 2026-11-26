/** `tasks.update`, `waves.update`: a declared plan adjusted (`core-plan.ts`). */
import { decision, waveCard } from "./cards.ts";
import { waveReceipt } from "./agent-view.ts";
import { PLAN_HANDLERS } from "./core-plan.ts";
import { feature, ID, spec, WAVE_ID } from "./feature.ts";
import type { Handlers } from "./feature.ts";
import type { WaveView } from "./waves.ts";

/** How a changed task learns of it, by `delivery`. */
const TOLD: Record<string, string> = { pending: "starts with it", sent: "its coder was told", kept: "its coder is told at its next turn", starting: "its coder is told as it starts" };

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
      return waveReceipt("", result.wave, [`task ${result.key} updated, ${TOLD[result.delivery] ?? result.delivery}`]);
    },
    "waves.update": (_params, result: { wave: WaveView; changed: boolean }) => waveReceipt("", result.wave, [result.changed ? "updated, the next review reads it" : "nothing changed"]),
  },
  cards: {
    "tasks.update": (params, result: { wave: WaveView; key: string; changed: boolean; delivery: string }) => {
      if (!result.changed) return decision(waveCard(result.wave, ""), `task ${result.key}: nothing changed`, undefined, []);
      const rows = [
        ...(typeof params.title === "string" ? [{ label: "title", text: params.title }] : []),
        ...(Array.isArray(params.after) ? [{ label: "after", text: params.after.join(", ") || "none" }] : []),
        ...(typeof params.model === "string" ? [{ label: "model", text: params.model }] : []),
        { label: "delivery", text: TOLD[result.delivery] ?? result.delivery },
      ];
      return decision(waveCard(result.wave, ""), `updated task ${result.key} of wave ${result.wave.tag}`, typeof params.request === "string" ? params.request : undefined, rows);
    },
    "waves.update": (params, result: { wave: WaveView; changed: boolean }) =>
      decision(
        waveCard(result.wave, ""),
        result.changed ? `updated wave ${result.wave.tag}` : `wave ${result.wave.tag}: nothing changed`,
        typeof params.request === "string" ? params.request : undefined,
        typeof params.title === "string" ? [{ label: "title", text: params.title }] : [],
      ),
  },
  toolBlurb:
    '"tasks.update" and "waves.update" adjust a declared plan (a pending task fully, a started one its title and request); coders report what cost runtime or context with their feedback tool, "waves.get" lists it.',
});
