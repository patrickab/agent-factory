/**
 * Loaded only by the reviewer child (`pi -ne -e reviewer-tool.ts`), never into a coding session.
 * - `submit_verdict` is the reviewer's one way to answer (`terminate: true` ends the run); `read_diff` the one way the
 *   diff reaches it (`REVIEW_DIFF_ENV`)
 * - A wave's reviewer session is resumed for every review: each tool result older than this process reaches the model
 *   as a `STUB_PREFIX` line through Pi's `context` hook; the same stubs at every request keep the cached prefix
 * - A wave's reviewer (`REVIEW_WAVE_ENV`) also gets `scout`, `feedback`, `notify_supervisor` and `start_fix`
 *   (`registerReviewerTools`): the factory plugin is not loaded here
 * - `bash` refuses a git command that changes the tree, the index, a branch or a remote (`changesGit`)
 */
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findWave, noteToSupervisor, REVIEWER_FIX_CAP, startReviewerFix, waveReviewWorktree } from "../core-waves.ts";
import { factoryToolError } from "../factory-tool.ts";
import { REVIEW_DIFF_ENV, readDiffText, STUB_PREFIX } from "../review.ts";
import { listTasks } from "../tasks.ts";
import { isRecord } from "../util.ts";
import { registerFeedbackTool } from "./feedback-tool.ts";
import { createScoutTracker, registerScoutTool } from "./scout-tool.ts";
import { toolError, toolText } from "./tool.ts";

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

/**
 * A git subcommand that changes the tree, the index, a branch or a remote, as a word after `git` and its global
 * options, anywhere in the command (`&&`, `;`, `|`, `$(...)`, `bash -c "..."`). A guard against a slip, not a sandbox:
 * an odd read-only command may be refused, and the worktree check after the run (`runReviewer`) is what holds the rule.
 */
const GIT_WRITE =
  /(^|[\s;&|("'`])git(\s+(-[Cc]\s+\S+|-{1,2}[\w-]+(=\S+)?))*\s+(commit|push|merge|rebase|reset|checkout|switch|restore|stash|cherry-pick|revert|am|apply|worktree|tag|clean|add|rm|mv|pull|fetch|branch\s+([^;&|]*\s)?-(d|D|m|M|-delete|-move))(?=$|[\s;&|)"'`])/;
const changesGit = (command: string): boolean => GIT_WRITE.test(command);

const failed = (error: unknown) => toolError(factoryToolError(error));
const nonEmptyString = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);

/** `scout`, `feedback`, `notify_supervisor` and `start_fix` of a wave's reviewer; none ends the review. */
export function registerReviewerTools(pi: ExtensionAPI, ids: ReviewerIds): void {
  registerScoutTool(pi, createScoutTracker({ isCoder: () => true, holds: () => false }), {
    // The task's worktree, else the wave's review worktree.
    repo: async () => (ids.task === null ? undefined : (await listTasks()).find((task) => task.id === ids.task))?.worktree ?? waveReviewWorktree((await findWave(ids.wave)).declaration),
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
      if (value === undefined) return toolError(`${NOTIFY_TOOL}: text must not be empty`);
      try {
        await noteToSupervisor(ids.wave, value, ids.task);
        return toolText("The supervisor gets the notice. Go on with the review.");
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
      if (title === undefined || request === undefined) return toolError(`${FIX_TOOL}: title and request must not be empty`);
      try {
        const model = isRecord(params) && (params.model === "small" || params.model === "big") ? params.model : undefined;
        const key = await startReviewerFix(ids.wave, { title, request, ...(model ? { model } : {}) });
        return toolText(`Task ${key} added to the wave; it starts at once. Go on with the review.`, { key });
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
  pi.on("tool_call", (event) => {
    if (event.toolName === "bash" && changesGit(String((event.input as { command?: unknown }).command))) {
      return { block: true, reason: "Refused: a reviewer never changes the worktree, the index, a branch or a remote; it reviews and gives instructions (findings, start_fix)." };
    }
    return undefined;
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
        return toolText(readDiffText(readFileSync(diffFile, "utf8"), paths), {});
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
      return { ...toolText("Verdict recorded.", { findings: (params as { findings: unknown }).findings }), terminate: true };
    },
  });
  const wave = process.env[REVIEW_WAVE_ENV];
  if (wave) registerReviewerTools(pi, { wave, task: process.env[REVIEW_TASK_ENV] || null, plan: process.env[REVIEW_PLAN_ENV] || null });
}
