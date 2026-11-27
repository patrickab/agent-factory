/** Scouts: read-only pi children that answer a concern from a memory store's map (`core-scouts.ts`). */
import { scoutCard } from "./cards.ts";
import { SCOUT_HANDLERS } from "./core-scouts.ts";
import { feature, spec } from "./feature.ts";
import type { Handlers } from "./feature.ts";
import { notice, scoutNoticeKey, type Notice } from "./notify.ts";
import { FINAL_SCOUT_STATES, type ScoutView } from "./scouts.ts";
import { short } from "./util.ts";

/** `scout <id> reported`, or how else it ended. */
export function scoutEndTitle(scout: ScoutView): string {
  return `scout ${short(scout.id)} ${scout.interrupted ? "was interrupted" : scout.state === "done" ? "reported" : scout.state}`;
}

function scoutNotice(scout: ScoutView): Notice | null {
  if (scout.caller.kind !== "session" || scout.caller.id === null) return null;
  const ended = FINAL_SCOUT_STATES.includes(scout.state);
  if (!ended && !scout.interrupted) return null;
  const title = scoutEndTitle(scout);
  return notice(scoutNoticeKey(scout.id), scout.caller.id, title, () => scoutCard(scout, title));
}

export const SCOUTS = feature({
  name: "scouts",
  actions: {
    "scouts.start": spec(
      "Start a scout: a read-only pi child on the project's small model in the caller's working directory that answers a concern from the map (memory-store map/ of the task's or wave's plan, else store), explores where the map is not current, writes what it learns there and reports MISSING / DECISIONS / KEY FACTS / MEMORY. At most four of a caller run, more queue. Answers {scout, timedOut}",
      {
        concern: { type: "string", description: "What the scout finds out" },
        questions: { type: "array", items: { type: "string" }, description: "Questions the report answers" },
        wait: { type: "boolean", description: "Answer once the scout reported, after 15 minutes at the latest with what it wrote so far; default false: answer with its id at once" },
        store: { type: "string", description: "The memory-store whose map/ the scout reads and writes; a task's or wave's plan wins" },
        repo: { type: "string", description: "The directory the scout explores. Default: the current directory" },
      },
      ["concern"],
      true,
      (_params, result: { scout: ScoutView; timedOut: boolean }) =>
        scoutCard(result.scout, result.scout.report !== null ? `scout ${short(result.scout.id)} reported` : result.timedOut ? `scout ${short(result.scout.id)}: the wait ended before the report` : `started scout ${short(result.scout.id)}`),
    ),
    "scouts.get": spec(
      "One scout: caller, concern, state, usage, report, the map paths it wrote. Answers {scout}",
      { id: { type: "string", description: "The scout id or a unique prefix of it" } },
      ["id"],
      false,
      (_params, result: { scout: ScoutView }) => scoutCard(result.scout, `scout ${short(result.scout.id)}`),
    ),
  },
  get handlers(): Handlers {
    return SCOUT_HANDLERS;
  },
  notices: (items) => (items as readonly ScoutView[]).flatMap((scout) => scoutNotice(scout) ?? []),
  toolBlurb: '"scouts.start" sends a read-only scout that answers a concern from the map of a memory store (wait: true for its report, else it reports back).',
});
