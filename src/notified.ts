/**
 * The notices delivered so far (invariant 12: once per event, across restarts of the session or of Pi):
 * `notified.jsonl`, one `{key, at}` line per notice, append-only.
 * - `claimNotices` appends under the lock before the send, so a crash loses at most one notice, never doubles one;
 *   two sessions racing for a notice deliver it once
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Notice } from "./notify.ts";
import { factoryHome } from "./settings.ts";
import { withLock } from "./tasks.ts";
import { readJsonl } from "./util.ts";

/** How long a claim waits for the lock another session holds. */
const LOCK_WAIT_MS = 10_000;

export function notifiedPath(): string {
  return join(factoryHome(), "notified.jsonl");
}

function notifiedLockPath(): string {
  return join(factoryHome(), "notified.lock");
}

export async function readDelivered(): Promise<Set<string>> {
  return new Set((await readJsonl(notifiedPath())).flatMap((entry) => (typeof entry.key === "string" ? [entry.key] : [])));
}

/** Marks the notices of `notices` that nobody delivered yet as delivered and answers them, in order. */
export async function claimNotices<N extends Pick<Notice, "key">>(notices: readonly N[]): Promise<N[]> {
  if (notices.length === 0) return [];
  return withLock(notifiedLockPath(), "the notified list is busy", LOCK_WAIT_MS, async () => {
    const delivered = await readDelivered();
    const claimed = notices.filter((notice) => !delivered.has(notice.key));
    if (claimed.length === 0) return [];
    await mkdir(factoryHome(), { recursive: true });
    // A line a crash cut short must not swallow the next one.
    const text = await readFile(notifiedPath(), "utf8").catch(() => "");
    const lead = text !== "" && !text.endsWith("\n") ? "\n" : "";
    const at = new Date().toISOString();
    await appendFile(notifiedPath(), lead + claimed.map((notice) => `${JSON.stringify({ key: notice.key, at })}\n`).join(""), "utf8");
    return claimed;
  });
}
