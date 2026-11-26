/**
 * The reviewer's session between two reviews: no earlier diff stays in its context.
 *
 * - Pi applies a `context_edit` entry (`{type, id, parentId, timestamp, targetId, replacement: {content} | null}`) when
 *   it builds the context of a resumed session: the latest edit of a target on the active branch wins, the raw entry
 *   stays. The active leaf is the file's last entry
 * - Pi's docs show `replacement` as the content itself; Pi 1.6.1 reads `replacement.content` and crashes on anything
 *   else, its own writer stores `{content: [{type: "text", text}]}` for a tool result
 * - Pi honours entries appended to the file from outside while no process holds it: proved against Pi 1.6.1 by a real
 *   `--session-id` resume whose model request held the stub instead of the earlier tool result
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";

/** What every stub starts with: a tool result whose context text starts with it is never stubbed again. */
export const STUB_PREFIX = "[reviewed]";

type Entry = {
  type?: string;
  id?: string;
  parentId?: string | null;
  targetId?: string;
  replacement?: { content?: unknown } | null;
  message?: { role?: string; toolName?: string; content?: unknown };
};

/** The text of a message content: a string, or the text blocks of a content array. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && (block as { type?: unknown }).type === "text" ? String((block as { text?: unknown }).text ?? "") : ""))
    .join("");
}

/** A fresh entry id (8 hex, as Pi makes them) that `taken` does not hold. */
function freshId(taken: Set<string>): string {
  for (;;) {
    const id = randomBytes(4).toString("hex");
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

/** The entries of `sessionFile` that parse, header included. */
function readEntries(raw: string): Entry[] {
  const entries: Entry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as Entry);
    } catch {
      // A line that does not parse is skipped, as Pi skips it.
    }
  }
  return entries;
}

/** The entries from the root to the leaf (the last entry with an id), in order. */
function activeBranch(entries: Entry[]): Entry[] {
  const byId = new Map<string, Entry>();
  for (const entry of entries) if (entry.type !== "session" && typeof entry.id === "string") byId.set(entry.id, entry);
  const branch: Entry[] = [];
  let at = entries.findLast((entry) => entry.type !== "session" && typeof entry.id === "string");
  while (at && branch.length <= byId.size) {
    branch.push(at);
    at = at.parentId ? byId.get(at.parentId) : undefined;
  }
  return branch.reverse();
}

/**
 * Appends to `sessionFile` (a Pi session no process holds) one `context_edit` per tool result on the active branch that
 * is not a stub yet, replacing its content by a one-line `[reviewed]` stub. The edits chain from the leaf in one write.
 * Answers how many it appended; 0 leaves the file untouched.
 */
export function stubEarlierRounds(sessionFile: string): number {
  const raw = readFileSync(sessionFile, "utf8");
  const entries = readEntries(raw);
  const branch = activeBranch(entries);
  const taken = new Set(entries.flatMap((entry) => (typeof entry.id === "string" ? [entry.id] : [])));
  const edits = new Map<string, Entry["replacement"]>();
  for (const entry of branch) if (entry.type === "context_edit" && entry.targetId) edits.set(entry.targetId, entry.replacement ?? null);
  let parentId = branch.at(-1)?.id ?? null;
  const lines: string[] = [];
  for (const entry of branch) {
    if (entry.type !== "message" || entry.message?.role !== "toolResult" || !entry.id) continue;
    const edit = edits.get(entry.id);
    const content = edits.has(entry.id) ? edit?.content : entry.message.content;
    if (edit !== null && textOf(content).startsWith(STUB_PREFIX)) continue;
    const id = freshId(taken);
    const text = `${STUB_PREFIX} ${entry.message.toolName ?? "tool"} result of an earlier review`;
    const timestamp = new Date().toISOString();
    lines.push(JSON.stringify({ type: "context_edit", id, parentId, timestamp, targetId: entry.id, replacement: { content: [{ type: "text", text }] } }));
    parentId = id;
  }
  if (lines.length === 0) return 0;
  const lead = raw.length > 0 && !raw.endsWith("\n") ? "\n" : "";
  appendFileSync(sessionFile, `${lead}${lines.join("\n")}\n`);
  return lines.length;
}
