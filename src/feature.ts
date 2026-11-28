/**
 * What a feature registers: its actions (`ActionSpec`), their handlers, its notices and its sentence of the `factory`
 * tool's description. One module per feature in `feature-<name>.ts`, listed by `features.ts`; `core.ts`, `notify.ts`
 * and `factory-tool.ts` read the list, so a new feature edits none of them.
 * - `handlers` is a getter: read on the first call, never on load (a handler module may import a module that imports
 *   the registry)
 * - An action without a view is never offered to an agent and prints as JSON
 */
import type { FactoryCard } from "./cards.ts";
import type { CallContext, Handler, Params } from "./core-shared.ts";
import type { Cause } from "./decisions.ts";
import type { Notice } from "./notify.ts";

export type Schema = Record<string, unknown>;

/** `view` and `decides` are functions: the JSON of `ACTIONS` (CLI `--json`, pi-host) carries only the spec. */
export interface ActionSpec {
  summary: string;
  params: { type: "object"; required: string[]; properties: Record<string, Schema> };
  mutates: boolean;
  view?: View;
  decides?: CauseReader;
}

export type Handlers = Readonly<Record<string, Handler>>;

export type View = (params: Params, result: never) => FactoryCard | FactoryCard[];

/** The cause an action settles, read before it runs (`decisions.ts`); null: this call is no decision. */
export type CauseReader = (params: Params, context: CallContext) => Promise<Cause | null>;

export interface Feature<A extends string = string> {
  /** One word; the key of the items `pendingNotices` hands to `notices`. */
  name: string;
  actions: { readonly [K in A]: ActionSpec };
  /** Typed loosely: a handler module's types reach `ActionName`. `features.test.ts` checks they match `actions`. */
  readonly handlers: Handlers;
  notices?: (items: readonly unknown[]) => Notice[];
  /** Its sentences of the `factory` tool's description. */
  toolBlurb?: string;
}

/** `feature` as it is, its action names inferred for `ActionName`. */
export function feature<A extends string>(declared: Feature<A>): Feature<A> {
  return declared;
}

export function spec(summary: string, properties: Record<string, Schema>, required: string[], mutates: boolean, view?: View, decides?: CauseReader): ActionSpec {
  return { summary, params: { type: "object", required, properties }, mutates, view, decides };
}

export const REPO: Schema = { type: "string", description: "A path inside the git repository. Default: the current directory" };
export const ID: Schema = { type: "string", description: "The task id or a unique prefix of it" };
export const WAVE_ID: Schema = { type: "string", description: "The wave id or a unique prefix of it" };
/** One task of `waves.start` / `waves.add`. */
export const WAVE_TASK_ITEM: Schema = {
  type: "object",
  required: ["key", "title", "request"],
  properties: {
    key: { type: "string" },
    title: { type: "string" },
    request: { type: "string" },
    after: { type: "array", items: { type: "string" } },
    model: { type: "string", enum: ["small", "big"], description: "Which of the wave's two models this task's coder runs with: small for easy tasks; default big" },
  },
};
export const TAG: Schema = { type: "string", description: "A task tag: segments of A-Z a-z 0-9 . _ @ + - joined by /" };
export const TAG_FILTER: Schema = { type: "string", description: "Only the tasks whose tag is this one or lies under it (a holds a/b, not ab)" };
