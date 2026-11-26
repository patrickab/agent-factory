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
 */
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { REVIEW_DIFF_ENV, readDiffText } from "../review-diff.ts";

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
}
