import { expect, test } from "bun:test";
import { COMMIT_BODY_MAX_CHARS, COMMIT_BODY_MAX_LINES, commitMessageFallback, parseCommitMessage } from "./commitmsg.ts";

const bullets = (count: number, chars = 10) => Array.from({ length: count }, () => `- ${"x".repeat(chars)}`).join("\n");

test("a valid answer is title and bullets, a fenced one too; anything else is null and the task title is the fallback", () => {
  expect(parseCommitMessage("feat(ui)!: add a button\n\n- adds the button\n- wires it")).toEqual({ title: "feat(ui)!: add a button", body: "- adds the button\n- wires it" });
  expect(parseCommitMessage("```\nfix: a\n\n- b\n```")).toEqual({ title: "fix: a", body: "- b" });
  expect(parseCommitMessage(`feat: a\n\n${bullets(COMMIT_BODY_MAX_LINES)}`)).not.toBeNull();
  const invalid = [
    "Add a button\n\n- x",
    `feat: ${"x".repeat(70)}\n\n- x`,
    "feat: a\n- x",
    "feat: a\n\nprose",
    "feat: a",
    "",
    `feat: a\n\n${bullets(COMMIT_BODY_MAX_LINES + 1)}`,
    `feat: a\n\n${bullets(2, COMMIT_BODY_MAX_CHARS)}`,
    "feat: a\n\n- b\u0000c",
    "feat: a\u001b[31m\n\n- b",
  ];
  for (const answer of invalid) expect(parseCommitMessage(answer), answer).toBeNull();
  expect(commitMessageFallback("Add a button")).toEqual({ title: "Add a button", body: "" });
});
