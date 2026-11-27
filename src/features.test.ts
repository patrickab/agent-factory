/** The feature registry (`features.ts`, `feature.ts`): every feature's actions, handlers, renderers and cards match. */
import { expect, test } from "bun:test";
import { FEATURES } from "./features.ts";

test("each feature has a handler for each of its actions, a renderer and a card for each but tasks.timeline, and nothing else", () => {
  for (const feature of FEATURES) {
    const names = Object.keys(feature.actions).sort();
    const viewed = names.filter((name) => name !== "tasks.timeline");
    expect(Object.keys(feature.handlers).sort(), feature.name).toEqual(names);
    expect(Object.keys(feature.renderers).sort(), feature.name).toEqual(viewed);
    expect(Object.keys(feature.cards).sort(), feature.name).toEqual(viewed);
  }
});
