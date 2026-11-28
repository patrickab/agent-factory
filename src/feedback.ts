/**
 * Feedback the agents give about the factory's work (`pi/feedback-tool.ts`): one fact under `<store>/run/feedback`,
 * the store being the task's (for the wave reviewer's fit pass the wave's) `plan`.
 * - A store without the directory `run` gets it declared and the apply once more
 * - `memory-store` missing, no plan or no such store: nothing is stored, the entry stays in the task's session
 */
import { apply, create, facts } from "./store.ts";

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
  const ops = [{ op: "add", path: FEEDBACK_PATH, text: JSON.stringify(entry), description: "what cost the agents runtime or context" }];
  try {
    await apply(storeName, ops);
    return true;
  } catch (error) {
    // A store that exists without the directory `run`: declared once, then the entry goes in.
    if (!(error as Error).message.includes("undeclared_directory")) return false;
  }
  try {
    await create(storeName, "run");
    await apply(storeName, ops);
    return true;
  } catch {
    return false;
  }
}

/** The entries of the wave `wave` in the store `storeName`, oldest first; none without a store. */
export async function waveFeedback(storeName: string | null, wave: string): Promise<FeedbackEntry[]> {
  if (storeName === null) return [];
  const entries: FeedbackEntry[] = [];
  for (const { text } of await facts(storeName, FEEDBACK_PATH)) {
    try {
      const entry = JSON.parse(text) as FeedbackEntry;
      if (entry.wave === wave) entries.push(entry);
    } catch {
      // no entry
    }
  }
  return entries.reverse();
}
