/** Scouts: read-only pi children that answer a concern from a memory store's map (`core-scouts.ts`). */
import { safeCard, scoutCard, shortId } from "./cards.ts";
import { SCOUT_HANDLERS } from "./core-scouts.ts";
import { feature, spec } from "./feature.ts";
import type { Handlers } from "./feature.ts";
import { scoutNoticeKey, type Notice } from "./notify.ts";
import { scoutBlock, SCOUT_RENDERERS } from "./scout-view.ts";
import type { ScoutView } from "./scouts.ts";

function scoutNotice(scout: ScoutView): Notice | null {
  if (scout.caller.kind !== "session" || scout.caller.id === null) return null;
  const ended = scout.state === "done" || scout.state === "failed" || scout.state === "cancelled";
  if (!ended && !scout.interrupted) return null;
  let what: string = scout.state === "done" ? "reported" : scout.state;
  if (scout.interrupted) what = "was interrupted";
  const path = scout.reportPath === null ? "" : `\nreport: ${scout.reportPath}`;
  const title = `scout ${scout.id.slice(0, 8)} ${what}`;
  return { key: scoutNoticeKey(scout.id), origin: scout.caller.id, text: `factory: ${title}\n${scoutBlock(scout)}${path}`, card: safeCard("scout", title, () => scoutCard(scout, title)) };
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
    ),
    "scouts.get": spec("One scout: caller, concern, state, usage, report, the map paths it wrote. Answers {scout}", { id: { type: "string", description: "The scout id or a unique prefix of it" } }, ["id"], false),
  },
  get handlers(): Handlers {
    return SCOUT_HANDLERS;
  },
  renderers: SCOUT_RENDERERS,
  cards: {
    "scouts.start": (_params, result: { scout: ScoutView; timedOut: boolean }) =>
      scoutCard(result.scout, result.scout.report !== null ? `scout ${shortId(result.scout.id)} reported` : result.timedOut ? `scout ${shortId(result.scout.id)}: the wait ended before the report` : `started scout ${shortId(result.scout.id)}`),
    "scouts.get": (_params, result: { scout: ScoutView }) => scoutCard(result.scout, `scout ${shortId(result.scout.id)}`),
  },
  notices: (items) => (items as readonly ScoutView[]).flatMap((scout) => scoutNotice(scout) ?? []),
  toolBlurb: '"scouts.start" sends a read-only scout that answers a concern from the map of a memory store (wait: true for its report, else it reports back).',
});
