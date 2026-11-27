#!/usr/bin/env bun
/**
 * `factory`: every core action (`core.ts`) on the command line. It only parses arguments, calls `callAction` and
 * prints the agent's text or, with `--json`, the full view. Also `factory actions`, `--help`, `--core-path` and
 * `factory slot -- <command...>` (a command holding a test slot, `test-slots.ts`).
 *
 * - A `FactoryError` goes to stderr as `factory: <code>: <message>`, exit 1 (`invalid`: exit 2)
 */
import { join } from "node:path";
import { agentActions, agentError } from "./agent-view.ts";
import { ACTIONS, callAction, FactoryError } from "./core.ts";
import { actionView, hasView } from "./factory-tool.ts";
import { runInSlot } from "./test-slots.ts";
import { errorText } from "./util.ts";

const USAGE = "usage: factory <action> [<json params> | -] [--json] | factory actions [<name>] [--json] | factory slot -- <command...> | factory --core-path | factory --help";
const JSON_FLAG = "--json";

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

function fail(error: unknown, json: boolean): number {
  const factoryError = error instanceof FactoryError ? error : new FactoryError("failed", errorText(error));
  const text = json ? `${factoryError.code}: ${factoryError.message}` : agentError({ code: factoryError.code, message: factoryError.message, detail: factoryError.detail });
  process.stderr.write(`factory: ${text}\n`);
  return factoryError.code === "invalid" ? 2 : 1;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** `factory actions [<name>] [--json]`. */
function actions(name: string | undefined, json: boolean): number {
  if (name !== undefined && !Object.hasOwn(ACTIONS, name)) return fail(new FactoryError("not_found", `no action ${name}`), json);
  if (json) printJson(name === undefined ? ACTIONS : ACTIONS[name as keyof typeof ACTIONS]);
  else process.stdout.write(`${agentActions(ACTIONS, name)}\n`);
  return 0;
}

/** `factory slot -- <command...>`. */
async function slot(args: string[]): Promise<number> {
  const argv = args[0] === "--" ? args.slice(1) : args;
  if (argv.length === 0) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  try {
    return await runInSlot(argv);
  } catch (error) {
    process.stderr.write(`factory: slot: ${errorText(error)}\n`);
    return 127;
  }
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
  if (first === "slot") return slot(rest);
  const json = rest.includes(JSON_FLAG);
  const positional = rest.filter((arg) => arg !== JSON_FLAG);
  if (first === undefined || positional.length > 1) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  if (first === "actions") return actions(positional[0], json);
  // tasks.wait can block for an hour; Ctrl-C ends it through the abort signal the core honours.
  const abort = new AbortController();
  process.once("SIGINT", () => abort.abort());
  try {
    const params = await readParams(positional[0]);
    const result = await callAction(first, params, { cwd: process.cwd(), signal: abort.signal });
    if (json || !hasView(first)) printJson(result);
    else process.stdout.write(`${actionView(first, params, result).text}\n`);
    return 0;
  } catch (error) {
    return fail(error, json);
  }
}

process.exitCode = await main(process.argv.slice(2));
