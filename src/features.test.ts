/**
 * The feature registry (`features.ts`, `feature.ts`): every feature's actions, handlers and renderers match, the order
 * is the list's, and a feature added to the list reaches the actions, the handlers, the renderers, the notices and the
 * tool's description without another edit (proven in a child process whose `features.ts` gets one more line).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTIONS } from "./core.ts";
import { FACTORY_TOOL_DESCRIPTION } from "./factory-tool.ts";
import { FEATURES } from "./features.ts";
import { pendingNotices } from "./notify.ts";

const CORE_FEATURES = ["settings", "tasks", "wait", "waves"];

describe("the features", () => {
  test("the core ones first, then the others sorted; names unique", () => {
    const names = FEATURES.map((feature) => feature.name);
    expect(names.slice(0, CORE_FEATURES.length)).toEqual(CORE_FEATURES);
    const rest = names.slice(CORE_FEATURES.length);
    expect(rest).toEqual([...rest].sort());
    expect(new Set(names).size).toBe(names.length);
  });

  test("each feature has a handler and a renderer for each of its actions, and nothing else", () => {
    for (const feature of FEATURES) {
      const names = Object.keys(feature.actions).sort();
      expect(Object.keys(feature.handlers).sort(), feature.name).toEqual(names);
      expect(Object.keys(feature.renderers).sort(), feature.name).toEqual(names);
    }
  });

  test("ACTIONS and the tool's description follow the list's order", () => {
    expect(Object.keys(ACTIONS)).toEqual(FEATURES.flatMap((feature) => Object.keys(feature.actions)));
    const at = FEATURES.flatMap((feature) => (feature.toolBlurb === undefined ? [] : [FACTORY_TOOL_DESCRIPTION.indexOf(feature.toolBlurb)]));
    expect(at.every((index) => index > 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(FACTORY_TOOL_DESCRIPTION).toStartWith("Run coding work in the background");
  });

  test("the notices follow the list's order: the gate proofs' before the scouts'", () => {
    const proof = { id: "9c1d0000-0000-4000-8000-000000000000", origin: "s1", state: "passed", interrupted: false, branch: "main", commit: "0ab12cd", failing: null, steps: [], flaky: [] };
    const scout = { id: "5c0a0000-0000-4000-8000-000000000000", caller: { kind: "session", id: "s1" }, state: "done", interrupted: false, reportPath: null, usage: null, error: null, concern: "c", report: "r", written: [] };
    const keys = pendingNotices([], [], new Set(), { scouts: [scout], gates: [proof] }).map((notice) => notice.key.split(":")[0]);
    const order = FEATURES.filter((feature) => feature.notices !== undefined).map((feature) => feature.name);
    expect(order).toEqual(["gates", "scouts"]);
    expect(keys).toEqual(["proof", "scout"]);
  });
});

describe("a feature added to features.ts", () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-features-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const src = import.meta.dir;

  test("reaches the actions, the handlers, the renderers, the notices and the tool text", () => {
    writeFileSync(
      join(dir, "demo.ts"),
      `import { feature, spec } from ${JSON.stringify(join(src, "feature.ts"))};
export const DEMO = feature({
  name: "demo",
  actions: { "demo.ping": spec("Answer pong", { word: { type: "string" } }, [], false) },
  get handlers() {
    return { "demo.ping": async (params) => ({ pong: params.word ?? "pong" }) };
  },
  renderers: { "demo.ping": (_params, result: { pong: string }) => "pong: " + result.pong },
  notices: (items) => items.map((item) => ({ key: "demo:" + String(item), origin: "s1", text: "factory: demo " + String(item) })),
  toolBlurb: '"demo.ping" answers pong.',
});
`,
    );
    // The one edit a new feature makes: its import and its line in the list.
    writeFileSync(
      join(dir, "plugin.ts"),
      `import { readFileSync } from "node:fs";
Bun.plugin({
  name: "one more feature",
  setup(build) {
    build.onLoad({ filter: /\\/src\\/features\\.ts$/ }, ({ path }) => {
      const text = readFileSync(path, "utf8");
      const edited = text.replace("] as const;", "  DEMO,\\n] as const;");
      if (edited === text) throw new Error("features.ts has no list to add to");
      return { contents: 'import { DEMO } from ${JSON.stringify(join(dir, "demo.ts"))};\\n' + edited, loader: "ts" };
    });
  },
});
`,
    );
    writeFileSync(
      join(dir, "probe.ts"),
      `const { ACTIONS, callAction } = await import(${JSON.stringify(join(src, "core.ts"))});
const { agentView } = await import(${JSON.stringify(join(src, "agent-view.ts"))});
const { FACTORY_TOOL_DESCRIPTION, agentActions } = await import(${JSON.stringify(join(src, "factory-tool.ts"))});
const { pendingNotices } = await import(${JSON.stringify(join(src, "notify.ts"))});
const result = await callAction("demo.ping", { word: "hi" });
console.log(JSON.stringify({
  last: Object.keys(ACTIONS).at(-1),
  result,
  text: agentView("demo.ping", {}, result),
  offered: agentActions().includes("demo.ping"),
  blurb: FACTORY_TOOL_DESCRIPTION.includes('"demo.ping" answers pong.'),
  notices: pendingNotices([], [], new Set(), { demo: ["x"] }).map((notice) => notice.key),
}));
`,
    );
    const child = Bun.spawnSync([process.execPath, "--preload", join(dir, "plugin.ts"), join(dir, "probe.ts")], { stdout: "pipe", stderr: "pipe" });
    expect(child.stderr.toString()).toBe("");
    expect(JSON.parse(child.stdout.toString())).toEqual({
      last: "demo.ping",
      result: { pong: "hi" },
      text: "pong: hi",
      offered: true,
      blurb: true,
      notices: ["demo:x"],
    });
  });
});
