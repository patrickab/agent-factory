/**
 * The diff a task's reviewer reads through `read_diff` (`pi/reviewer-tool.ts`): the factory writes a `TaskDiff` as
 * JSON to a file per review and names it in `REVIEW_DIFF_ENV`. Pure but for nothing: no git, no I/O.
 */
import { reviewPatch } from "./review.ts";

export const REVIEW_DIFF_ENV = "FACTORY_REVIEW_DIFF";
const PATCH_MAX_CHARS = 200_000;

/** The file sections of a `git diff` patch with the path each names (`diff --git a/<path> b/<path>`), in order. */
function sections(patch: string): { path: string; text: string }[] {
  const parts = patch.split(/^(?=diff --git )/m).filter((part) => part !== "");
  return parts.map((text) => {
    const head = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
    const match = / b\/(.*)$/.exec(head);
    return { path: match?.[1] ?? "", text };
  });
}

function wanted(path: string, paths: readonly string[]): boolean {
  return paths.some((want) => {
    const clean = want.replace(/^\.\//, "").replace(/\/+$/, "");
    return path === clean || path.startsWith(`${clean}/`);
  });
}

/** `read_diff`'s text of the diff file `json` (`{paths, patch}`): all of it, or only `paths` when given. */
export function readDiffText(json: string, paths?: readonly string[]): string {
  const diff = JSON.parse(json) as { paths: string[]; patch: string };
  if (diff.patch.trim() === "") return "Nothing changed since the tree you judged last.";
  if (paths === undefined || paths.length === 0) return reviewPatch(diff, PATCH_MAX_CHARS);
  const chosen = diff.paths.filter((path) => wanted(path, paths));
  const patch = sections(diff.patch)
    .filter((section) => wanted(section.path, paths))
    .map((section) => section.text)
    .join("");
  if (chosen.length === 0) return `None of ${paths.join(", ")} changed. Changed: ${diff.paths.join(", ")}`;
  return reviewPatch({ paths: chosen, patch }, PATCH_MAX_CHARS);
}
