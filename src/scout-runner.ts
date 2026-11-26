/**
 * `bun scout-runner.ts <scout dir>`: one scout's detached runner (`scouts.ts` spawns it).
 *
 * - Queues while `SCOUT_LIMIT` scouts of its caller run (the caller's `queue.lock` around the count and the `running`
 *   event), then runs `pi -p` in the caller's working directory on the scout's model with the tools `read`, `grep`,
 *   `find`, `ls` and `map_write` (the extension `pi/scout-map-write.ts`), no other extension, skill or template
 * - Every assistant message appends the running usage totals: a killed scout's cost stays in its record
 * - The last assistant text is the report (`report.md`), the scout `done`; a failed child `failed`. A cancel (the
 *   `cancelled` event, then SIGTERM to the runner's group, the child in it) ends it without a report
 * - Imports only Bun, `node:` and plain plugin modules
 */
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./run.ts";
import { SCOUT_COMMIT_ENV, SCOUT_DIR_ENV, SCOUT_STORE_ENV } from "./scout-map.ts";
import {
  appendScoutEvent,
  callerKey,
  FINAL_SCOUT_STATES,
  readScout,
  runningScouts,
  SCOUT_EXTENSION_PATH,
  SCOUT_LIMIT,
  scoutsDir,
  ScoutOutput,
  type ScoutDeclaration,
} from "./scouts.ts";
import { lockFile, TaskBusyError, unlockFile } from "./tasks.ts";
import { errorText } from "./util.ts";

const POLL_MS = Number(process.env.FACTORY_SCOUT_POLL_MS) || 1_000;

/** Where memory-store keeps its stores: `MEMORY_STORE_ROOT`, else `~/.pi/memory_store`. */
function memoryStoreRoot(): string {
  return process.env.MEMORY_STORE_ROOT || join(homedir(), ".pi", "memory_store");
}

/** The scout's brief: the concern, the map, the rules and the report's shape. */
export function scoutPrompt(declaration: ScoutDeclaration, listing: string, mapDir: string): string {
  const questions = declaration.questions.length === 0 ? "" : `\n## Questions\n\n${declaration.questions.map((question, index) => `${index + 1}. ${question}`).join("\n")}\n`;
  return `You are a scout: you explore the code in your working directory, read-only, for a caller who needs one concern answered.

## Concern

${declaration.concern}
${questions}
## The map

The memory store ${declaration.store} keeps what scouts learned under map/. Its listing:

${listing.trim() || "(empty)"}

Each fact is a JSON file in ${mapDir} (read it with read). A fact ends with the commit it was explored at, \`(explored at <commit>)\`. The code is at commit ${declaration.commit}.

## How you work

1. Read the listing above and the facts on the concern first
2. Facts that carry commit ${declaration.commit} are current: answer from them without exploring again
3. Else explore with read, grep, find and ls, and write what you learn with map_write {path, description, text}: one concern per path under map/, each claim with file:line. A fact you find wrong you update (map_write on its path). The commit is stamped for you
4. You cannot change files, run commands or start scouts

## Your last message

The report, complete and untruncated, in exactly this shape:

MISSING
1. what the caller's plan or request does not cover, numbered

DECISIONS
- what the caller must rule on, with the options

KEY FACTS
- at most ten, each with file:line

MEMORY
- the map paths you wrote
`;
}

async function finalState(dir: string): Promise<boolean> {
  return FINAL_SCOUT_STATES.includes((await readScout(dir)).fold.state);
}

/** Waits for a free slot of the caller (`SCOUT_LIMIT`), then records `running`. False when the scout ended meanwhile. */
async function takeSlot(dir: string, declaration: ScoutDeclaration): Promise<boolean> {
  const lock = join(scoutsDir(), callerKey(declaration.caller), "queue.lock");
  for (;;) {
    if (await finalState(dir)) return false;
    let locked = false;
    try {
      await lockFile(lock, "the scout queue is busy");
      locked = true;
      if ((await runningScouts(declaration.caller)) < SCOUT_LIMIT) {
        if (await finalState(dir)) return false;
        await appendScoutEvent(dir, { kind: "state", state: "running" });
        return true;
      }
    } catch (error) {
      if (!(error instanceof TaskBusyError)) throw error;
    } finally {
      if (locked) await unlockFile(lock);
    }
    await Bun.sleep(POLL_MS);
  }
}

async function main(dir: string): Promise<void> {
  const { declaration } = await readScout(dir);
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let stopping = false;
  process.on("SIGTERM", () => {
    stopping = true;
    child?.kill("SIGTERM");
    if (child === undefined) process.exit(0);
  });
  if (!(await takeSlot(dir, declaration))) return;

  const listing = await runCommand(["memory-store", "ls", declaration.store, "map"], { cwd: declaration.cwd, maxStdoutChars: 200_000 });
  const mapDir = join(memoryStoreRoot(), declaration.store, "map");
  const promptFile = join(dir, "prompt.md");
  await writeFile(promptFile, scoutPrompt(declaration, listing.exitCode === 0 ? listing.stdout : "", mapDir));
  const argv = ["pi", "--mode", "json", "-p", "--tools", "read,grep,find,ls,map_write", "-ne", "-e", SCOUT_EXTENSION_PATH];
  argv.push("--no-skills", "--no-prompt-templates", "--no-themes", "--session-dir", join(dir, "session"));
  if (declaration.model !== null) argv.push("--model", declaration.model);
  argv.push(`Your brief as a scout is in ${promptFile}: read it with the read tool, follow it, and end with the report it describes.`);
  const env = { ...process.env, [SCOUT_DIR_ENV]: dir, [SCOUT_STORE_ENV]: declaration.store, [SCOUT_COMMIT_ENV]: declaration.commit };
  if (stopping) return;
  child = Bun.spawn(argv, { cwd: declaration.cwd, env, stdin: "ignore", stdout: "pipe", stderr: "inherit" });

  const output = new ScoutOutput();
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (output.line(line)) await appendScoutEvent(dir, { kind: "usage", usage: { ...output.usage } });
      newline = buffer.indexOf("\n");
    }
  }
  if (buffer.trim() !== "" && output.line(buffer)) await appendScoutEvent(dir, { kind: "usage", usage: { ...output.usage } });
  const exitCode = await child.exited;
  if (stopping || (await finalState(dir))) {
    if (!(await finalState(dir))) await appendScoutEvent(dir, { kind: "state", state: "cancelled" });
    return;
  }
  if (exitCode !== 0 || output.lastText === "") {
    await appendScoutEvent(dir, { kind: "state", state: "failed", error: exitCode !== 0 ? `pi exited with ${exitCode}` : "the scout ended without a report" });
    return;
  }
  await writeFile(join(dir, "report.md"), `${output.lastText}\n`);
  await appendScoutEvent(dir, { kind: "state", state: "done" });
}

if (import.meta.main) {
  const dir = process.argv[2];
  try {
    await main(dir);
  } catch (error) {
    console.error(`scout runner: ${errorText(error)}`);
    await appendScoutEvent(dir, { kind: "state", state: "failed", error: errorText(error) }).catch(() => undefined);
    process.exit(1);
  }
  process.exit(0);
}
