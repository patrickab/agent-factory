import { expect, test } from "bun:test";
import { sessionWidget } from "./session-widget.ts";
import { wave, waveTask } from "./view-fixtures.ts";

test("the waves that need the supervisor come first, no line exceeds the width, no path reaches it", () => {
  const at = (s: number) => `2025-01-02T10:00:0${s}.000Z`;
  const waves = [
    wave({ tag: "old", createdAt: at(1), title: "fix /home/me/git/app/src/x.ts" }),
    wave({ tag: "new", createdAt: at(9) }),
    wave({ tag: "rejected", stage: "rejected", running: false, createdAt: at(2) }),
    wave({ tag: "stuck", running: false, createdAt: at(3), tasks: [waveTask("a", "cancelled"), waveTask("b", "pending", ["a"])] }),
    wave({ tag: "merged", stage: "merged", running: false, createdAt: at(4) }),
  ];
  for (const width of [10, 40, 120]) {
    const lines = sessionWidget(waves, { showFinished: true, width });
    for (const line of lines) expect(Array.from(line).length).toBeLessThanOrEqual(width);
    expect(lines.join("\n")).not.toContain("/home/me");
  }
  const tags = sessionWidget(waves, { showFinished: false, width: 120 }).slice(1, 5).map((line) => line.trim().split(/\s+/)[1]);
  expect(tags.slice(0, 2).sort()).toEqual(["rejected", "stuck"]);
  expect(tags.slice(2)).toEqual(["new", "old"]);
});
