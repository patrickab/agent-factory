/**
 * The detached process that holds a task's Pi session (`pi --mode rpc`) for one message, then lets Pi end:
 * `bun runner.ts <worktree> <sessionDir> <sessionId> <inboxPath> <message>`.
 * - Closes Pi's stdin once Pi answered, no run is active, no inbox line is unsent and the task rests after it left its
 *   rest (a command or message starts at rest). A `/` command or message the factory plugin did not handle is refused
 * - Inbox lines go to Pi as follow-ups; how far it was sent is stored before the send, so no line goes out twice. Lines
 *   that came after stdin closed start a successor runner, which gets the task lock
 * - Imports nothing outside node built-ins and the plain plugin modules: the deployed plugin has no `node_modules`
 */
import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { contractCheck } from "./contracts.ts";
import { rebuild, RESTING_STATES, type StateData } from "./state.ts";
import { handLockFile, unlockFile } from "./tasks.ts";
import { errorText, ifMissing, isRecord, jsonLines, writeAtomic } from "./util.ts";
import { pokeWave, TASK_WAVE_ENV } from "./wave-poke.ts";

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const CHECK_INTERVAL_MS = 2000;
const INBOX_POLL_MS = 250;
const KILL_GRACE_MS = 3000;
const PROMPT_ID = "1";
/** Set to `1` in the environment of the Pi a runner starts: that Pi holds a task's session (`tool.ts` reads it). */
export const TASK_SESSION_ENV = "FACTORY_TASK_SESSION";
/** The coder model of a `/factory start` (`launchTask`), for Pi's `--model`; Pi never sees it. */
export const CODER_MODEL_ENV = "FACTORY_CODER_MODEL";
/** The repository's `extensions` setting as JSON (`sendCommand`), absent when it has none; Pi never sees it. */
export const CODER_EXTENSIONS_ENV = "FACTORY_CODER_EXTENSIONS";
const PLUGIN_PATH = join(import.meta.dirname, "pi", "index.ts");

/** The session file Pi writes for `sessionId` in `sessionDir` (`<timestamp>_<sessionId>.jsonl`), if it exists yet. */
export async function sessionFilePath(sessionDir: string, sessionId: string): Promise<string | undefined> {
  const name = (await ifMissing(readdir(sessionDir), [])).find((file) => file.endsWith(".jsonl") && file.includes(sessionId));
  return name === undefined ? undefined : join(sessionDir, name);
}

/**
 * The entries of the session file at `path` (none: none), only the `custom` ones of `customType` when given. A torn line
 * is skipped. With `customType` a line is parsed only if it holds the type's name: most of a session is tool output, and
 * every state read would parse all of it.
 */
export async function sessionEntries(path: string | undefined, customType?: string): Promise<Record<string, unknown>[]> {
  const text = path === undefined ? "" : await ifMissing(readFile(path, "utf8"), "");
  if (customType === undefined) return jsonLines(text);
  const lines = text.split("\n").filter((line) => line.includes(`"${customType}"`));
  return jsonLines(lines.join("\n")).filter((entry) => entry.type === "custom" && entry.customType === customType);
}

/** The `factory-state` entries of the session file so far: how many, and the data of the last one. */
export async function readFactoryStates(sessionDir: string, sessionId: string): Promise<{ count: number; last: StateData | undefined }> {
  const states = await sessionEntries(await sessionFilePath(sessionDir, sessionId), "factory-state");
  return { count: states.length, last: states.at(-1)?.data as StateData | undefined };
}

/** The branch the task merges into (`Task.mainBranch`), `undefined` before its `factory-task` entry is written. */
export async function taskMainBranch(sessionDir: string, sessionId: string): Promise<string | undefined> {
  return rebuild(await sessionEntries(await sessionFilePath(sessionDir, sessionId), "factory-task"))?.task.mainBranch;
}

/** The data of the last `factory-state` entry of the session file, `undefined` before the first. */
export async function lastFactoryState(sessionDir: string, sessionId: string): Promise<StateData | undefined> {
  return (await readFactoryStates(sessionDir, sessionId)).last;
}

/** The commands that start from a resting state and must leave it before the runner may end. */
const LEAVES_REST = /^\/factory\s+(approve|retry|reviewed)(\s|$)/;

/** The sidecar of an inbox that holds how many of its bytes have been sent to Pi (`<inbox>.read`). */
export function inboxReadPath(inboxPath: string): string {
  return `${inboxPath}.read`;
}

async function readInboxOffset(inboxPath: string): Promise<number> {
  const text = await readFile(inboxReadPath(inboxPath), "utf8").catch(() => "0");
  const offset = Number(text.trim());
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
}

/** Atomic: a reader never sees a torn offset. */
async function writeInboxOffset(inboxPath: string, offset: number): Promise<void> {
  await writeAtomic(inboxReadPath(inboxPath), `${offset}\n`);
}

/** The complete lines of the inbox after `offset` (a line still being written stays), and the offset after them. */
async function unreadInboxLines(inboxPath: string, offset: number): Promise<{ texts: string[]; next: number }> {
  const bytes = await ifMissing(readFile(inboxPath), null);
  if (bytes === null) return { texts: [], next: offset };
  const end = bytes.lastIndexOf(0x0a) + 1;
  if (end <= offset) return { texts: [], next: offset };
  const texts: string[] = [];
  for (const line of bytes.subarray(offset, end).toString("utf8").split("\n")) {
    const text = inboxLineText(line);
    if (text !== undefined) texts.push(text);
  }
  return { texts, next: end };
}

/** The message of an inbox line; a line that is no `{"text": ...}` is reported and has none. */
function inboxLineText(line: string): string | undefined {
  if (line.trim() === "") return undefined;
  try {
    const entry: unknown = JSON.parse(line);
    if (isRecord(entry) && typeof entry.text === "string") return entry.text;
  } catch {
    // reported below
  }
  console.error(`runner: an inbox line that is no {"text": ...}: ${line.slice(0, 200)}`);
  return undefined;
}

const START_PREFIX = "/factory start ";

/**
 * Pi's arguments for `message`. `/factory start` with a coder model (`CODER_MODEL_ENV`, set by `launchTask`):
 * `--model` with it, so the session starts on the coder's model and the plugin need not switch to it (`setModel` fires
 * `model_select`, which an extension such as `@xynogen/pix-models` answers by writing `defaultProvider`/`defaultModel`
 * into `<worktree>/.pi/settings.json`, and the factory's commit of the worktree then took that file). With
 * `CODER_EXTENSIONS_ENV`: `-ne`, the factory's plugin and one `-e` per listed source.
 */
function piArgs(sessionDir: string, sessionId: string, message: string): string[] {
  const args = ["--mode", "rpc", "--session-dir", sessionDir, "--session-id", sessionId];
  const extensions = process.env[CODER_EXTENSIONS_ENV];
  if (extensions) args.push("-ne", ...[PLUGIN_PATH, ...(JSON.parse(extensions) as string[])].flatMap((source) => ["-e", source]));
  const model = process.env[CODER_MODEL_ENV];
  return model && message.trimStart().startsWith(START_PREFIX) ? [...args, "--model", model] : args;
}

/** The follow-ups of the task's changed contracts (`contractCheck`), null when none; a failed look is logged and says none. */
async function contractNotes(sessionId: string): Promise<string | null> {
  try {
    return await contractCheck(sessionId);
  } catch (error) {
    console.error(`runner: looking at the task's contracts: ${errorText(error)}`);
    return null;
  }
}

/**
 * Runs the message to the task's rest, sending the lines of `inboxPath` meanwhile, and resolves with the runner's exit
 * code.
 */
export async function runTaskCommand(worktree: string, sessionDir: string, sessionId: string, inboxPath: string, command: string): Promise<number> {
  const startCount = (await readFactoryStates(sessionDir, sessionId)).count;
  /** Not a command: a message for the coder, which the factory plugin opens a run for (a `factory-state` entry). */
  const plain = !command.trimStart().startsWith("/");
  // Before a coder turn this runner starts: a changed contract goes with its message (an answer included).
  const startNotes = plain ? await contractNotes(sessionId) : null;
  const message = startNotes === null ? command : `${command}\n\n${startNotes}`;
  const mustLeave = plain || LEAVES_REST.test(message.trim());
  let inboxOffset = await readInboxOffset(inboxPath);
  const pi = Bun.spawn(["pi", ...piArgs(sessionDir, sessionId, message)], {
    cwd: worktree,
    env: { ...process.env, [TASK_SESSION_ENV]: "1", [TASK_WAVE_ENV]: undefined, [CODER_MODEL_ENV]: undefined, [CODER_EXTENSIONS_ENV]: undefined },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  let answered = false;
  let refused = false;
  /** The factory command reported an error before Pi answered: it changed nothing and starts no run. */
  let commandFailed = false;
  /** A plain message Pi started or queued a run for: the factory plugin must write a `factory-state` entry for it. */
  let plainRun = false;
  let runActive = false;
  /** How many `agent_start` events came so far. */
  let runsStarted = 0;
  /** A prompt Pi answered `started` for, whose run has not begun yet. */
  let runExpected = false;
  /** The prompts sent and not answered yet, with `runsStarted` when each was sent. */
  const unanswered = new Map<string, number>();
  let inboxSent = 0;
  let stdinClosed = false;
  let checking = false;
  let recheck = false;

  const send = (record: Record<string, unknown>) => {
    if (stdinClosed) return;
    try {
      pi.stdin.write(`${JSON.stringify(record)}\n`);
      void pi.stdin.flush();
    } catch {
      // Pi is already gone
    }
  };
  const closeStdin = () => {
    if (stdinClosed) return;
    stdinClosed = true;
    try {
      void pi.stdin.end();
    } catch {
      // Pi is already gone
    }
  };
  const refuse = (why: string) => {
    refused = true;
    console.error(`runner: ${why}`);
    send({ type: "abort" });
    closeStdin();
  };
  const sendPrompt = (id: string, text: string, followUp: boolean) => {
    unanswered.set(id, runsStarted);
    send(followUp ? { id, type: "prompt", message: text, streamingBehavior: "followUp" } : { id, type: "prompt", message: text });
  };
  /**
   * Inbox lines go to Pi while the task's run is active and running, or while no run is active and the task rests
   * after this runner's command left its rest; never while it merges (the plugin would drop them).
   */
  const sendInbox = async (state: StateData | undefined, left: boolean): Promise<boolean> => {
    if (state === undefined || state.state === "merging") return false;
    const open = runActive ? state.state === "running" : RESTING_STATES.includes(state.state) && left && !commandFailed;
    if (!open) return false;
    const { texts, next } = await unreadInboxLines(inboxPath, inboxOffset);
    if (next === inboxOffset) return false;
    // The offset is stored before the lines go out: a line is never sent twice, by this runner or the next.
    await writeInboxOffset(inboxPath, next);
    inboxOffset = next;
    if (texts.length > 0) {
      const notes = await contractNotes(sessionId);
      if (notes !== null) texts[texts.length - 1] = `${texts.at(-1)}\n\n${notes}`;
    }
    for (const text of texts) sendPrompt(`inbox-${++inboxSent}`, text, true);
    return texts.length > 0;
  };
  const inboxUnread = async (): Promise<boolean> => (await unreadInboxLines(inboxPath, inboxOffset)).next > inboxOffset;
  /** A coder run began (the plugin's next round, a retry): a changed contract goes to it as a follow-up. */
  const contractFollowUp = async () => {
    if ((await lastFactoryState(sessionDir, sessionId).catch(() => undefined))?.state !== "running" || stdinClosed) return;
    const notes = await contractNotes(sessionId);
    if (notes !== null) sendPrompt(`contract-${++inboxSent}`, notes, true);
  };
  /** One look at the session state and the inbox: sends unread lines, refuses or ends when it is time. */
  const checkOnce = async () => {
    const { count, last } = await readFactoryStates(sessionDir, sessionId);
    if (stdinClosed) return;
    const left = !mustLeave || count > startCount;
    if (await sendInbox(last, left)) return;
    if (runActive || runExpected || unanswered.size > 0) return;
    if (plainRun && runsStarted > 0 && count === startCount) {
      return refuse("pi ran the message without the factory plugin (no factory-state entry): is the agent-factory Pi package installed (`pi install <path of the agent-factory clone>`)?");
    }
    // A line that came in and cannot go out yet keeps Pi open; one that comes after `closeStdin` waits for the next runner.
    if (await inboxUnread()) return;
    if (commandFailed) return closeStdin();
    const resting = last !== undefined && RESTING_STATES.includes(last.state);
    if (resting && left) closeStdin();
  };
  const check = async () => {
    if (!answered || stdinClosed) return;
    if (checking) {
      recheck = true;
      return;
    }
    checking = true;
    try {
      do {
        recheck = false;
        await checkOnce();
      } while (recheck && !stdinClosed);
    } catch (error) {
      console.error(`runner: reading the session state or the inbox: ${errorText(error)}`);
    } finally {
      checking = false;
    }
  };
  const onResponse = (id: string, record: Record<string, unknown>) => {
    const sentAt = unanswered.get(id);
    unanswered.delete(id);
    const disposition = isRecord(record.data) ? record.data.disposition : undefined;
    if (record.success === true && disposition === "started" && sentAt === runsStarted) runExpected = true;
    if (id !== PROMPT_ID) {
      if (record.success !== true) console.error(`runner: pi refused an inbox message: ${String(record.error)}`);
      return;
    }
    answered = true;
    if (record.success !== true) {
      refused = true;
      console.error(`runner: pi refused the prompt: ${String(record.error)}`);
      closeStdin();
    } else if (plain && (disposition === "started" || disposition === "queued")) {
      plainRun = true;
    } else if (disposition !== "handled") {
      refuse(`pi did not run the prompt as a command (disposition ${String(disposition)}): is the agent-factory Pi package installed (\`pi install <path of the agent-factory clone>\`)?`);
    }
  };
  const onRecord = (record: unknown) => {
    if (!isRecord(record)) return;
    if (record.type === "response" && typeof record.id === "string" && (record.id === PROMPT_ID || unanswered.has(record.id))) {
      onResponse(record.id, record);
    } else if (record.type === "agent_start") {
      runActive = true;
      runsStarted += 1;
      runExpected = false;
      void contractFollowUp();
    } else if (record.type === "agent_settled") {
      runActive = false;
    } else if (record.type === "extension_ui_request" && typeof record.method === "string" && DIALOG_METHODS.has(record.method)) {
      send({ type: "extension_ui_response", id: record.id, cancelled: true });
    } else if (!answered && record.type === "extension_ui_request" && record.method === "notify" && record.notifyType === "error") {
      const text = String(record.message);
      console.error(`runner: ${text}`);
      if (text.startsWith("factory: ")) commandFailed = true;
    }
    void check();
  };

  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (signal: NodeJS.Signals) => {
    console.error(`runner: ${signal}, stopping pi`);
    closeStdin();
    killTimer ??= setTimeout(() => pi.kill("SIGKILL"), KILL_GRACE_MS);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const tick = setInterval(() => void check(), CHECK_INTERVAL_MS);
  let inboxSize = -1;
  const inboxWatch = setInterval(() => {
    void stat(inboxPath).then(
      (stats) => {
        if (stats.size === inboxSize) return;
        inboxSize = stats.size;
        if (stats.size > inboxOffset) void check();
      },
      () => undefined,
    );
  }, INBOX_POLL_MS);

  unanswered.set(PROMPT_ID, 0);
  send(plain ? { id: PROMPT_ID, type: "prompt", message, streamingBehavior: "followUp" } : { id: PROMPT_ID, type: "prompt", message });

  // Records are split on LF only: a JSON string may hold U+2028/U+2029.
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of pi.stdout) {
    pending += decoder.decode(chunk, { stream: true });
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      const line = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
      if (line.trim() === "") continue;
      try {
        onRecord(JSON.parse(line));
      } catch {
        console.error(`runner: not a protocol record: ${line.slice(0, 200)}`);
      }
    }
  }
  const exitCode = await pi.exited;
  clearInterval(tick);
  clearInterval(inboxWatch);
  clearTimeout(killTimer);
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
  if (answered && !refused && killTimer === undefined) {
    await startSuccessor([worktree, sessionDir, sessionId, inboxPath], inboxOffset).catch((error: unknown) =>
      console.error(`runner: starting the runner for the inbox lines left: ${errorText(error)}`),
    );
  }
  if (!answered) {
    console.error(`runner: pi exited (${exitCode}) before it answered the prompt`);
    return exitCode === 0 ? 1 : exitCode;
  }
  if (refused && exitCode === 0) return 1;
  return exitCode;
}

/**
 * When inbox lines past `offset` came after stdin closed and the task rests: a new detached runner (same output, same
 * environment) with the first line as its message, that line marked sent first, and the task lock handed to it.
 */
async function startSuccessor(args: [worktree: string, sessionDir: string, sessionId: string, inboxPath: string], offset: number): Promise<void> {
  const [, sessionDir, sessionId, inboxPath] = args;
  const state = await lastFactoryState(sessionDir, sessionId);
  if (state === undefined || !RESTING_STATES.includes(state.state)) return;
  const bytes = await readFile(inboxPath).catch(() => undefined);
  if (bytes === undefined) return;
  // The first complete line that holds a message; a broken line before it is passed over.
  let first: { text: string; end: number } | undefined;
  for (let start = offset; first === undefined; ) {
    const end = bytes.indexOf(0x0a, start) + 1;
    if (end === 0) return;
    const text = inboxLineText(bytes.subarray(start, end).toString("utf8"));
    if (text !== undefined) first = { text, end };
    start = end;
  }
  await writeInboxOffset(inboxPath, first.end);
  let pid: number | undefined;
  try {
    const child = spawn(process.execPath, [import.meta.path, ...args, first.text], { detached: true, stdio: ["ignore", "inherit", "inherit"], env: process.env });
    await new Promise<void>((resolveSpawn, reject) => {
      child.once("spawn", () => resolveSpawn());
      child.once("error", reject);
    });
    child.unref();
    pid = child.pid;
  } catch (error) {
    await writeInboxOffset(inboxPath, offset);
    throw error;
  }
  const lock = process.env.FACTORY_TASK_LOCK;
  if (pid !== undefined && lock) await handLockFile(lock, pid);
}

/** Pokes the task's wave (`FACTORY_TASK_WAVE`) when the task rests. */
async function pokeTaskWave(sessionDir: string, sessionId: string): Promise<void> {
  const wave = process.env[TASK_WAVE_ENV];
  if (wave === undefined || wave === "") return;
  const state = await lastFactoryState(sessionDir, sessionId);
  if (state === undefined || !RESTING_STATES.includes(state.state)) return;
  await pokeWave(wave);
}

if (import.meta.main) {
  const [worktree, sessionDir, sessionId, inboxPath, message] = process.argv.slice(2);
  if (!worktree || !sessionDir || !sessionId || !inboxPath || message === undefined) {
    console.error("usage: bun runner.ts <worktree> <sessionDir> <sessionId> <inboxPath> <message>");
    process.exit(2);
  }
  runTaskCommand(worktree, sessionDir, sessionId, inboxPath, message)
    .catch((error: unknown) => {
      console.error(`runner: ${errorText(error)}`);
      return 1;
    })
    .then(async (code) => {
      await pokeTaskWave(sessionDir, sessionId).catch((error: unknown) => console.error(`runner: poking the task's wave: ${errorText(error)}`));
      // The task lock handed to this runner, unless it names another holder by now.
      const lock = process.env.FACTORY_TASK_LOCK;
      if (lock) await unlockFile(lock).catch((error: unknown) => console.error(`runner: releasing the task lock: ${errorText(error)}`));
      process.exit(code);
    });
}
