import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const FILE_TOOLS = new Set(["read", "edit", "write"]);

/** Repo-relative paths of the read/edit/write tool calls in a Pi session file; paths outside the worktree and bad lines are dropped. */
export function sessionFiles(sessionFile: string, worktree: string): Set<string> {
  const files = new Set<string>();
  let text: string;
  try {
    text = readFileSync(sessionFile, "utf8");
  } catch {
    return files;
  }
  for (const line of text.split("\n")) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type !== "toolCall" || !FILE_TOOLS.has(part.name)) continue;
      const raw = part.arguments?.path ?? part.arguments?.file_path;
      if (typeof raw !== "string" || raw === "") continue;
      const rel = relative(worktree, resolve(worktree, raw));
      if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) continue;
      files.add(rel);
    }
  }
  return files;
}
