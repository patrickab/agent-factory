/**
 * The `memory-store` CLI: the one place that calls it and parses its text output.
 * - `apply` and `create` throw `failed` with the output's tail; `read`, `facts` and `ls` say "not there" with null or none
 * - Imports only Bun, `node:` and plain plugin modules: the task runner and the scout's Pi child load it
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./run.ts";
import { onPath } from "./spawn.ts";
import { FactoryError, outputTail } from "./util.ts";

/** Where memory-store keeps its stores: `MEMORY_STORE_ROOT`, else `~/.pi/memory_store`. */
export function memoryStoreRoot(): string {
  return process.env.MEMORY_STORE_ROOT || join(homedir(), ".pi", "memory_store");
}

export function memoryStoreOnPath(): boolean {
  return onPath("memory-store") !== null;
}

async function run(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; output: string }> {
  const result = await runCommand(["memory-store", ...args], { cwd, maxStdoutChars: 5_000_000, timeoutMs: 60_000 });
  return { ok: result.exitCode === 0, stdout: result.stdout, output: result.output };
}

async function must(args: string[], cwd: string): Promise<string> {
  const result = await run(args, cwd);
  if (!result.ok) throw new FactoryError("failed", `memory-store ${args[0]} failed: ${outputTail(result.output, 500).replace(/\s*\n\s*/g, " ").trim()}`);
  return result.stdout;
}

/** Applies `ops` to `store`. */
export async function apply(store: string, ops: unknown[], cwd = "/"): Promise<void> {
  await must(["apply", store, "--ops", JSON.stringify(ops)], cwd);
}

/** Declares the directory `dir` in `store`; idempotent. */
export async function create(store: string, dir: string, cwd = "/"): Promise<void> {
  await must(["create", store, dir], cwd);
}

/**
 * The texts `memory-store read --no-ids` prints for `paths`, in one call, each without its header; null for one that is
 * not found. Each path's section starts at its `## <path>` header, found in order after the one before.
 */
export async function read(store: string, paths: readonly string[], cwd = "/"): Promise<(string | null)[]> {
  if (paths.length === 0) return [];
  const result = await run(["read", "--no-ids", store, ...paths], cwd);
  if (!result.ok) throw new Error(`memory-store read ${store} ${paths.join(" ")}: ${outputTail(result.output)}`);
  const lines = result.stdout.split("\n");
  const isHeader = (line: string, path: string) => line === `## ${path}` || line.startsWith(`## ${path} — `);
  const starts: number[] = [];
  for (const path of paths) {
    const from = starts.length === 0 ? 0 : (starts.at(-1) as number) + 1;
    const at = lines.findIndex((line, index) => index >= from && isHeader(line, path));
    if (at < 0) throw new Error(`memory-store read ${store}: no section for ${path}`);
    starts.push(at);
  }
  return paths.map((path, index) => {
    if (lines[starts[index]].startsWith(`## ${path} — not_found`)) return null;
    return lines.slice(starts[index] + 1, starts[index + 1] ?? lines.length).join("\n").trim();
  });
}

/** The facts of the memory `path` (`- [id] text` lines of `memory-store read`), newest first; none when it does not exist. */
export async function facts(store: string, path: string, cwd = "/"): Promise<{ id: string; text: string }[]> {
  const result = await run(["read", store, path], cwd);
  if (!result.ok) return [];
  return result.stdout.split("\n").flatMap((line) => {
    const match = /^- \[([^\]]+)\] (.*)$/.exec(line);
    return match === null ? [] : [{ id: match[1], text: match[2] }];
  });
}

/** What `memory-store ls` prints for `dir` (the store's root when omitted): the text, its subdirectories, its memories and documents; null when it does not exist. */
export async function ls(store: string, dir?: string, cwd = "/"): Promise<{ text: string; dirs: string[]; facts: string[] } | null> {
  const result = await run(["ls", store, ...(dir === undefined ? [] : [dir])], cwd);
  if (!result.ok) return null;
  const dirs: string[] = [];
  const names: string[] = [];
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("directories: ")) dirs.push(...line.slice("directories: ".length).split(", ").map((entry) => entry.trim()).filter((entry) => entry !== ""));
    else if (line.startsWith("- ")) names.push(line.slice(2).split(" ")[0]);
  }
  return { text: result.stdout, dirs, facts: names };
}
