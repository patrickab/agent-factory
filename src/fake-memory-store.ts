/**
 * A fake `memory-store` CLI for tests (`ls`, `read [--no-ids]`, `apply --ops`), never the real one.
 *
 * - `writeFakeMemoryStore(bin)` writes the script into `bin` (put it on PATH); stores live under `$FAKE_STORE_ROOT`,
 *   one JSON file per store: `{memories: {path: [fact texts, oldest first]}, docs: {path: text}}`
 * - `writeStore`/`readStore` set and read a store directly: a test's direct edit of it
 * - Output as the real CLI prints it: `directories: a, b`, `- <path> ...` lines; `## <path>` then the text; a missing
 *   path `## <path> — not_found: ...` with exit 0; an unknown directory exit 1
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type FakeStore = { memories: Record<string, string[]>; docs: Record<string, string> };

export function writeFakeMemoryStore(bin: string): void {
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "memory-store"),
    `#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const noIds = args.includes("--no-ids");
const [command, store, ...rest] = args.filter((arg) => arg !== "--no-ids");
const file = join(process.env.FAKE_STORE_ROOT, encodeURIComponent(store) + ".json");
if (!existsSync(file)) {
  console.error("error: not_found: no memory_store " + store);
  process.exit(1);
}
const data = JSON.parse(readFileSync(file, "utf8"));
const out = [];
if (command === "ls") {
  const dir = rest[0];
  const under = [...Object.keys(data.memories), ...Object.keys(data.docs)].filter((path) => path.startsWith(dir + "/"));
  if (under.length === 0) {
    console.error("error: not_found: no directory " + dir);
    process.exit(1);
  }
  const dirs = new Set();
  const memories = [];
  const docs = [];
  for (const path of under) {
    const tail = path.slice(dir.length + 1);
    if (tail.includes("/")) dirs.add(dir + "/" + tail.split("/")[0]);
    else if (path in data.docs) docs.push(path);
    else memories.push(path);
  }
  if (dirs.size > 0) out.push("directories: " + [...dirs].join(", "));
  if (memories.length > 0) out.push("memories:", ...memories.map((path) => "- " + path + " — fake · 1 facts"));
  if (docs.length > 0) out.push("documents:", ...docs.map((path) => "- " + path + " · 1 bytes"));
} else if (command === "read") {
  for (const path of rest) {
    if (path in data.docs) out.push("## " + path, data.docs[path]);
    else if (path in data.memories) out.push("## " + path + " — fake", ...[...data.memories[path]].reverse().map((text, index) => "- " + (noIds ? "" : "[f" + index + "] ") + text));
    else out.push("## " + path + " — not_found: no memory " + path);
  }
} else if (command === "apply") {
  const ops = JSON.parse(rest[rest.indexOf("--ops") + 1]);
  for (const op of ops) {
    if (op.op === "add") (data.memories[op.path] ??= []).push(op.text);
    else if (op.op === "write_doc") data.docs[op.path] = op.text;
    else if (!(op.path in data.memories)) {
      console.log("failed " + op.op + " " + op.path + ": not_found");
      process.exit(1);
    } else if (op.op === "update") data.memories[op.path] = [...data.memories[op.path].slice(0, -1), op.text];
    else if (op.op === "retire") delete data.memories[op.path];
    out.push("ok " + op.op + " " + op.path);
  }
  writeFileSync(file, JSON.stringify(data));
} else {
  console.error("error: unknown command " + command);
  process.exit(2);
}
console.log(out.join("\\n"));
`,
  );
  chmodSync(join(bin, "memory-store"), 0o755);
}

function storeFile(root: string, store: string): string {
  return join(root, `${encodeURIComponent(store)}.json`);
}

export function writeStore(root: string, store: string, data: FakeStore): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(storeFile(root, store), JSON.stringify(data));
}

export function readStore(root: string, store: string): FakeStore {
  const path = storeFile(root, store);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as FakeStore) : { memories: {}, docs: {} };
}
