/**
 * The `scout` tool for supervisor sessions and coders: `scouts.start` (`core-scouts.ts`) with the caller's choice to
 * wait. Never registered in a scout's own child (`FACTORY_SCOUT_ID`): a scout starts no scout.
 *
 * - `wait: true`: the call returns the report, after 15 minutes at the latest (`FACTORY_SCOUT_WAIT_MS`) with what the
 *   scout wrote so far; the report then follows as for `wait: false`
 * - `wait: false`: the call returns the scout's id at once. A coder's report is owed to it: `held` (its
 *   `agent_before_settle`) waits until every owed scout ended and answers their reports as follow-up messages, so the
 *   coder's turn does not end before its scouts reported. A supervisor's report is a factory report (`notify.ts`,
 *   `pi/notifier.ts`): its text and the report's path
 * - One report per scout: a coder's owed scouts live in this session's memory and leave it with their report; a
 *   supervisor's waited call and the notifier claim the same key (`scoutNoticeKey`, `notified.ts`), and the notifier
 *   skips the scouts a call waits for (`waiting`)
 * - The `factory` tool's `scouts.start` takes the same path (`call`)
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { factoryToolError } from "../factory-tool.ts";
import { ACTIONS, callAction } from "../core.ts";
import { claimNotices } from "../notified.ts";
import { scoutNoticeKey } from "../notify.ts";
import { scoutBlock } from "../scout-view.ts";
import { FINAL_SCOUT_STATES, SCOUT_ID_ENV, type ScoutView } from "../scouts.ts";
import { isRecord } from "../util.ts";

export const SCOUT_TOOL_NAME = "scout";
/** The custom message that carries a scout's report to a coder. */
export const SCOUT_REPORT_TYPE = "factory-scout";

export const SCOUT_TOOL_DESCRIPTION = [
  "Send a read-only scout into your working directory: it answers a concern (and questions) from the map of the memory store, explores where the map is not current, writes what it learns there and reports MISSING / DECISIONS / KEY FACTS / MEMORY.",
  "wait: true returns the report (after 15 minutes at the latest with what it wrote so far); wait: false returns its id at once and the report follows: to a coder as a message before its turn ends, to a supervisor as a factory report.",
  "At most four of yours run at once, more queue. A task's or wave's plan is the store; elsewhere pass store.",
].join(" ");

/** How the tool reaches the core: tests replace it. */
export interface ScoutCore {
  start(params: Record<string, unknown>, options: { cwd: string; signal?: AbortSignal; origin: string }): Promise<ScoutView>;
  get(id: string): Promise<ScoutView>;
}

const CORE: ScoutCore = {
  start: async (params, options) => ((await callAction("scouts.start", { ...params, wait: false }, options)) as { scout: ScoutView }).scout,
  get: async (id) => ((await callAction("scouts.get", { id })) as { scout: ScoutView }).scout,
};

export interface ScoutToolOptions {
  /** Whether the session is a coder's: a task's own session. */
  isCoder(): boolean;
  /** Whether the coder's turn end waits for its scouts: its task is `running` (default: `isCoder`). */
  holds?(): boolean;
  core?: ScoutCore;
  pollMs?: number;
  waitMs?: number;
}

export interface ScoutTracker {
  /** One scout call, `{concern, questions?, wait?, store?, repo?}`: the answer as text and the full view. */
  call(params: unknown, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<{ text: string; result: { scout: ScoutView; timedOut: boolean } }>;
  /** Waits until every scout owed to the coder ended (or `stop` says so) and answers their reports, each once. */
  held(stop: () => boolean): Promise<ScoutReportDraft[]>;
  /** The scouts a supervisor's call waits for now: the notifier leaves them to the call. */
  waiting: ReadonlySet<string>;
}

export type ScoutReportDraft = { type: "custom_message"; customType: typeof SCOUT_REPORT_TYPE; content: string; display: true; details: { scout: string } };

export function scoutEnded(scout: ScoutView): boolean {
  return FINAL_SCOUT_STATES.includes(scout.state) || scout.interrupted;
}

/** `factory: scout <id> reported` (or how it ended) above the scout's block. */
export function scoutReportText(scout: ScoutView): string {
  let state: string = scout.state === "done" ? "reported" : scout.state;
  if (scout.interrupted) state = "was interrupted";
  return `factory: scout ${scout.id.slice(0, 8)} ${state}\n${scoutBlock(scout)}`;
}

export function createScoutTracker(options: ScoutToolOptions): ScoutTracker {
  const core = options.core ?? CORE;
  const pollMs = options.pollMs ?? (Number(process.env.FACTORY_SCOUT_POLL_MS) || 1_000);
  const waitMs = () => options.waitMs ?? (Number(process.env.FACTORY_SCOUT_WAIT_MS) || 15 * 60_000);
  /** The coder's scouts whose report it has not had. */
  const owed = new Map<string, ScoutView>();
  const waiting = new Set<string>();

  const waitFor = async (id: string, signal: AbortSignal | undefined): Promise<ScoutView> => {
    const deadline = Date.now() + waitMs();
    for (;;) {
      const scout = await core.get(id);
      if (scoutEnded(scout) || signal?.aborted || Date.now() >= deadline) return scout;
      await sleep(pollMs);
    }
  };

  return {
    waiting,

    async call(params, signal, ctx) {
      const coder = options.isCoder();
      const scout = await core.start(isRecord(params) ? params : {}, { cwd: ctx.cwd, signal, origin: ctx.sessionManager.getSessionId() });
      const holds = coder && (options.holds?.() ?? true);
      const later = holds ? "its report arrives as a message before your turn ends" : coder ? "read its report with scouts.get" : "its report arrives as a factory report";
      if (holds) owed.set(scout.id, scout);
      if (!isRecord(params) || params.wait !== true) return { text: `${scoutBlock(scout)}\n${later}`, result: { scout, timedOut: false } };
      if (!coder) waiting.add(scout.id);
      let view: ScoutView;
      try {
        view = await waitFor(scout.id, signal);
      } finally {
        waiting.delete(scout.id);
      }
      if (!scoutEnded(view)) return { text: `${scoutBlock(view, true)}\n${later}`, result: { scout: view, timedOut: true } };
      if (coder) owed.delete(view.id);
      // The notifier may have claimed it before this call waited for it: then it was delivered there.
      else if ((await claimNotices([{ key: scoutNoticeKey(view.id), origin: ctx.sessionManager.getSessionId(), text: "" }])).length === 0) {
        return { text: `scout ${view.id.slice(0, 8)} ${view.state}: its report arrived as a factory report`, result: { scout: view, timedOut: false } };
      }
      return { text: scoutBlock(view), result: { scout: view, timedOut: false } };
    },

    async held(stop) {
      const drafts: ScoutReportDraft[] = [];
      while (owed.size > 0 && !stop()) {
        for (const id of [...owed.keys()]) {
          const scout = await core.get(id).catch(() => undefined);
          // A scout whose record is gone reports nothing more.
          if (scout !== undefined && !scoutEnded(scout)) continue;
          if (!owed.delete(id) || scout === undefined) continue;
          drafts.push({ type: "custom_message", customType: SCOUT_REPORT_TYPE, content: scoutReportText(scout), display: true, details: { scout: id } });
        }
        if (owed.size > 0 && !stop()) await sleep(pollMs);
      }
      return drafts;
    },
  };
}

/** Registers `scout` unless this is a scout's own child; answers the tracker the extension holds the turn end with. */
export function registerScoutTool(pi: ExtensionAPI, tracker: ScoutTracker): void {
  if (process.env[SCOUT_ID_ENV] !== undefined) return;
  const { properties, required } = ACTIONS["scouts.start"].params as { properties: Record<string, unknown>; required: string[] };
  pi.registerTool({
    name: SCOUT_TOOL_NAME,
    label: "Scout",
    description: SCOUT_TOOL_DESCRIPTION,
    promptSnippet: "Ask a read-only scout about the code; wait for its report or let it follow",
    parameters: { type: "object", required, properties } as never,
    async execute(_toolCallId, params: unknown, signal, _onUpdate, ctx) {
      try {
        const { text, result } = await tracker.call(params, signal, ctx);
        return { content: [{ type: "text" as const, text }], details: result };
      } catch (error) {
        return { content: [{ type: "text" as const, text: factoryToolError(error) }], details: undefined, isError: true };
      }
    },
  });
}
