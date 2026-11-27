/**
 * The `factory` tool as every harness offers it (the Pi extension's `pi/tool.ts`, the MCP server `mcp.ts`): its name,
 * description and JSON schema, built from `ACTIONS`, and its answer, the agent view (`agent-view.ts`), so the harnesses
 * cannot drift apart.
 *
 * - The description: an opening sentence, the features' `toolBlurb`s (`features.ts`), how answers work
 * - `agentActions`: every `ACTIONS` name with a view (`tasks.timeline` has none: programs replay it through the core
 *   or the CLI); in a task session only those with `mutates: false`
 * - `factoryToolParameters`: `action` (one of them) plus the union of their params
 * - `callFactoryTool`: one tool call, `{action, ...params}`, refusing an action the agent is not offered. Answers the
 *   full view as `result`, its card and the agent's text of it (`actionView`); a failure throws (`factoryToolError`
 *   renders it)
 * - `actionView(name, params, result, cause?)`: the card of a result from its action's view and its text, never
 *   throwing (`present`): the agent must not retry what already happened
 * - A decision (contract `cards`): before the action runs, its `decides` reads the cause from state
 *   (`decisions.ts`); a cause that cannot be read leaves a decision that answers nothing. After it succeeded the card is a
 *   decision and, with an `origin`, appended to that session's log. A log that fails
 *   never fails the answer: the action happened
 */
import { agentError } from "./agent-view.ts";
import { present, type FactoryCard } from "./cards.ts";
import { ACTIONS, callAction, FactoryError, type ActionName, type CallOptions } from "./core.ts";
import type { Params } from "./core-shared.ts";
import { appendDecision, type Cause } from "./decisions.ts";
import type { ActionSpec, View } from "./feature.ts";
import { FEATURES } from "./features.ts";
import { errorText, isRecord } from "./util.ts";

type Schema = Record<string, unknown>;

export const FACTORY_TOOL_NAME = "factory";

/** The opening sentence, then each feature's (`toolBlurb`, in the features' order), then how answers work. */
export const FACTORY_TOOL_DESCRIPTION = [
  "Run coding work in the background: a task codes in its own git worktree of a repository with a committed factory.yaml, passes its gates and merges into its target.",
  ...FEATURES.flatMap((feature) => feature.toolBlurb ?? []),
  'Answers are short text: an id (8 chars are enough), the state, what matters in it, and "next:" with the actions valid now.',
  'Tasks and waves started from a Pi session report back to it when they need you; elsewhere block on "tasks.wait" (ids, tag or wave) instead of polling.',
  "A tag (path segments like plugin/m1/w1) groups related work for tasks.list, waves.list and tasks.wait.",
  "Every answer and notice also carries a card for the user, never in your context; an action that settles a question, rejection or block is recorded as a decision on its own: pass nothing for it.",
].join(" ");

/** The action `name` with its view and cause reader; undefined for a name that is none. */
const actionOf = (name: string): ActionSpec | undefined => (Object.hasOwn(ACTIONS, name) ? ACTIONS[name as ActionName] : undefined);

/** Whether an agent may call `name`: it has a view. */
export function hasView(name: string): boolean {
  return actionOf(name)?.view !== undefined;
}

/** The actions an agent may call: those with a view; in a task session only those with `mutates: false`. */
export function agentActions(taskSession = false): ActionName[] {
  return (Object.keys(ACTIONS) as ActionName[]).filter((name) => hasView(name) && !(taskSession && ACTIONS[name].mutates));
}

/** `action` and the union of the actions' params. A param several actions share names each of them in its description. */
export function factoryToolParameters(taskSession = false): { type: "object"; required: ["action"]; properties: Record<string, Schema> } {
  const names = agentActions(taskSession);
  const shared = new Map<string, { schema: Schema; uses: { action: ActionName; description: unknown }[] }>();
  for (const name of names) {
    for (const [key, schema] of Object.entries(ACTIONS[name].params.properties as Record<string, Schema>)) {
      const entry = shared.get(key) ?? { schema, uses: [] };
      entry.uses.push({ action: name, description: schema.description });
      shared.set(key, entry);
    }
  }
  const properties: Record<string, Schema> = {
    action: { type: "string", enum: names, description: names.map((name) => `${name}: ${ACTIONS[name].summary}`).join(". ") },
  };
  for (const [key, { schema, uses }] of shared) {
    const descriptions = new Set(uses.map((use) => use.description));
    const description =
      descriptions.size === 1 && uses[0].description !== undefined
        ? `${uses.map((use) => use.action).join(", ")}: ${String(uses[0].description)}`
        : uses.map((use) => (use.description === undefined ? use.action : `${use.action}: ${String(use.description)}`)).join(". ");
    properties[key] = { ...schema, description };
  }
  return { type: "object", required: ["action"], properties };
}

/**
 * Runs one `factory` tool call: `result` the full view, `card` and `text` its view (`actionView`). An action the agent
 * is not offered (a timeline, a mutating one in a task session) is as unknown as a made-up one.
 */
export async function callFactoryTool(params: unknown, taskSession: boolean, options: CallOptions): Promise<{ text: string; result: unknown; card: FactoryCard }> {
  const { action, ...rest } = isRecord(params) ? params : {};
  const name = String(action);
  if (!(agentActions(taskSession) as string[]).includes(name)) throw new FactoryError("invalid", `unknown action "${name}"`);
  const cause = await causeOf(name, rest, options);
  const result = await callAction(name, rest, options);
  const { card, text } = actionView(name, rest, result, cause);
  if (cause !== null && options.origin !== undefined) {
    await appendDecision(options.origin, { at: new Date().toISOString(), card }).catch(() => undefined);
  }
  return { text, result, card };
}

/** The cause `name` settles (its `decides`), read before it runs; null when it is no decision. */
async function causeOf(name: string, params: Params, options: CallOptions): Promise<Cause | null> {
  const decides = actionOf(name)?.decides;
  if (decides === undefined) return null;
  try {
    return await decides(params, { cwd: options.cwd, signal: options.signal, env: options.env, origin: options.origin });
  } catch {
    return {};
  }
}

/**
 * The card of `name`'s result from its view, and the agent's text of it; with a cause (`decisions.ts`) the
 * card is a decision, answering the notice key the cause names. A view that fails is a receipt, never a failure.
 */
export function actionView(name: string, params: unknown, result: unknown, cause: Cause | null = null): { card: FactoryCard; text: string } {
  const failed = `${name} done; its answer could not be shown, do not repeat it: look with tasks.get, waves.get or the lists`;
  return present(() => {
    const built = (ACTIONS[name as ActionName].view as View)((params ?? {}) as Params, result as never);
    if (cause === null) return built;
    const [first, ...more] = [built].flat();
    const { answers: _answers, ...rest } = first;
    return [{ ...rest, kind: "decision", ...(cause.answers === undefined ? {} : { answers: cause.answers }) }, ...more];
  }, failed, name.startsWith("repos."));
}

/** A failed tool call as the agent's one line (`agentError`); an error that is not a `FactoryError` is `failed`. */
export function factoryToolError(error: unknown): string {
  if (error instanceof FactoryError) return agentError({ code: error.code, message: error.message, detail: error.detail });
  return agentError({ code: "failed", message: errorText(error) });
}
