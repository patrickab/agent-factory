/**
 * The core's scout actions (`scouts.*`) over `scouts.ts`.
 * - `scouts.start`: the caller is the task whose worktree holds `cwd`, else the wave whose review worktree holds it,
 *   else the calling session. The store is the caller's `plan`, else the `store` param
 * - The scout runs on the project's small model: the wave's, else the repository's, else `defaults.yaml`'s when it is
 *   on the factory models list, else Pi's default
 */
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { memoryStore } from "./contracts.ts";
import { byId, nonEmpty, primaryOf, repoPath, stringsParam, type Handler } from "./core-shared.ts";
import { defaultSmallModel } from "./core-settings.ts";
import { waveReviewWorktree } from "./core-waves.ts";
import { git } from "./git.ts";
import { runCommand } from "./run.ts";
import { cancelScouts, scoutDirs, FINAL_SCOUT_STATES, SCOUT_ID_ENV, scoutView, startScout, type ScoutCaller, type ScoutView } from "./scouts.ts";
import { loadSettings } from "./settings.ts";
import { listTasks } from "./tasks.ts";
import { errorText, FactoryError } from "./util.ts";
import { listWaves } from "./waves.ts";

export { cancelScouts };

/** 15 minutes; `FACTORY_SCOUT_WAIT_MS` for tests. */
const scoutWaitMs = () => Number(process.env.FACTORY_SCOUT_WAIT_MS) || 15 * 60_000;
const WAIT_POLL_MS = 200;

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function inside(dir: string, root: string): boolean {
  const real = realPath(root);
  return dir === real || dir.startsWith(real + sep);
}

/** The caller of a scout started in `dir`, the store of its plan and the wave whose models it runs on. */
async function callerOf(dir: string, origin: string | undefined): Promise<{ caller: ScoutCaller; plan: string | null; wave: string | null }> {
  const task = (await listTasks()).find((record) => inside(dir, record.worktree));
  if (task) return { caller: { kind: "task", id: task.id }, plan: task.plan, wave: task.wave };
  const wave = (await listWaves()).find((file) => inside(dir, waveReviewWorktree(file.declaration)));
  if (wave) return { caller: { kind: "wave", id: wave.declaration.id }, plan: wave.declaration.plan, wave: wave.declaration.id };
  return { caller: { kind: "session", id: origin ?? null }, plan: null, wave: null };
}

async function smallModel(repo: string, waveId: string | null): Promise<string | null> {
  if (waveId !== null) {
    const wave = (await listWaves()).find((file) => file.declaration.id === waveId);
    const small = wave?.declaration.overrides.models?.small;
    if (small !== undefined) return small;
  }
  return (await loadSettings(repo)).models?.small ?? (await defaultSmallModel()) ?? null;
}

async function requireStore(store: string, cwd: string): Promise<void> {
  const result = await memoryStore(["ls", store], cwd);
  if (result.exitCode === null) throw new FactoryError("failed", "memory-store could not run: a scout needs it on PATH");
  if (result.exitCode !== 0) throw new FactoryError("refused", `memory store ${store} does not exist: a scout writes the map of an existing store`);
}

async function waitForScout(dir: string, signal: AbortSignal | undefined): Promise<{ scout: ScoutView; timedOut: boolean }> {
  const deadline = Date.now() + scoutWaitMs();
  for (;;) {
    const scout = await scoutView(dir);
    if (FINAL_SCOUT_STATES.includes(scout.state) || scout.interrupted || signal?.aborted) return { scout, timedOut: false };
    if (Date.now() >= deadline) return { scout, timedOut: true };
    await Bun.sleep(WAIT_POLL_MS);
  }
}

async function scoutDirOf(id: unknown): Promise<string> {
  return byId(await scoutDirs(), (dir) => dir.split("/").at(-1) ?? "", id, "scout");
}

export const SCOUT_HANDLERS = {
  "scouts.start": async (params, { cwd, env, origin, signal }) => {
    if (process.env[SCOUT_ID_ENV] !== undefined) throw new FactoryError("refused", "a scout starts no scout");
    const concern = nonEmpty(params.concern)?.trim();
    if (concern === undefined) throw new FactoryError("invalid", "scouts.start needs a concern that is not empty");
    const questions = stringsParam("scouts.start", "questions", params.questions) ?? [];
    if (params.store !== undefined && nonEmpty(params.store) === undefined) throw new FactoryError("invalid", "scouts.start: store must not be empty");
    const dir = realPath(params.repo === undefined ? (cwd ?? process.cwd()) : repoPath(params.repo as string, cwd));
    const repo = await primaryOf(dir, undefined);
    const { caller, plan, wave } = await callerOf(dir, origin);
    const store = plan ?? (params.store as string | undefined)?.trim();
    if (store === undefined) {
      throw new FactoryError("refused", `a scout needs a memory store: ${caller.kind === "session" ? "pass store" : `the ${caller.kind} has no plan, pass store`}`);
    }
    await requireStore(store, dir);
    const commit = await git(runCommand, dir, ["rev-parse", "HEAD"]).catch(() => {
      throw new FactoryError("refused", `${dir} has no commit to stamp the map's facts with`);
    });
    const declaration = { id: crypto.randomUUID(), caller, repo, cwd: dir, concern, questions, store, commit, model: await smallModel(repo, wave), createdAt: new Date().toISOString() };
    let scoutDir: string;
    try {
      scoutDir = await startScout(declaration, env);
    } catch (error) {
      throw new FactoryError("failed", `the scout did not start (${errorText(error)})`);
    }
    if (params.wait !== true) return { scout: await scoutView(scoutDir), timedOut: false };
    return waitForScout(scoutDir, signal);
  },

  "scouts.get": async (params) => ({ scout: await scoutView(await scoutDirOf(params.id)) }),
} satisfies Record<string, Handler>;
