/**
 * Delivery of notifications (invariant 9, 12) into the Pi session that started a task or declared a wave.
 *
 * - `startNotifier`: in a session that is not a factory task's own, looks at the factory's records on start and whenever
 *   they change: the task and wave dirs and the session files of this origin's tasks are watched (`fs.watch`), changes
 *   debounced. A runner that dies changes no file, so a slow look (`fallbackMs`) catches an interruption
 * - One look: `noticeInputs(origin)` (only this session's tasks and waves), `pendingNotices`, then `claimNotices` marks
 *   them delivered under the lock before `send` hands each to Pi: a notice reaches one session once, also after a
 *   restart and when two sessions race. Looks never overlap: a change during one makes another follow. What is
 *   finished and delivered is not read again: a `done`/`cancelled` task while its session file is unchanged (a
 *   follow-up changes it), a `merged`/`cancelled` wave never (both final)
 * - `send` is `pi.sendMessage` with `triggerTurn` (public Pi API): the message starts a turn
 */
import { mkdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { noticeInputs } from "../core.ts";
import { claimNotices, readDelivered } from "../notified.ts";
import { pendingNotices } from "../notify.ts";
import { tasksDir } from "../tasks.ts";
import { wavesDir } from "../waves.ts";

export interface NotifierOptions {
  /** This Pi session's id: notices of this origin only. */
  origin: string;
  send: (text: string) => void;
  /** Checked on every look: a session that became a task's own delivers nothing. */
  isTaskSession: () => boolean;
  debounceMs?: number;
  fallbackMs?: number;
  onError?: (error: unknown) => void;
}

export interface Notifier {
  /** Looks now and resolves when the look (and any it made follow) has ended. */
  look(): Promise<void>;
  stop(): void;
}

const DEBOUNCE_MS = 500;
const FALLBACK_MS = 60_000;

/** `.log` files are runners' output, written all the time: no record changes there. */
function relevant(name: string | Buffer | null): boolean {
  return name === null || !String(name).endsWith(".log");
}

const FINAL_TASK_STATES: readonly (string | null)[] = ["done", "cancelled"];
const FINAL_WAVE_STAGES: readonly string[] = ["merged", "cancelled"];

/** What changes when a file is written: size and mtime; null when it is gone. */
function fileStamp(path: string): string | null {
  const stat = statSync(path, { throwIfNoEntry: false });
  return stat === undefined ? null : `${stat.size}:${stat.mtimeMs}`;
}

export function startNotifier(options: NotifierOptions): Notifier {
  const { origin, send } = options;
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  let stopped = false;
  let running: Promise<void> | undefined;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchers = new Map<string, FSWatcher>();
  /** The session ids of this origin's tasks, whose files in their session dirs are watched. */
  let sessionIds = new Set<string>();
  /** This origin's finished tasks whose notices are delivered, by id: their session file as last read. */
  const finishedTasks = new Map<string, { sessionId: string; path: string; stamp: string | null }>();
  /** This origin's waves that are final and delivered: never read again. */
  const finishedWaves = new Set<string>();

  const watchDir = (dir: string, filter: (name: string | Buffer | null) => boolean) => {
    if (stopped || watchers.has(dir)) return;
    try {
      mkdirSync(dir, { recursive: true });
      const watcher = watch(dir, (_event, name) => {
        if (filter(name)) schedule();
      });
      watcher.on("error", () => undefined);
      watcher.unref?.();
      watchers.set(dir, watcher);
    } catch (error) {
      options.onError?.(error);
    }
  };

  const once = async () => {
    if (stopped || options.isTaskSession()) return;
    const skip = new Set<string>();
    for (const [id, seen] of finishedTasks) {
      if (fileStamp(seen.path) === seen.stamp) skip.add(id);
      else finishedTasks.delete(id);
    }
    const { tasks, waves } = await noticeInputs(origin, { tasks: skip, waves: finishedWaves });
    sessionIds = new Set([...tasks.map((task) => task.sessionId), ...[...finishedTasks.values()].map((seen) => seen.sessionId)]);
    for (const task of tasks) {
      if (task.sessionPath !== null) watchDir(dirname(task.sessionPath), (name) => name === null || [...sessionIds].some((id) => basename(String(name)).includes(id)));
    }
    const pending = pendingNotices(tasks, waves, await readDelivered());
    if (stopped) return;
    if (pending.length > 0) for (const notice of await claimNotices(pending)) send(notice.text);
    // Every notice of this look is delivered now (by this session or a racing one): the final ones need no look again.
    for (const task of tasks) {
      if (task.sessionPath !== null && FINAL_TASK_STATES.includes(task.state)) {
        finishedTasks.set(task.id, { sessionId: task.sessionId, path: task.sessionPath, stamp: fileStamp(task.sessionPath) });
      }
    }
    for (const wave of waves) if (FINAL_WAVE_STAGES.includes(wave.view.stage)) finishedWaves.add(wave.view.id);
  };

  const look = (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await once().catch((error: unknown) => options.onError?.(error));
      } while (again && !stopped);
    })().finally(() => {
      running = undefined;
    });
    return running;
  };

  function schedule() {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => void look(), debounceMs);
    timer.unref?.();
  }

  watchDir(tasksDir(), relevant);
  watchDir(wavesDir(), relevant);
  const fallback = setInterval(() => void look(), options.fallbackMs ?? FALLBACK_MS);
  fallback.unref?.();
  void look();

  return {
    look,
    stop() {
      stopped = true;
      clearTimeout(timer);
      clearInterval(fallback);
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}
