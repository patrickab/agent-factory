/**
 * Feedback the agents give about the factory's work (`feedback {kind, what, cost?, suggestion?}`, `pi/feedback-tool.ts`).
 *
 * - An entry is one fact under `<store>/run/feedback`, a JSON line with the task, wave and role added; the store is the
 *   task's `plan`. `memory-store` missing, no plan or no such store: nothing is stored, the entry stays in the task's
 *   session (the tool appends it there)
 * - `waveFeedback` lists a wave's entries, oldest first, for `waves.get`
 */
import { runCommand } from "./run.ts";
import { isRecord } from "./util.ts";

export const FEEDBACK_KINDS = ["runtime", "context", "request", "contract", "tools", "environment", "communication"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export interface FeedbackEntry {
  kind: FeedbackKind;
  what: string;
  cost: string | null;
  suggestion: string | null;
  task: string;
  wave: string | null;
  role: string;
}

/** The memory the entries live in, in the directory `run`. */
export const FEEDBACK_PATH = "run/feedback";

const STORE_CWD = { cwd: process.cwd(), timeoutMs: 30_000, maxStdoutChars: 1_000_000 };

async function store(args: string[]): Promise<{ ok: boolean; output: string }> {
  try {
    const result = await runCommand(["memory-store", ...args], STORE_CWD);
    return { ok: result.exitCode === 0, output: result.stdout };
  } catch {
    return { ok: false, output: "" };
  }
}

/** Stores the entry as a fact of `store`: true when it landed, false when there is no store to keep it in. */
export async function storeFeedback(storeName: string | null, entry: FeedbackEntry): Promise<boolean> {
  if (storeName === null || !(await store(["ls", storeName])).ok) return false;
  await store(["create", storeName, "run"]);
  const op = { op: "add", path: FEEDBACK_PATH, text: JSON.stringify(entry) };
  // The first entry creates the memory, which wants a description.
  if ((await store(["apply", storeName, "--ops", JSON.stringify([op])])).ok) return true;
  return (await store(["apply", storeName, "--ops", JSON.stringify([{ ...op, description: "what cost the agents runtime or context" }])])).ok;
}

function parseEntry(text: string): FeedbackEntry | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || !FEEDBACK_KINDS.includes(value.kind as FeedbackKind)) return null;
  if (typeof value.what !== "string" || typeof value.task !== "string" || typeof value.role !== "string") return null;
  const optional = (field: unknown) => (typeof field === "string" ? field : null);
  return { kind: value.kind as FeedbackKind, what: value.what, cost: optional(value.cost), suggestion: optional(value.suggestion), task: value.task, wave: optional(value.wave), role: value.role };
}

/** The entries of the wave `wave` in the store `storeName`, oldest first; none without a store. */
export async function waveFeedback(storeName: string | null, wave: string): Promise<FeedbackEntry[]> {
  if (storeName === null) return [];
  const read = await store(["read", storeName, FEEDBACK_PATH]);
  if (!read.ok) return [];
  const entries: FeedbackEntry[] = [];
  for (const line of read.output.split("\n")) {
    const match = /^- \[[^\]]+\] (.*)$/.exec(line);
    const entry = match === null ? null : parseEntry(match[1] as string);
    if (entry !== null && entry.wave === wave) entries.push(entry);
  }
  return entries.reverse();
}
