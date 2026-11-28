/**
 * A scout's writes to the map: `map_write {path, description, text}` (`pi/scout-map-write.ts`) runs `mapWrite`.
 * - The store and the commit come from the scout's environment, never from the model
 * - Every text ends with `explored at <commit>`; every write is appended to the scout's `written.jsonl`
 * - Imports only Bun, `node:` and plain plugin modules: the scout's Pi child loads it through its extension
 */
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { apply, create, facts } from "./store.ts";

export const SCOUT_DIR_ENV = "FACTORY_SCOUT_DIR";
export const SCOUT_STORE_ENV = "FACTORY_SCOUT_STORE";
export const SCOUT_COMMIT_ENV = "FACTORY_SCOUT_COMMIT";

const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** The memory path of `path` under `map/` (`map/` added when missing); throws for anything else. */
export function mapPath(path: string): string {
  const trimmed = path.trim().replace(/^\/+/, "");
  const full = trimmed.startsWith("map/") ? trimmed : `map/${trimmed}`;
  const segments = full.split("/");
  if (segments.length < 2 || segments.some((segment) => !SEGMENT.test(segment) || segment === "." || segment === "..")) {
    throw new Error(`map_write: path ${JSON.stringify(path)} must be segments of A-Z a-z 0-9 . _ - under map/`);
  }
  return full;
}

/** The text as it is stored: the scout's, then the commit it explored at. */
export function stampedText(text: string, commit: string): string {
  return `${text.trimEnd()}\n(explored at ${commit})`;
}

export interface MapWrite {
  store: string;
  commit: string;
  path: string;
  description: string;
  text: string;
  /** The scout's directory: the write is appended to its `written.jsonl`. */
  scoutDir?: string;
}

/** Adds the fact, or updates the path's newest one; resolves with what it did. */
export async function mapWrite(write: MapWrite): Promise<{ op: "add" | "update"; path: string }> {
  const path = mapPath(write.path);
  const description = write.description.trim();
  if (description === "") throw new Error("map_write: description must not be empty");
  if (write.text.trim() === "") throw new Error("map_write: text must not be empty");
  const text = stampedText(write.text, write.commit);
  // Idempotent: declares `map` in a store that lacks it, keeps the store's other directories.
  await create(write.store, "map");
  const newest = (await facts(write.store, path))[0]?.id;
  const op = newest === undefined ? "add" : "update";
  const ops = newest === undefined ? [{ op: "add", path, description, text }] : [{ op: "update", path, id: newest, text }, { op: "describe", path, description }];
  await apply(write.store, ops);
  if (write.scoutDir !== undefined) await appendFile(join(write.scoutDir, "written.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), op, path })}\n`);
  return { op, path };
}
