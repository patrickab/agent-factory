/** `tasks.wait`: a supervisor's completion signal (`core-wait.ts`). */
import { waitView, type WaitResult } from "./agent-view.ts";
import { WAIT_TIMEOUT_MS } from "./core-shared.ts";
import { WAIT_HANDLERS } from "./core-wait.ts";
import { feature, spec, TAG_FILTER } from "./feature.ts";
import type { Handlers } from "./feature.ts";

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
        ignore: { type: "array", items: { type: "string" }, description: "Task or wave ids (or prefixes) left out of the watched ones" },
        timeoutMs: { type: "integer", minimum: WAIT_TIMEOUT_MS.minimum, maximum: WAIT_TIMEOUT_MS.maximum, description: `Default: ${WAIT_TIMEOUT_MS.default}` },
      },
      [],
      false,
    ),
  },
  get handlers(): Handlers {
    return WAIT_HANDLERS;
  },
  renderers: {
    "tasks.wait": (params, result: WaitResult) => waitView(params, result),
  },
});
