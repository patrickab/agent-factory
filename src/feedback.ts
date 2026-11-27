/**
 * Feedback the agents give about the factory's work (`feedback {kind, what, cost?, suggestion?}`, `pi/feedback-tool.ts`).
 *
 * - An entry is one fact under `<store>/run/feedback`, a JSON line with the task, wave and role added; the store is the
 *   task's `plan`. The wave reviewer's pass on how the tasks fit together has no task: `task` null, the wave's `plan`.
 *   One `memory-store apply` (with the memory's description, which its first entry needs); a store without the
 *   directory `run` gets it declared (`create`) and the apply once more. `memory-store` missing, no plan or no such
 *   store: nothing is stored, the entry stays in the task's session (the tool appends it there)
 * - `waveFeedback` lists a wave's entries, oldest first, for `waves.get`
 */
import { runCommand } from "./run.ts";

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

const STORE_CWD = { cwd: process.cwd(), timeoutMs: 30_000, maxStdoutChars: 1_000_000 };

async function store(args: string[]): Promise<{ ok: boolean; stdout: string; output: string }> {
  try {
    const result = await runCommand(["memory-store", ...args], STORE_CWD);
    return { ok: result.exitCode === 0, stdout: result.stdout, output: result.output };
  } catch {
    return { ok: false, stdout: "", output: "" };
  }
}

/** Stores the entry as a fact of `store`: true when it landed, false when there is no store to keep it in. */
export async function storeFeedback(storeName: string | null, entry: FeedbackEntry): Promise<boolean> {
  if (storeName === null) return false;
  const ops = JSON.stringify([{ op: "add", path: FEEDBACK_PATH, text: JSON.stringify(entry), description: "what cost the agents runtime or context" }]);
  const applied = await store(["apply", storeName, "--ops", ops]);
  if (applied.ok) return true;
  // A store that exists without the directory `run`: declared once, then the entry goes in.
  if (!applied.output.includes("undeclared_directory")) return false;
  return (await store(["create", storeName, "run"])).ok && (await store(["apply", storeName, "--ops", ops])).ok;
}

/** The entries of the wave `wave` in the store `storeName`, oldest first; none without a store. */
export async function waveFeedback(storeName: string | null, wave: string): Promise<FeedbackEntry[]> {
  if (storeName === null) return [];
  const read = await store(["read", storeName, FEEDBACK_PATH]);
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
