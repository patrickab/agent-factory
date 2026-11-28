/**
 * The agent's text beside the cards (`cards.ts`): what holds for every text an agent reads, its errors and the action
 * list. Pure: no I/O. The full view (JSON, `callAction`'s answer) is for programs.
 *
 * - `scrub`: never a path, a home or a full uuid in an agent's text. A home directory becomes `~`, any other absolute
 *   path `<path>` (`withoutPaths`, also the rule of a wave's stage details), a uuid its short id
 * - `agentError`: an error as one line with the way out. `agentActions`: the action list, or one action's params
 */
import type { ActionSpec } from "./feature.ts";

const UUID = /\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HOME = /\/(?:home|Users)\/[^/\s"'`]+/g;

/** Every absolute path in free text as `<path>` (one rule for the agent view and a wave's stage details). */
export function withoutPaths(text: string): string {
  return text.replace(/(^|[\s'"`(=])\/[^\s'"`),;/]+\/[^\s'"`),;]*/g, "$1<path>");
}

/**
 * A home directory as `~`, any other absolute path as `<path>`, a uuid (task, wave, session) as its short id. With
 * `keepPaths` (the `repos.*` answers, whose repository paths are the handles an agent passes back) only the home goes.
 */
export function scrub(text: string, keepPaths = false): string {
  const homeless = text.replace(HOME, "~");
  return (keepPaths ? homeless : withoutPaths(homeless)).replace(UUID, "$1");
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// ---- errors ----

function wayOut(error: { code: string; message: string; detail?: { force?: boolean } }): string {
  const message = error.message.toLowerCase();
  switch (error.code) {
    case "invalid":
      return "fix the params (factory actions {name} lists them)";
    case "not_found":
      if (/registered|git repository|repositor/.test(message)) return "repos.list";
      if (/branch/.test(message)) return "branches.list";
      if (/model/.test(message)) return "models.get";
      if (/wave/.test(message)) return "waves.list";
      return "tasks.list";
    case "busy":
      return "try again once it rests (tasks.wait)";
    case "refused":
      if (error.detail?.force === true) return "the same call with force: true drops it";
      return /\bwave\b/.test(message) ? "waves.get shows the actions valid now" : "tasks.get shows the actions valid now";
    default:
      return "tell the user: the factory failed";
  }
}

/** An error as one line: `code: message · next: the way out`. */
export function agentError(error: { code: string; message: string; detail?: { force?: boolean } }): string {
  return scrub(`${error.code}: ${error.message.replace(/\s*\n\s*/g, " ")} · next: ${wayOut(error)}`);
}

// ---- the action list ----

type Schema = Record<string, unknown>;

/** `{repo, title, request, tag?}`: the required params first, the optional ones with `?`. */
function paramSignature(spec: ActionSpec): string {
  const names = Object.keys(spec.params.properties).map((key) => (spec.params.required.includes(key) ? key : `${key}?`));
  return `{${names.join(", ")}}`;
}

function schemaType(schema: Schema): string {
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  const type = String(schema.type ?? "any");
  if (type === "array" && schema.items !== null && typeof schema.items === "object") return `${schemaType(schema.items as Schema)}[]`;
  return type;
}

function schemaLines(properties: Record<string, Schema>, required: readonly string[], indent: string): string[] {
  const lines: string[] = [];
  for (const [key, schema] of Object.entries(properties)) {
    const bounds = [typeof schema.minimum === "number" ? `min ${schema.minimum}` : null, typeof schema.maximum === "number" ? `max ${schema.maximum}` : null].filter(
      (bound) => bound !== null,
    );
    const head = `${indent}${key}${required.includes(key) ? "" : "?"}: ${schemaType(schema)}${bounds.length > 0 ? ` (${bounds.join(", ")})` : ""}`;
    lines.push(typeof schema.description === "string" ? `${head} - ${schema.description}` : head);
    const nested = (schema.type === "array" ? schema.items : schema) as Schema | undefined;
    if (nested && typeof nested.properties === "object" && nested.properties !== null) {
      const inner = Array.isArray(nested.required) ? (nested.required as string[]) : [];
      lines.push(...schemaLines(nested.properties as Record<string, Schema>, inner, `${indent}  `));
    }
  }
  return lines;
}

/**
 * The action list, one line per action: `name {params} - summary`. With `name`: that action's summary and every param
 * in full (type, bounds, description, nested fields).
 */
export function agentActions(actions: Record<string, ActionSpec>, name?: string): string {
  if (name === undefined) return Object.entries(actions).map(([action, spec]) => `${action} ${paramSignature(spec)} - ${spec.summary}`).join("\n");
  const spec = Object.hasOwn(actions, name) ? actions[name] : undefined;
  if (spec === undefined) return agentError({ code: "not_found", message: `no action ${name}` }).replace(/next: .*$/, "next: factory actions lists them");
  const params = schemaLines(spec.params.properties, spec.params.required, "  ");
  return [`${name} ${paramSignature(spec)} - ${spec.summary}${spec.mutates ? "" : " (reads only)"}`, ...(params.length > 0 ? params : ["  no params"])].join("\n");
}
