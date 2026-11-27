/**
 * Loaded only by the reviewer child (`pi -ne -e reviewer-tool.ts`), never into a coding session.
 *
 * - Provides `submit_verdict`, the one way the reviewer can answer. Pi checks the arguments against the schema before
 *   `execute()` runs, and `terminate: true` ends the run on the call
 * - The parent reads the findings from `details.findings` of the tool result (`review.ts`). Whether the review
 *   approves is derived there from the severities, so the tool does not ask for it
 * - Provides `read_diff({paths?})` when the factory names a diff file (`REVIEW_DIFF_ENV`, a `TaskDiff` as JSON, written
 *   by `review-each.ts` per review): the only way the diff reaches a task's reviewer. Lockfiles last, cut as the review
 *   patch is (`reviewPatch`); `paths` keeps only those files (or directories)
 * - A wave's reviewer session is resumed for every review: each tool result older than this process (an earlier review,
 *   one cut short included) reaches the model as a `STUB_PREFIX` line through Pi's `context` hook. The session keeps it
 *   unchanged; the same stubs at every request keep the cached prefix
 * - A wave's reviewer (`REVIEW_WAVE_ENV` set, with `REVIEW_TASK_ENV` and `REVIEW_PLAN_ENV`: the factory plugin is not
 *   loaded here) also gets `registerReviewerTools`:
 *   - `scout`: always waits for the report; it explores the worktree of the task under review (else the wave's review
 *     worktree), so its cost and store are the task's (the wave's)
 *   - `feedback`: role `reviewer`, stored under the plan with the task and wave (task null in the fit pass)
 *   - `notify_supervisor {text}`: one quiet notice to the wave's origin (`noteToSupervisor`); the review goes on
 *   - `start_fix {title, request, model?}`: a `fix:` task in the wave (`startReviewerFix`), at most `REVIEWER_FIX_CAP` per wave,
 *     then refused with the hint to notify the supervisor
 */
import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ACTIONS } from "../core.ts";
import { findWave, noteToSupervisor, REVIEWER_FIX_CAP, startReviewerFix, waveReviewWorktree } from "../core-waves.ts";
import { factoryToolError } from "../factory-tool.ts";
import { REVIEW_DIFF_ENV, readDiffText, STUB_PREFIX } from "../review-diff.ts";
import { scoutBlock } from "../scout-view.ts";
import { listTasks } from "../tasks.ts";
import { isRecord } from "../util.ts";
import { registerFeedbackTool } from "./feedback-tool.ts";
import { createScoutTracker, SCOUT_TOOL_NAME } from "./scout-tool.ts";

export const REVIEW_WAVE_ENV = "FACTORY_REVIEW_WAVE";
export const REVIEW_TASK_ENV = "FACTORY_REVIEW_TASK";
export const REVIEW_PLAN_ENV = "FACTORY_REVIEW_PLAN";
export const NOTIFY_TOOL = "notify_supervisor";
export const FIX_TOOL = "start_fix";

/** Whose reviewer this is: the wave, the task under review (null: none) and the plan store (null: none). */
export interface ReviewerIds {
  wave: string;
  task: string | null;
  plan: string | null;
}

type ToolResult = { content: { type: "text"; text: string }[]; details: unknown; isError?: boolean };
const text = (value: string, details: unknown = undefined): ToolResult => ({ content: [{ type: "text", text: value }], details });
const failed = (error: unknown): ToolResult => ({ ...text(factoryToolError(error)), isError: true });
const nonEmptyString = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);

/** `scout`, `feedback`, `notify_supervisor` and `start_fix` of a wave's reviewer; none ends the review. */
export function registerReviewerTools(pi: ExtensionAPI, ids: ReviewerIds): void {
  const tracker = createScoutTracker({ isCoder: () => true, holds: () => false });
  const { properties, required } = ACTIONS["scouts.start"].params as { properties: Record<string, unknown>; required: string[] };
  const { wait: _wait, repo: _repo, ...scoutProperties } = properties;
  pi.registerTool({
    name: SCOUT_TOOL_NAME,
    label: "Scout",
    description:
      "Send a read-only scout into the work under review: it answers a concern (and questions) from the map of the memory store, explores where the map is not current, writes what it learns there and reports MISSING / DECISIONS / KEY FACTS / MEMORY. The call waits for the report, 15 minutes at the latest.",
    promptSnippet: "Ask a read-only scout about the code and wait for its report",
    parameters: { type: "object", required, properties: scoutProperties } as never,
    async execute(_toolCallId, params: unknown, signal, _onUpdate, ctx: ExtensionContext) {
      try {
        const record = ids.task === null ? undefined : (await listTasks()).find((task) => task.id === ids.task);
        // The task's worktree, else the wave's review worktree.
        const repo = record?.worktree ?? waveReviewWorktree((await findWave(ids.wave)).declaration);
        const { text: answer, result } = await tracker.call({ ...(isRecord(params) ? params : {}), repo, wait: true }, signal, ctx);
        if (result.timedOut) return text(`${scoutBlock(result.scout, true)}\nits report did not arrive in time: go on without it`, result);
        return text(answer, result);
      } catch (error) {
        return failed(error);
      }
    },
  });
  registerFeedbackTool(pi, {
    role: "reviewer",
    context: async () => ({ task: ids.task, wave: ids.wave, plan: ids.plan }),
  });
  pi.registerTool({
    name: NOTIFY_TOOL,
    label: "Notify supervisor",
    description:
      "Tell the supervisor something about the plan it should know while the wave can still be changed (a contract that does not fit, a task the wave lacks). One notice, as information; it returns at once and the review goes on.",
    promptSnippet: "Tell the supervisor something about the plan; the review goes on",
    parameters: { type: "object", required: ["text"], properties: { text: { type: "string", description: "What the supervisor should know, short" } } } as never,
    async execute(_toolCallId, params: unknown) {
      const value = nonEmptyString(isRecord(params) ? params.text : undefined);
      if (value === undefined) return { ...text(`${NOTIFY_TOOL}: text must not be empty`), isError: true };
      try {
        await noteToSupervisor(ids.wave, value, ids.task);
        return text("The supervisor gets the notice. Go on with the review.");
      } catch (error) {
        return failed(error);
      }
    },
  });
  pi.registerTool({
    name: FIX_TOOL,
    label: "Start fix",
    description: `Add a \`fix:\` task to the wave: a coder writes the change, you review it like every task. You never edit code yourself. At most ${REVIEWER_FIX_CAP} per wave; after that tell the supervisor with ${NOTIFY_TOOL}. The task runs on the small model; pass model "big" only for a fix that needs design (a new interface, a change across modules), not for a bounded edit.`,
    promptSnippet: "Start a fix: task in the wave for a coder",
    parameters: {
      type: "object",
      required: ["title", "request"],
      properties: {
        title: { type: "string", description: "A conventional commit title, e.g. `fix(api): handle empty input`" },
        request: { type: "string", description: "The complete request for the task's coder, who sees nothing else" },
        model: { type: "string", enum: ["small", "big"], description: "Default small; big only for a fix that needs design" },
      },
    } as never,
    async execute(_toolCallId, params: unknown) {
      const title = nonEmptyString(isRecord(params) ? params.title : undefined);
      const request = nonEmptyString(isRecord(params) ? params.request : undefined);
      if (title === undefined || request === undefined) return { ...text(`${FIX_TOOL}: title and request must not be empty`), isError: true };
      try {
        const model = isRecord(params) && (params.model === "small" || params.model === "big") ? params.model : undefined;
        const key = await startReviewerFix(ids.wave, { title, request, ...(model ? { model } : {}) });
        return text(`Task ${key} added to the wave; it starts at once. Go on with the review.`, { key });
      } catch (error) {
        return failed(error);
      }
    },
  });
}

const parameters = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      description: "Every problem found, an empty list when the change is fine",
      items: {
        type: "object",
        required: ["file", "line", "severity", "text"],
        properties: {
          file: { type: "string", description: "Path relative to the repository root" },
          line: {
            anyOf: [{ type: "integer" }, { type: "null" }],
            description: "Line in the new version of the file, null when no single line applies",
          },
          severity: {
            type: "string",
            enum: ["blocker", "major", "minor"],
            description: "blocker: breaks the task or the build. major: a real bug or a missed requirement. Only these reject. minor: everything else; stored, it never rejects",
          },
          text: { type: "string", description: "What breaks and why, one or two sentences" },
        },
      },
    },
  },
};

export default function (pi: ExtensionAPI) {
  const started = Date.now();
  pi.on("context", (event) => {
    let changed = false;
    const messages = event.messages.map((message) => {
      if (message.role !== "toolResult" || message.timestamp >= started) return message;
      changed = true;
      return { ...message, content: [{ type: "text" as const, text: `${STUB_PREFIX} ${message.toolName} result of an earlier review` }] };
    });
    return changed ? { messages } : undefined;
  });
  const diffFile = process.env[REVIEW_DIFF_ENV];
  if (diffFile) {
    pi.registerTool({
      name: "read_diff",
      label: "Read diff",
      description: "The diff under review: every changed path first, then the patch (lockfiles last). paths: only these files or directories.",
      promptSnippet: "Read the diff under review",
      parameters: { type: "object", properties: { paths: { type: "array", items: { type: "string" }, description: "Only these files or directories" } } },
      async execute(_toolCallId, params) {
        const { paths } = params as { paths?: string[] };
        return { content: [{ type: "text", text: readDiffText(readFileSync(diffFile, "utf8"), paths) }], details: {} };
      },
    });
  }
  pi.registerTool({
    name: "submit_verdict",
    label: "Submit verdict",
    description: "Submit the final review verdict. Call it exactly once, as your last action.",
    promptSnippet: "Submit the final review verdict as a terminating tool call",
    parameters,
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: "Verdict recorded." }],
        details: { findings: (params as { findings: unknown }).findings },
        terminate: true,
      };
    },
  });
  const wave = process.env[REVIEW_WAVE_ENV];
  if (wave) registerReviewerTools(pi, { wave, task: process.env[REVIEW_TASK_ENV] || null, plan: process.env[REVIEW_PLAN_ENV] || null });
}
