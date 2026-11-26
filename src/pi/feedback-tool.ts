/**
 * The tool `feedback {kind, what, cost?, suggestion?}`: an agent reports a problem that cost runtime or context.
 *
 * - Returns at once and never ends the turn: no `terminate`, no wake of anyone
 * - `context` says which task, wave and plan store the entry belongs to; the entry is stored as a fact (`feedback.ts`)
 *   and `keep` also puts it on the task (the session), so it stays there without a store
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FEEDBACK_KINDS, type FeedbackEntry, type FeedbackKind, storeFeedback } from "../feedback.ts";
import { errorText, isRecord } from "../util.ts";

export const FEEDBACK_TOOL = "feedback";

/** Whose feedback it is: null when the session holds neither task nor wave; `task` null for a wave's own. */
export interface FeedbackContext {
  task: string | null;
  wave: string | null;
  plan: string | null;
}

export interface FeedbackToolGate {
  role: string;
  context(ctx: ExtensionContext): Promise<FeedbackContext | null>;
  /** Puts the entry on the task. */
  keep(entry: FeedbackEntry): void;
}

export function registerFeedbackTool(pi: ExtensionAPI, gate: FeedbackToolGate): void {
  pi.registerTool({
    name: FEEDBACK_TOOL,
    label: "Feedback",
    description:
      "Report a problem with the factory's work: one call per problem, when it happens. Report what cost runtime or context: you read much and needed little, waited, repeated a command, had to guess or re-read. It returns at once and does not end your turn.",
    promptSnippet: "Report what cost runtime or context, one call per problem, when it happens",
    parameters: {
      type: "object",
      required: ["kind", "what"],
      properties: {
        kind: { type: "string", enum: [...FEEDBACK_KINDS], description: "What the problem concerns" },
        what: { type: "string", description: "What happened" },
        cost: { type: "string", description: 'What it cost, e.g. "2 avoidable reviewer and coder rounds"' },
        suggestion: { type: "string", description: "What would have avoided it" },
      },
    } as never,
    async execute(_toolCallId, params: unknown, _signal, _onUpdate, ctx) {
      const fail = (text: string) => ({ content: [{ type: "text" as const, text: `${FEEDBACK_TOOL}: ${text}` }], details: undefined, isError: true });
      const { kind, what, cost, suggestion } = isRecord(params) ? params : {};
      if (typeof kind !== "string" || !FEEDBACK_KINDS.includes(kind as FeedbackKind)) return fail(`kind must be one of ${FEEDBACK_KINDS.join(", ")}`);
      if (typeof what !== "string" || what.trim() === "") return fail("what must not be empty");
      const optional = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : null);
      try {
        const whose = await gate.context(ctx);
        if (whose === null || (!whose.task && !whose.wave)) return fail("this session holds no task");
        const entry: FeedbackEntry = { kind: kind as FeedbackKind, what, cost: optional(cost), suggestion: optional(suggestion), task: whose.task, wave: whose.wave, role: gate.role };
        gate.keep(entry);
        const stored = await storeFeedback(whose.plan, entry);
        return { content: [{ type: "text" as const, text: stored ? "Feedback recorded." : "Feedback recorded on the task." }], details: entry };
      } catch (error) {
        return fail(errorText(error));
      }
    },
  });
}
