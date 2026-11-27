/**
 * Small helpers every factory module shares: the error clients see, error text, record check, the end of a command's
 * output, and reading and writing the factory's own files. Imports only `node:`, so every module may import it.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** How much of a failed command's output an error message keeps. */
export const ERROR_TAIL_CHARS = 1000;

export type FactoryErrorCode = "invalid" | "not_found" | "busy" | "refused" | "failed";

/** `{force: true}`: a refused `tasks.remove` that `force: true` would carry out. */
export type FactoryErrorDetail = { force: true };

/** One sentence with a code (`core.ts` names them). */
export class FactoryError extends Error {
  readonly code: FactoryErrorCode;
  readonly detail: FactoryErrorDetail | undefined;
  constructor(code: FactoryErrorCode, message: string, detail?: FactoryErrorDetail) {
    super(message);
    this.name = "FactoryError";
    this.code = code;
    this.detail = detail;
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The trimmed end of a command's output, `"killed"` when it printed nothing. */
export function outputTail(output: string, chars: number = ERROR_TAIL_CHARS): string {
  return output.trim().slice(-chars) || "killed";
}

/** Cost in cents. */
export function cents(cost: number): number {
  return Math.round(cost * 100) / 100;
}

/** An id as the views show it: its first 8 characters. */
export function short(id: string | null | undefined): string {
  return (id ?? "").slice(0, 8);
}

/** `$2.10`. */
export function dollars(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

/** `promise`'s value (a read of a file or directory), `missing` when that does not exist. */
export function ifMissing<T, M>(promise: Promise<T>, missing: M): Promise<T | M> {
  return promise.catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return missing;
    throw error;
  });
}

/** The JSON objects of `text`, one per line; a blank line or one a crash or a running append cut short is skipped. */
export function jsonLines<T = Record<string, unknown>>(text: string): T[] {
  return text.split("\n").flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line);
      return isRecord(value) ? [value as T] : [];
    } catch {
      return [];
    }
  });
}

/** `jsonLines` of the file `path`; none when it does not exist. */
export async function readJsonl<T = Record<string, unknown>>(path: string): Promise<T[]> {
  return jsonLines<T>(await ifMissing(readFile(path, "utf8"), ""));
}

/** Writes `text` to `path` through a temp file in its directory and a rename: a reader sees the old file or the new one. */
export async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temp, text, "utf8");
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
