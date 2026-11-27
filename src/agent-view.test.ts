import { expect, test } from "bun:test";
import { agentError, agentView, hasAgentView } from "./agent-view.ts";
import { ACTIONS } from "./core.ts";
import { FIXTURES, SESSION, TASK_ID } from "./view-fixtures.ts";

test("every action but tasks.timeline renders, and no rendering holds a path, a timestamp, a session id, the request or the patch", () => {
  expect(Object.keys(ACTIONS).filter((name) => !hasAgentView(name))).toEqual(["tasks.timeline"]);
  const forbidden = [/\/home/, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, new RegExp(SESSION.slice(0, 13)), /SECRET-REQUEST/, /secret patch/];
  for (const name of Object.keys(ACTIONS).filter(hasAgentView)) {
    const fixture = FIXTURES[name];
    expect(fixture, `fixture for ${name}`).toBeDefined();
    const text = agentView(name, fixture.params, fixture.result);
    expect(text.length, name).toBeGreaterThan(0);
    for (const pattern of forbidden) expect(text, name).not.toMatch(pattern);
  }
  // The one exception: the repository paths an agent passes back.
  expect(agentView("repos.list", {}, { repos: ["/srv/app"] })).toContain("/srv/app");
});

test("receipts of mutations are one line", () => {
  for (const name of Object.keys(ACTIONS).filter((action) => ACTIONS[action as keyof typeof ACTIONS].mutates && !["settings.set", "scouts.start"].includes(action))) {
    const fixture = FIXTURES[name];
    expect(agentView(name, fixture.params, fixture.result).split("\n").length, name).toBe(1);
  }
});

test("an error is one line with the way out, no path and no full id", () => {
  for (const error of [
    { code: "refused", message: "wave 3f2a91c0 is merged, nothing can be added" },
    { code: "invalid", message: `"4a" matches 2 tasks (${TASK_ID}, 4a01c9d2-0000-4000-8000-000000000000), give more of the id` },
    { code: "not_found", message: "/home/me/x is not inside a git repository" },
    { code: "busy", message: "a\nb" },
  ] as const) {
    const text = agentError(error);
    expect(text.split("\n")).toHaveLength(1);
    expect(text).toContain("next:");
    expect(text).not.toContain("/home/me");
    expect(text).not.toContain(TASK_ID);
  }
});
