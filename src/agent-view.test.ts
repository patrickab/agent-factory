import { expect, test } from "bun:test";
import { agentError } from "./agent-view.ts";
import { TASK_ID } from "./view-fixtures.ts";

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
