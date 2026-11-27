/**
 * Delivery of notifications into the Pi session that started a task or declared a wave (`notify.ts` decides what).
 * - Looks whenever the watched files change; a slow look (`fallbackMs`) catches a runner that died, which changes no file
 * - A look claims its notices (`claimNotices`) before it sends them: each reaches one session once, also after a
 *   restart and when two sessions race. Looks never overlap
 */
import { mkdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import { noticeInputs } from "../core.ts";
import { FINAL_STATES } from "../state.ts";
import { claimNotices, readDelivered } from "../notified.ts";
import { pendingNotices, scoutNoticeKey, type Notice } from "../notify.ts";
import { callerKey, scoutDirs, scoutsDir, scoutView, type ScoutView } from "../scouts.ts";
import { proofsDir, proofsOf } from "../gates-prove.ts";
import { tasksDir } from "../tasks.ts";
import { WAVE_FINAL_STAGES, type WaveView } from "../waves.ts";
import { wavePath, wavesDir } from "../wave-poke.ts";

export interface NotifierOptions {
  /** This Pi session's id: notices of this origin only. */
  origin: string;
  /** `text` is the agent's; `notice` holds its key and card (`details` of the message). */
  send: (text: string, notice: Notice) => void;
  /** Checked on every look: a session that became a task's own delivers nothing. */
  isTaskSession: () => boolean;
  debounceMs?: number;
  fallbackMs?: number;
  onError?: (error: unknown) => void;
  /** After every look: the views of all of this origin's waves, the finished ones not read again included. */
  onWaves?: (waves: WaveView[]) => void;
  /** A scout whose report a tool call is waiting for: the call delivers it. */
  skipScout?: (id: string) => boolean;
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
  /** This origin's finished tasks whose notices are delivered, by id: their session file as it was before the read that found them final. */
  const finishedTasks = new Map<string, { sessionId: string; path: string; stamp: string | null }>();
  /** The session file of every task of this origin read so far, by id: stamped before the next read. */
  const sessionPaths = new Map<string, string>();
  /** This origin's waves that are final and delivered, by id: never read again, their view as last read. */
  const finishedWaves = new Map<string, WaveView>();
  /** This origin's scouts whose report is delivered: never read again. */
  const reportedScouts = new Set<string>();
  const scoutCaller = { kind: "session" as const, id: origin };

  const reported = (id: string) => {
    reportedScouts.add(id);
    const dir = join(scoutsDir(), callerKey(scoutCaller), id);
    watchers.get(dir)?.close();
    watchers.delete(dir);
  };

  /** The origin's scouts not reported yet; each one's directory watched. */
  const openScouts = async (delivered: ReadonlySet<string>): Promise<ScoutView[]> => {
    const scouts: ScoutView[] = [];
    for (const dir of await scoutDirs(scoutCaller)) {
      const id = basename(dir);
      if (reportedScouts.has(id) || options.skipScout?.(id)) continue;
      if (delivered.has(scoutNoticeKey(id))) {
        reported(id);
        continue;
      }
      const scout = await scoutView(dir).catch(() => undefined);
      if (scout === undefined) continue;
      watchDir(dir, (name) => name === null || String(name) !== "runner.log");
      scouts.push(scout);
    }
    return scouts;
  };

  /** Watches `dir` unless it is watched already; true when it was not. */
  const watchDir = (dir: string, filter: (name: string | Buffer | null) => boolean): boolean => {
    if (stopped || watchers.has(dir)) return false;
    try {
      mkdirSync(dir, { recursive: true });
      const watcher = watch(dir, (_event, name) => {
        if (filter(name)) schedule();
      });
      watcher.on("error", () => undefined);
      watcher.unref?.();
      watchers.set(dir, watcher);
      return true;
    } catch (error) {
      options.onError?.(error);
      return false;
    }
  };

  const once = async () => {
    if (stopped || options.isTaskSession()) return;
    const skip = new Set<string>();
    for (const [id, seen] of finishedTasks) {
      if (fileStamp(seen.path) === seen.stamp) skip.add(id);
      else finishedTasks.delete(id);
    }
    for (const id of finishedWaves.keys()) if (fileStamp(wavePath(id)) === null) finishedWaves.delete(id);
    // Stamped before the read: a write between the read and a stamp taken after it would never be read.
    const before = new Map([...sessionPaths].filter(([id]) => !skip.has(id)).map(([id, path]) => [id, { path, stamp: fileStamp(path) }]));
    const { tasks, waves } = await noticeInputs(origin, { tasks: skip, waves: new Set(finishedWaves.keys()) });
    sessionIds = new Set([...tasks.map((task) => task.sessionId), ...[...finishedTasks.values()].map((seen) => seen.sessionId)]);
    for (const task of tasks) {
      if (task.sessionPath === null) continue;
      sessionPaths.set(task.id, task.sessionPath);
      // A session dir watched from now on: what was written to it during this read is read by the next look.
      if (watchDir(dirname(task.sessionPath), (name) => name === null || [...sessionIds].some((id) => basename(String(name)).includes(id)))) again = true;
    }
    const proofs = await proofsOf(origin);
    const delivered = await readDelivered();
    const scouts = await openScouts(delivered);
    const pending = pendingNotices(tasks, waves, delivered, { scouts, gates: proofs }).filter((notice) => !scouts.some((scout) => notice.key === scoutNoticeKey(scout.id) && options.skipScout?.(scout.id)));
    if (stopped) return;
    if (pending.length > 0) for (const notice of await claimNotices(pending)) send(notice.text, notice);
    // Claimed here or by a racing session: delivered either way.
    for (const scout of scouts) if (pending.some((notice) => notice.key === scoutNoticeKey(scout.id))) reported(scout.id);
    // Every notice of this look is delivered now (by this session or a racing one): the final ones need no look again.
    for (const task of tasks) {
      const seen = before.get(task.id);
      // Final when read, the file stamped before that read: a task first read here is read once more first.
      if (seen !== undefined && seen.path === task.sessionPath && task.state !== null && FINAL_STATES.includes(task.state)) {
        finishedTasks.set(task.id, { sessionId: task.sessionId, path: seen.path, stamp: seen.stamp });
      }
    }
    for (const wave of waves) if (WAVE_FINAL_STAGES.includes(wave.view.stage)) finishedWaves.set(wave.view.id, wave.view);
    if (!stopped) options.onWaves?.([...waves.map((wave) => wave.view).filter((view) => !finishedWaves.has(view.id)), ...finishedWaves.values()]);
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
  // A wave's log lies in its home, out of this watch's reach: its appends are heard through `<id>.log.lock` here,
  // which each append takes and removes (`appendWaveEvents`).
  watchDir(wavesDir(), relevant);
  watchDir(join(scoutsDir(), callerKey(scoutCaller)), relevant);
  watchDir(proofsDir(), relevant);
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
