import { expect, test } from "bun:test";
import { HEADER_ROW, rowLine, widgetRows } from "./session-widget.ts";
import { wave, waveTask } from "./view-fixtures.ts";

const at = (s: number) => `2025-01-02T10:00:0${s}.000Z`;
const labels = (rows: ReturnType<typeof widgetRows>) => rows.slice(1).map((row) => row.label.text);

test("the waves that need the supervisor come first, no line exceeds the width, no path reaches it", () => {
  const waves = [
    wave({ id: "1", tag: "old", createdAt: at(1), title: "fix /home/me/git/app/src/x.ts" }),
    wave({ id: "2", tag: "new", createdAt: at(9) }),
    wave({ id: "3", tag: "rejected", stage: "rejected", running: false, attention: true, createdAt: at(2) }),
    wave({ id: "4", tag: "stuck", running: false, stuck: true, attention: true, createdAt: at(3), tasks: [waveTask("a", "cancelled"), waveTask("b", "pending", ["a"])] }),
    wave({ id: "5", tag: "merged", stage: "merged", running: false, createdAt: at(4) }),
  ];
  for (const width of [1, 10, 40, 120]) {
    const lines = widgetRows(waves, { depth: "all" }).map((row) => rowLine(row, width));
    for (const line of lines) expect(Array.from(line).length).toBeLessThanOrEqual(width);
    expect(lines.join("\n")).not.toContain("/home/me");
  }
  const tags = labels(widgetRows(waves, { depth: "none" }));
  expect(tags.slice(0, 2).sort()).toEqual(["rejected", "stuck"]);
  expect(tags.slice(2)).toEqual(["old", "new", "1 finished"]);
});

test("tags nest, a group of one joins the label below it, what is finished folds, a toggled row is the opposite", () => {
  const tasks = [waveTask("a", "done"), waveTask("b", "running"), waveTask("c", "running")];
  const waves = [
    wave({ id: "1", tag: "plugin/m1/w1", stage: "merged", running: false, createdAt: at(1), tasks: [] }),
    wave({ id: "2", tag: "plugin/m1/w2", createdAt: at(2), tasks }),
    wave({ id: "3", tag: "plugin/m2/w1", stage: "queued", running: false, createdAt: at(3), tasks: [waveTask("d", "pending")] }),
    wave({ id: "4", tag: "docs/w1", stage: "reviewing", createdAt: at(4), tasks: [] }),
  ];
  const rows = widgetRows(waves);
  expect(labels(rows)).toEqual(["plugin", "m1", "w2", "a", "b", "c", "1 finished", "m2/w1", "docs/w1"]);
  expect(rows.map((row) => row.id)).toEqual([HEADER_ROW, "group:plugin", "group:plugin/m1", "wave:2", null, null, null, "finished:group:plugin/m1/", "wave:3", null]);
  // the header counts the two running coders and the reviewer
  expect(rows[0]!.facts.map((fact) => fact.text)).toContain("3 workers");
  expect(labels(widgetRows(waves, { toggled: new Set(["wave:2", "wave:3", "finished:group:plugin/m1/"]) }))).toEqual(["plugin", "m1", "w2", "1 finished", "w1", "m2/w1", "d", "docs/w1"]);
  expect(labels(widgetRows(waves, { depth: "none" }))).toEqual(["plugin", "docs/w1"]);
});
