/**
 * Decisions (contract `cards`): a supervisor's action that settles something, the notice key it answers read from state
 * at call time, and the log of a session's decisions.
 *
 * - A feature registers per action how its cause is read (`feature.ts` `decides`): a `Cause` makes the action a
 *   decision (`answers`: the key of the notice it settles, absent when nothing is open), null leaves it an action
 * - `taskCause(id)`: the task's open notice (a question, a block, an interrupted runner, waiting for approve); a task of
 *   a wave that does not build answers its wave's notice (the wave's speaks for it then, `notify.ts`)
 * - `waveCause(id)`: the wave's open notice (rejected, blocked, waiting for approve, interrupted, can never start)
 * - `contractCause(store, name)`: the latest rejection or block of the waves of `store` listing the contract
 * - The keys are those of `notify.ts`, computed by its own functions: an answer names exactly the notice it settles
 * - The log: `decisions/<origin>.jsonl` under the factory home, one JSON line `{at, card}` per decision (what it answers: `card.answers`),
 *   append-only; a line cut short or not a decision is skipped when read
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FactoryCard } from "./cards.ts";
import { FactoryError } from "./core-shared.ts";
import { findTask, pendingWaveTask, taskView, type TaskView } from "./core-tasks.ts";
import { findWave, waveLook } from "./core-waves.ts";
import { taskNotice, waveNotice } from "./notify.ts";
import { factoryHome } from "./settings.ts";
import type { TaskRecord } from "./tasks.ts";
import { foldWave, listWaves, type WaveFile, type WaveStage } from "./waves.ts";

/** What a decision answers: the notice key it settles, absent when it settles nothing open. */
export type Cause = { answers?: string };

/** One decision of a session, as `decisions.list` answers it. */
export type DecisionEntry = { at: string; card: FactoryCard };

const cause = (answers: string | undefined): Cause => (answers === undefined ? {} : { answers });

/** The wave's open notice (a notice that needs a ruling), only in one of `stages` when given. */
async function waveKey(file: WaveFile, stages?: readonly WaveStage[]): Promise<string | undefined> {
  const look = await waveLook(file);
  if (stages !== undefined && !stages.includes(look.view.stage)) return undefined;
  const notice = waveNotice({ ...look, events: file.events }, "");
  return notice !== null && notice.card.tone === "attention" ? notice.key : undefined;
}

/** The task's open notice; a task of a wave that does not build: its wave's. */
async function taskKey(view: TaskView): Promise<string | undefined> {
  if (view.wave !== null) {
    const file = await findWave(view.wave).catch(() => undefined);
    if (file !== undefined && foldWave(file.declaration, file.events).stage !== "building") return waveKey(file);
  }
  const notice = taskNotice(view, "");
  return notice !== null && notice.card.tone === "attention" ? notice.key : undefined;
}

/**
 * The cause of an action on task `id`. `asked`: only a task in `waiting_answer` or `blocked` is settled (null: not a
 * decision). A wave's pending task (no record yet) answers its wave's notice.
 */
export async function taskCause(id: unknown, asked = false): Promise<Cause | null> {
  let record: TaskRecord;
  try {
    record = await findTask(id);
  } catch (error) {
    if (!(error instanceof FactoryError) || error.code !== "refused" || typeof id !== "string") throw error;
    const pending = await pendingWaveTask(id.trim());
    if (pending === undefined) throw error;
    return asked ? null : cause(await waveKey(await findWave(pending.wave)));
  }
  const view = await taskView(record);
  if (asked && view.state !== "waiting_answer" && view.state !== "blocked") return null;
  return cause(await taskKey(view));
}

/** The cause of an action on wave `id`. `stages`: only a wave in one of them is settled (null: not a decision). */
export async function waveCause(id: unknown, stages?: readonly WaveStage[]): Promise<Cause | null> {
  const file = await findWave(id);
  const answers = await waveKey(file, stages);
  if (stages !== undefined && answers === undefined) return null;
  return cause(answers);
}

/** The latest rejection or block among the waves of `store` that list the contract `name`. */
export async function contractCause(store: unknown, name: unknown): Promise<Cause> {
  let latest: { at: string; key: string } | undefined;
  for (const file of await listWaves()) {
    const fold = foldWave(file.declaration, file.events);
    if (fold.plan !== store || !(fold.contracts ?? []).includes(String(name))) continue;
    if (fold.stage !== "rejected" && fold.stage !== "blocked") continue;
    const key = await waveKey(file);
    const at = file.events.findLast((event) => event.kind === "stage")?.at ?? "";
    if (key !== undefined && (latest === undefined || at > latest.at)) latest = { at, key };
  }
  return cause(latest?.key);
}

export function decisionsPath(origin: string): string {
  if (origin === "" || origin === "." || origin === "..") throw new FactoryError("invalid", `"${origin}" is no session id`);
  return join(factoryHome(), "decisions", `${encodeURIComponent(origin)}.jsonl`);
}

/** Appends one decision to the log of `origin`. */
export async function appendDecision(origin: string, entry: DecisionEntry): Promise<void> {
  const path = decisionsPath(origin);
  await mkdir(join(factoryHome(), "decisions"), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
}

/** The decisions of `origin` in the order they were taken; none without a log. */
export async function readDecisions(origin: string): Promise<DecisionEntry[]> {
  const text = await readFile(decisionsPath(origin), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const entries: DecisionEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      entries.push(JSON.parse(line) as DecisionEntry);
    } catch {
      // A line a crash cut short.
    }
  }
  return entries;
}
