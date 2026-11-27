/** `decisions.list`: a session's decisions in order (`decisions.ts`, contract `cards`). */
import { plural, short } from "./agent-view.ts";
import { card } from "./cards.ts";
import { FactoryError, nonEmpty } from "./core-shared.ts";
import { readDecisions, type DecisionEntry } from "./decisions.ts";
import { feature, spec } from "./feature.ts";
import type { Handlers } from "./feature.ts";

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
    ),
  },
  get handlers(): Handlers {
    return HANDLERS;
  },
  renderers: {
    "decisions.list": (_params, result: Listed) =>
      result.decisions.length === 0
        ? "no decisions"
        : [plural(result.decisions.length, "decision"), ...result.decisions.map((entry, index) => `  ${index + 1}. ${entry.card.title}${entry.card.answers === undefined ? "" : `  answers ${answered(entry.card.answers)}`}`)].join("\n"),
  },
  cards: {
    "decisions.list": (_params, result: Listed) =>
      card("action", "quiet", result.decisions.length === 0 ? "no decisions" : plural(result.decisions.length, "decision"), {
        rows: result.decisions.map((entry) => ({ label: entry.at, text: entry.card.title })),
      }),
  },
  toolBlurb: '"decisions.list" lists the decisions of a session (your settling actions and what each answers).',
});
