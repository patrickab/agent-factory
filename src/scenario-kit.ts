/**
 * The scenario kit: a factory run end to end in a temp dir of its own. Real git, the real runners, the real `pi` with
 * the real plugin; only the model is faked, by a local OpenAI-compatible server that answers from the scenario's script.
 *
 * - `scenario(name, script, body)`: a `test` whose body gets a `Case`: its dir, a repo, `act` (= `callAction` with the
 *   repo as cwd and the case's origin), `until`, the notices its origin got, the model calls seen. The environment
 *   (`PI_CODING_AGENT_DIR`, `HOME`, git identity, `PI_OFFLINE`) is the case's while the body runs, restored after; its
 *   runners are stopped and the server closed
 * - The model: a request that ends on a tool result asks `Setup.afterTool`, else is answered "done" (the turn ends); any
 *   other asks the script, with the role (`reviewer` when `submit_verdict` is offered), the text of the last message and
 *   the request. A script that returns nothing ends the turn
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "bun:test";
import { callAction } from "./core.ts";
import { liveRunners, stopRunners } from "./launch.ts";
import { writeFakeMemoryStore, writeStore, type FakeStore } from "./fake-memory-store.ts";
import type { Notice } from "./notify.ts";
import { startNotifier } from "./pi/notifier.ts";
import { listTasks } from "./tasks.ts";
import { liveWaveRunners, stopWaveRunners } from "./wave-poke.ts";
import { listWaves } from "./waves.ts";

export type Role = "coder" | "reviewer";
export interface ModelCall {
  role: Role;
  /** The text of the last message (the prompt, a feedback, a notice). */
  prompt: string;
  /** The request's body as sent. */
  request: string;
}
export type ToolCall = { name: string; args: Record<string, unknown> };
/** One assistant message: tool calls, or text that ends the turn. */
export type Reply = ToolCall[] | string;
export type Script = (call: ModelCall) => Reply | undefined | Promise<Reply | undefined>;

export interface Case {
  dir: string;
  /** A repo on `main` with `factory.yaml` (`gates: []` unless the scenario gives one) and `a.txt`. */
  repo: string;
  origin: string;
  calls: ModelCall[];
  notices: Notice[];
  act(action: string, params?: Record<string, unknown>): Promise<any>;
  git(...args: string[]): string;
  until(check: () => boolean | Promise<boolean>, timeoutMs?: number): Promise<void>;
}

const ROOT = join(import.meta.dirname, "..");

export const write = (path: string, content: string): ToolCall => ({ name: "write", args: { path, content } });
export const bash = (command: string): ToolCall => ({ name: "bash", args: { command } });
export const verdict = (...findings: { file: string; severity: "blocker" | "major" | "minor"; text: string }[]): Reply => [
  { name: "submit_verdict", args: { findings: findings.map((finding) => ({ line: null, ...finding })) } },
];

/** The coder writes the file its request names (`WRITE <path>`); the reviewer approves. */
export const writesNamed: Script = ({ role, prompt }) => {
  if (role === "reviewer") return verdict();
  const path = prompt.match(/WRITE (\S+)/)?.[1];
  return path === undefined ? undefined : [write(path, `${path}\n`)];
};


function lastText(messages: { role: string; content: unknown }[]): string {
  const content = messages.at(-1)?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? "").join("") : "";
}

function serveModel(script: Script, calls: ModelCall[], afterTool?: Script) {
  let n = 0;
  const chunk = (delta: unknown, finish: string | null) =>
    `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 1000, completion_tokens: 100 } } : {}) })}\n\n`;
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const text = await request.text();
      const body = JSON.parse(text) as { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] };
      const call = { role: (body.tools ?? []).some((tool) => tool.function.name === "submit_verdict") ? "reviewer" : "coder", prompt: lastText(body.messages), request: text } as const;
      let reply: Reply | undefined;
      if (body.messages.at(-1)?.role === "tool") reply = await afterTool?.(call);
      else {
        calls.push(call);
        reply = await script(call);
      }
      reply ??= "done";
      const events =
        typeof reply === "string"
          ? [chunk({ role: "assistant", content: reply }, null), chunk({}, "stop")]
          : [
              chunk({ role: "assistant", tool_calls: reply.map((tool, index) => ({ index, id: `call_${++n}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } })) }, null),
              chunk({}, "tool_calls"),
            ];
      return new Response(`${events.join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    },
  });
}

/** The events of `notices`: `<task|wave>:<id>:<event>`, each key without its count. */
export const events = (notices: Notice[]): string[] => notices.map((notice) => notice.key.split(":").slice(0, 3).join(":"));

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(50);
  }
}

/** SIGTERM to the live runners of the task or wave `id`, as a host shutting down sends it. */
export async function terminate(id: string): Promise<void> {
  const record = (await listTasks()).find((task) => task.id === id);
  const pids = record === undefined ? await liveWaveRunners(id) : await liveRunners(record);
  if (pids.length === 0) throw new Error(`no runner of ${id}`);
  for (const pid of pids) process.kill(pid, "SIGTERM");
}

async function stopAll(): Promise<void> {
  // Wave runners first: they would start tasks while the tasks' runners stop.
  for (const wave of await listWaves()) await stopWaveRunners(wave.declaration.id);
  for (const record of await listTasks()) await stopRunners(record);
}

export interface Setup {
  /** `factory.yaml` of the repo. */
  factory?: string;
  /** The memory store `plan`, behind a fake `memory-store` CLI on PATH. */
  store?: FakeStore;
  /** Answers a request that ends on a tool result (default: "done"). */
  afterTool?: Script;
}

/** A test that runs `body` in a case of its own with the model answering from `script`. */
export function scenario(name: string, script: Script, body: (c: Case) => Promise<void>, setup: Setup = {}, timeoutMs = 60_000): void {
  test(
    name,
    async () => {
      const saved = { ...process.env };
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "factory-scenario-")));
      const calls: ModelCall[] = [];
      const notices: Notice[] = [];
      const server = serveModel(script, calls, setup.afterTool);
      const agent = join(dir, "agent");
      mkdirSync(join(agent, "factory"), { recursive: true });
      writeFileSync(
        join(agent, "models.json"),
        JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "local", models: [{ id: "m", name: "m", reasoning: false, input: ["text"], cost: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }] } } }),
      );
      writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "m", packages: [ROOT] }));
      writeFileSync(join(agent, "factory", "models.yaml"), "- fake/m\n");
      Object.assign(process.env, {
        HOME: dir,
        PI_CODING_AGENT_DIR: agent,
        PI_OFFLINE: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "test",
        GIT_COMMITTER_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_EMAIL: "test@example.com",
      });
      // Never the real `agent-worktree`: the factory makes the worktree with git.
      process.env.PATH = (process.env.PATH ?? "").split(":").filter((path) => path !== dirname(Bun.which("agent-worktree") ?? "/nonexistent/x")).join(":");
      if (setup.store !== undefined) {
        writeFakeMemoryStore(join(dir, "bin"));
        process.env.PATH = `${join(dir, "bin")}:${process.env.PATH}`;
        process.env.FAKE_STORE_ROOT = join(dir, "stores");
        writeStore(join(dir, "stores"), "plan", setup.store);
      }
      const repo = join(dir, "repo");
      mkdirSync(repo);
      git(repo, "init", "--quiet", "-b", "main");
      writeFileSync(join(repo, "a.txt"), "a\n");
      writeFileSync(join(repo, "factory.yaml"), setup.factory ?? "gates: []\n");
      git(repo, "add", "-A");
      git(repo, "commit", "--quiet", "-m", "init");
      const origin = crypto.randomUUID();
      const notifier = startNotifier({ origin, send: (_text, notice) => notices.push(notice), isTaskSession: () => false, debounceMs: 20, fallbackMs: 200 });
      try {
        await body({
          dir,
          repo,
          origin,
          calls,
          notices,
          act: (action, params = {}) => callAction(action, params, { cwd: repo, origin }),
          git: (...args) => git(repo, ...args),
          until,
        });
      } finally {
        notifier.stop();
        await stopAll();
        server.stop(true);
        for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
        Object.assign(process.env, saved);
        rmSync(dir, { recursive: true, force: true });
      }
    },
    timeoutMs,
  );
}
