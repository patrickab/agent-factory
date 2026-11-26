/**
 * The `factory` tool as every harness offers it (the Pi extension's `pi/tool.ts`, the MCP server `mcp.ts`): its name,
 * description and JSON schema, built from `ACTIONS`, and its answer, the agent view (`agent-view.ts`), so the harnesses
 * cannot drift apart.
 *
 * - The description: an opening sentence, the features' `toolBlurb`s (`features.ts`), how answers work
 * - `agentActions`: every `ACTIONS` name but the `hostOnly` ones and the timelines (`NOT_FOR_AGENTS`: they dump a
 *   log, programs replay it through the core or the CLI); in a task session only those with `mutates: false`
 * - `factoryToolParameters`: `action` (one of them) plus the union of their params
 * - `callFactoryTool`: one tool call, `{action, ...params}`, refusing an action the agent is not offered. Answers the
 *   agent view as `text`, the full view as `result` and its readable form as `card` (`cards.ts`); a failure throws
 *   (`factoryToolError` renders it). A view that fails to render after the action succeeded is a one-line receipt
 *   (`renderFailed`), never a failure: the agent must not retry what already happened; a card that fails is the
 *   action's name (`fallbackCard`)
 * - `factoryCard(name, params, result, cause?)`: the card of a result, never throwing
 * - A decision (contract `cards`): before the action runs, its feature's `decides` reads the cause from state
 *   (`decisions.ts`); a cause that cannot be read leaves a decision that answers nothing. After it succeeded the card is a
 *   decision and, with an `origin`, appended to that session's log (`key`: the caller's `callId`). A log that fails
 *   never fails the answer: the action happened
 */
import { agentError, agentView } from "./agent-view.ts";
import { actionCard, fallbackCard, type FactoryCard } from "./cards.ts";
import { ACTIONS, callAction, FactoryError, type ActionName, type CallOptions } from "./core.ts";
import type { Params } from "./core-shared.ts";
import { appendDecision, type Cause } from "./decisions.ts";
import type { CauseReader } from "./feature.ts";
import { FEATURES } from "./features.ts";
import { errorText, isRecord } from "./util.ts";

type Schema = Record<string, unknown>;

export const FACTORY_TOOL_NAME = "factory";

/** Actions the agent's tool never offers: they dump a log instead of deciding or answering something. */
const NOT_FOR_AGENTS: readonly string[] = ["tasks.timeline", "waves.timeline"];

/** The opening sentence, then each feature's (`toolBlurb`, in the features' order), then how answers work. */
export const FACTORY_TOOL_DESCRIPTION = [
  "Run coding work in the background: a task codes in its own git worktree of a repository with a committed factory.yaml, passes its gates and merges into its target.",
  ...FEATURES.flatMap((feature) => feature.toolBlurb ?? []),
  'Answers are short text: an id (8 chars are enough), the state, what matters in it, and "next:" with the actions valid now.',
  'Tasks and waves started from a Pi session report back to it when they need you; elsewhere block on "tasks.wait" (ids, tag or wave) instead of polling.',
  "A tag (path segments like plugin/m1/w1) groups related work for tasks.list, waves.list and tasks.wait.",
].join(" ");

/** The actions an agent may call: every one but the `hostOnly` ones and the timelines; in a task session only those with `mutates: false`. */
export function agentActions(taskSession = false): ActionName[] {
  return (Object.keys(ACTIONS) as ActionName[]).filter((name) => !ACTIONS[name].hostOnly && !NOT_FOR_AGENTS.includes(name) && !(taskSession && ACTIONS[name].mutates));
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

/** The id an answer names (`{wave}`, `{task}`, a task view, `{removed}`), for a receipt. */
function answerId(result: unknown): string | null {
  if (!isRecord(result)) return null;
  for (const inner of [result.wave, result.task, result]) {
    if (isRecord(inner) && typeof inner.id === "string") return inner.id.slice(0, 8);
  }
  return typeof result.removed === "string" ? result.removed.slice(0, 8) : null;
}

/** The one line an agent gets when the view of a succeeded action fails to render. */
function renderFailed(name: string, result: unknown, error: unknown): string {
  const id = answerId(result);
  return `${name} done${id === null ? "" : ` (${id})`}; its answer could not be shown (${errorText(error).split("\n")[0]}), do not repeat it: look with tasks.get, waves.get or the lists`;
}

/**
 * Runs one `factory` tool call: `text` is the agent view, `result` the full view. An action the agent is not offered
 * (host-only, a timeline, a mutating one in a task session) is as unknown as a made-up one. `render` is the agent view
 * (tests swap it).
 */
export async function callFactoryTool(
  params: unknown,
  taskSession: boolean,
  options: CallOptions & { callId?: string },
  render = agentView,
): Promise<{ text: string; result: unknown; card: FactoryCard }> {
  const { action, ...rest } = isRecord(params) ? params : {};
  const name = String(action);
  if (!(agentActions(taskSession) as string[]).includes(name)) throw new FactoryError("invalid", `unknown action "${name}"`);
  const { callId, ...callOptions } = options;
  const cause = await causeOf(name, rest, callOptions);
  const result = await callAction(name, rest, callOptions);
  let text: string;
  try {
    text = render(name, rest, result);
  } catch (error) {
    text = renderFailed(name, result, error);
  }
  const card = factoryCard(name, rest, result, cause);
  if (cause !== null && options.origin !== undefined) {
    const entry = { at: new Date().toISOString(), ...(callId === undefined ? {} : { key: callId }), ...(card.answers === undefined ? {} : { answers: card.answers }), card };
    await appendDecision(options.origin, entry).catch(() => undefined);
  }
  return { text, result, card };
}

/** The cause `name` settles (its feature's `decides`), read before it runs; null when it is no decision. */
async function causeOf(name: string, params: Params, options: CallOptions): Promise<Cause | null> {
  const reader = FEATURES.flatMap((feature) => (feature.decides as Readonly<Record<string, CauseReader>> | undefined)?.[name] ?? [])[0];
  if (reader === undefined) return null;
  try {
    return await reader(params, { cwd: options.cwd, signal: options.signal, env: options.env, origin: options.origin });
  } catch {
    return {};
  }
}

/** The card of `name`'s result (`actionCard`), a decision with a cause; the action's name when it cannot be built. */
export function factoryCard(name: string, params: unknown, result: unknown, cause?: Cause | null): FactoryCard {
  try {
    return actionCard(name, params, result, cause);
  } catch {
    return fallbackCard(name);
  }
}

/** A failed tool call as the agent's one line (`agentError`); an error that is not a `FactoryError` is `failed`. */
export function factoryToolError(error: unknown): string {
  if (error instanceof FactoryError) return agentError({ code: error.code, message: error.message, detail: error.detail });
  return agentError({ code: "failed", message: errorText(error) });
}
