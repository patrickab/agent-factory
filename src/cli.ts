#!/usr/bin/env bun
/**
 * `factory`: every core action (`core.ts`) on the command line. It only parses arguments and calls `callAction`.
 *
 * - `factory <action> [<json params> | -]`: `-` reads the params from stdin, none means `{}`; the result goes to stdout
 *   as JSON, exit 0. `cwd` is the caller's directory. `hostOnly` actions are available: the CLI is the host
 * - A `FactoryError` goes to stderr as `factory: <code>: <message>`, exit 1 (`invalid`: exit 2)
 * - `factory actions`: the `ACTIONS` map as JSON. `factory --core-path`: the absolute path of `core.ts`.
 *   `factory --help`: one line per action with its summary
 */
import { join } from "node:path";
import { ACTIONS, callAction, FactoryError } from "./core.ts";
import { errorText } from "./util.ts";

const USAGE = "usage: factory <action> [<json params> | -] | factory actions | factory --core-path | factory --help";

function helpText(): string {
  const lines = Object.entries(ACTIONS).map(([name, spec]) => `${name}  ${spec.summary}`);
  return [USAGE, ...lines].join("\n");
}

async function readParams(arg: string | undefined): Promise<unknown> {
  if (arg === undefined) return {};
  const text = arg === "-" ? await Bun.stdin.text() : arg;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new FactoryError("invalid", `params are not valid JSON: ${errorText(error)}`);
  }
}

function fail(error: unknown): number {
  const factoryError = error instanceof FactoryError ? error : new FactoryError("failed", errorText(error));
  process.stderr.write(`factory: ${factoryError.code}: ${factoryError.message}\n`);
  return factoryError.code === "invalid" ? 2 : 1;
}

async function main(args: string[]): Promise<number> {
  const [first, ...rest] = args;
  if (first === "--help" || first === "-h") {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  if (first === "--core-path") {
    process.stdout.write(`${join(import.meta.dirname, "core.ts")}\n`);
    return 0;
  }
  if (first === "actions") {
    process.stdout.write(`${JSON.stringify(ACTIONS, null, 2)}\n`);
    return 0;
  }
  if (first === undefined || rest.length > 1) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  // tasks.wait can block for an hour; Ctrl-C ends it through the abort signal the core honours.
  const abort = new AbortController();
  process.once("SIGINT", () => abort.abort());
  try {
    const result = await callAction(first, await readParams(rest[0]), { cwd: process.cwd(), signal: abort.signal });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    return fail(error);
  }
}

process.exitCode = await main(process.argv.slice(2));
