/**
 * Loaded only by a scout's child (`pi -ne -e scout-map-write.ts`, `scout-runner.ts`), never into a coding session.
 *
 * - Provides `map_write {path, description, text}`: a fact under `map/` of the scout's store (`scout-map.ts`), stamped
 *   with the commit the scout explores at. The store, the commit and the scout's directory come from its environment
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mapWrite, SCOUT_COMMIT_ENV, SCOUT_DIR_ENV, SCOUT_STORE_ENV } from "../scout-map.ts";

const parameters = {
  type: "object",
  required: ["path", "description", "text"],
  properties: {
    path: { type: "string", description: "The fact's path under map/, e.g. map/session-restart: one concern per path; an existing path is updated" },
    description: { type: "string", description: "One line: what the fact covers" },
    text: { type: "string", description: "The fact: what holds, each claim with file:line" },
  },
};

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "map_write",
    label: "Map write",
    description: "Write a fact to the map (memory-store, under map/): a new path is added, an existing one updated. The commit you explored at is stamped for you.",
    promptSnippet: "Write a fact to the map under map/",
    parameters,
    async execute(_toolCallId, params) {
      const { path, description, text } = params as { path: string; description: string; text: string };
      const store = process.env[SCOUT_STORE_ENV];
      const commit = process.env[SCOUT_COMMIT_ENV];
      if (!store || !commit) throw new Error("map_write runs only in a scout (no store or commit in its environment)");
      const written = await mapWrite({ store, commit, path, description, text, scoutDir: process.env[SCOUT_DIR_ENV] });
      return { content: [{ type: "text", text: `${written.op === "add" ? "added" : "updated"} ${written.path}` }], details: written };
    },
  });
}
