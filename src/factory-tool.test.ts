import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callFactoryTool, FACTORY_TOOL_DESCRIPTION } from "./factory-tool.ts";
import { loadModels } from "./models.ts";

let dir: string;
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.PI_CODING_AGENT_DIR;
  dir = mkdtempSync(join(tmpdir(), "factory-tool-"));
  process.env.PI_CODING_AGENT_DIR = dir;
});

afterEach(() => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

test("a view that fails to render after a mutating action succeeded is a receipt, not a failure", async () => {
  const broken = () => {
    throw new Error("unexpected shape\nmore");
  };
  const { text, result } = await callFactoryTool({ action: "models.set", models: ["a/b"] }, false, {}, broken);
  expect(await loadModels()).toEqual(["a/b"]);
  expect(result).toEqual({ models: ["a/b"] });
  expect(text).toBe("models.set done; its answer could not be shown (unexpected shape), do not repeat it: look with tasks.get, waves.get or the lists");
});

test("the tool's description, pinned: its sentences in the features' order (changed with the feature registry), the closing ones last", () => {
  expect(FACTORY_TOOL_DESCRIPTION).toBe(
    [
    "Run coding work in the background: a task codes in its own git worktree of a repository with a committed factory.yaml, passes its gates and merges into its target.",
    "\"tasks.start\" one self-contained task; \"waves.start\" a planned set of tasks (after = keys a task waits for) on one branch, each task reviewed, then the whole, merged once; its after = tags or ids of waves it waits for: it stays queued until they are merged.",
    "\"contracts.apply\" changes one fact of a contract the waves list and tells their tasks.",
    "\"decisions.list\" lists the decisions of a session (your settling actions and what each answers).",
    "\"gates.prove\" runs a branch's merge_gates in the background before a wave is declared on it: passed, flaky or failing.",
    "\"tasks.update\" and \"waves.update\" adjust a declared plan (a pending task fully, a started one its title and request); coders report what cost runtime or context with their feedback tool, \"waves.get\" lists it.",
    "\"scouts.start\" sends a read-only scout that answers a concern from the map of a memory store (wait: true for its report, else it reports back).",
    "Answers are short text: an id (8 chars are enough), the state, what matters in it, and \"next:\" with the actions valid now.",
    "Tasks and waves started from a Pi session report back to it when they need you; elsewhere block on \"tasks.wait\" (ids, tag or wave) instead of polling.",
    "A tag (path segments like plugin/m1/w1) groups related work for tasks.list, waves.list and tasks.wait. Every answer and notice also carries a card for the user, never in your context; an action that settles a question, rejection or block is recorded as a decision on its own: pass nothing for it.",
    ].join(" "),
  );
});
