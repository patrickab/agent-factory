/** The feature registry (`features.ts`, `feature.ts`): every feature's handlers match its actions. */
import { expect, test } from "bun:test";
import { FEATURES } from "./features.ts";

test("each feature has a handler for each of its actions and nothing else", () => {
  for (const feature of FEATURES) expect(Object.keys(feature.handlers).sort(), feature.name).toEqual(Object.keys(feature.actions).sort());
});
