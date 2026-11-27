/**
 * Feedback the agents give about the factory's work (`pi/feedback-tool.ts`): one fact under `<store>/run/feedback`,
 * the store being the task's (for the wave reviewer's fit pass the wave's) `plan`.
 * - A store without the directory `run` gets it declared and the apply once more
 * - `memory-store` missing, no plan or no such store: nothing is stored, the entry stays in the task's session
 */
import { memoryStore } from "./contracts.ts";

export const FEEDBACK_KINDS = ["runtime", "context", "request", "contract", "tools", "environment", "communication"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export interface FeedbackEntry {
  kind: FeedbackKind;
  what: string;
  cost: string | null;
  suggestion: string | null;
  /** Null: the wave's own (its reviewer's fit pass). */
  task: string | null;
  wave: string | null;
  role: string;
}

/** The memory the entries live in, in the directory `run`. */
export const FEEDBACK_PATH = "run/feedback";

/** Stores the entry as a fact of `store`: true when it landed, false when there is no store to keep it in. */
export async function storeFeedback(storeName: string | null, entry: FeedbackEntry): Promise<boolean> {
  if (storeName === null) return false;
  const ops = JSON.stringify([{ op: "add", path: FEEDBACK_PATH, text: JSON.stringify(entry), description: "what cost the agents runtime or context" }]);
  const applied = await memoryStore(["apply", storeName, "--ops", ops]);
  if (applied.ok) return true;
  // A store that exists without the directory `run`: declared once, then the entry goes in.
  if (!applied.output.includes("undeclared_directory")) return false;
  return (await memoryStore(["create", storeName, "run"])).ok && (await memoryStore(["apply", storeName, "--ops", ops])).ok;
}

/** The entries of the wave `wave` in the store `storeName`, oldest first; none without a store. */
export async function waveFeedback(storeName: string | null, wave: string): Promise<FeedbackEntry[]> {
  if (storeName === null) return [];
  const read = await memoryStore(["read", storeName, FEEDBACK_PATH]);
  if (!read.ok) return [];
  const entries: FeedbackEntry[] = [];
  for (const line of read.stdout.split("\n")) {
    try {
      const entry = JSON.parse(/^- \[[^\]]+\] (.*)$/.exec(line)?.[1] ?? "") as FeedbackEntry;
      if (entry.wave === wave) entries.push(entry);
    } catch {
      // no entry
    }
  }
  return entries.reverse();
}
