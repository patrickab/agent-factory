/** `decisions.list`: a session's decisions in order (`decisions.ts`, contract `cards`). */
import { plural } from "./agent-view.ts";
import { card } from "./cards.ts";
import { nonEmpty } from "./core-shared.ts";
import { readDecisions, type DecisionEntry } from "./decisions.ts";
import { feature, spec } from "./feature.ts";
import type { Handlers } from "./feature.ts";
import { FactoryError, short } from "./util.ts";

type Listed = { decisions: DecisionEntry[] };

/** A notice key (`notify.ts`: `<task|wave>:<id>:<event>:...`) as the agent reads it: `wave 3f2a91c0 rejected`. */
function answered(key: string): string {
  const [kind, id, event] = key.split(":");
  return event === undefined ? short(key) : `${kind} ${short(id)} ${event}`;
}

const HANDLERS: Handlers = {
  "decisions.list": async (params, { origin }) => {
    const session = nonEmpty(params.origin) ?? origin;
    if (session === undefined) throw new FactoryError("invalid", "decisions.list needs origin, the session's id, outside a Pi session");
    return { decisions: await readDecisions(session) };
  },
};

export const DECISIONS = feature({
  name: "decisions",
  actions: {
    "decisions.list": spec(
      "The decisions of a session in order: the supervisor's actions that settle something, each with the notice key it answers. Answers {decisions: {at, card}[]}, card.answers the notice key",
      { origin: { type: "string", description: "The session's id. Default: the calling session" } },
      [],
      false,
      (_params, result: Listed) =>
        card("action", "quiet", result.decisions.length === 0 ? "no decisions" : plural(result.decisions.length, "decision"), {
          rows: result.decisions.map((entry, index) => ({ label: String(index + 1), text: `${entry.card.title}${entry.card.answers === undefined ? "" : `  answers ${answered(entry.card.answers)}`}` })),
        }),
    ),
  },
  get handlers(): Handlers {
    return HANDLERS;
  },
  toolBlurb: '"decisions.list" lists the decisions of a session (your settling actions and what each answers).',
});
