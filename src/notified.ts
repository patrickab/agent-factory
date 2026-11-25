/**
 * The notices delivered so far (invariant 12: once per event, across restarts of the session or of Pi).
 *
 * - `notified.jsonl` under the factory home: one JSON line `{key, at}` per delivered notice, append-only
 * - `claimNotices(notices)`: under the lock `notified.lock`, reads the file again, appends the notices nobody delivered
 *   yet and answers them: the caller sends exactly those. Appended before the send, so a crash loses at most one
 *   notice, never doubles one; two sessions racing for a notice deliver it once
 * - A line cut short by a crash is skipped when read
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Notice } from "./notify.ts";
import { factoryHome } from "./settings.ts";
import { lockFile, TaskBusyError, unlockFile } from "./tasks.ts";
import { isRecord } from "./util.ts";

/** How long a claim waits for the lock another session holds. */
const LOCK_WAIT_MS = 10_000;
const LOCK_RETRY_MS = 20;

export function notifiedPath(): string {
  return join(factoryHome(), "notified.jsonl");
}

function notifiedLockPath(): string {
  return join(factoryHome(), "notified.lock");
}

/** The keys of every delivered notice. */
export async function readDelivered(): Promise<Set<string>> {
  const text = await readFile(notifiedPath(), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const keys = new Set<string>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (isRecord(entry) && typeof entry.key === "string") keys.add(entry.key);
    } catch {
      // A line a crash cut short.
    }
  }
  return keys;
}

async function withLock<T>(work: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      await lockFile(notifiedLockPath(), "the notified list is busy");
      break;
    } catch (error) {
      if (!(error instanceof TaskBusyError) || Date.now() >= deadline) throw error;
      await Bun.sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return await work();
  } finally {
    await unlockFile(notifiedLockPath());
  }
}

/** Marks the notices of `notices` that nobody delivered yet as delivered and answers them, in order. */
export async function claimNotices(notices: readonly Notice[]): Promise<Notice[]> {
  if (notices.length === 0) return [];
  return withLock(async () => {
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
