/**
 * The agent view of the scout actions (`agent-view.ts` renders through it). Pure: no I/O, no import but types.
 *
 * - A scout: `scout <short id>  <state>  <cost>`, its concern, the report in full once done (untruncated), else the
 *   map paths it wrote so far
 */
import type { ScoutView } from "./scouts.ts";

function head(scout: ScoutView): string {
  const state = scout.interrupted ? "interrupted" : scout.state;
  return [`scout ${scout.id.slice(0, 8)}`, state, scout.usage ? `$${scout.usage.cost.toFixed(2)}` : null, scout.error].filter((part) => part !== null && part !== "").join("  ");
}

export function scoutBlock(scout: ScoutView, timedOut = false): string {
  const lines = [head(scout), `concern: ${scout.concern}`];
  if (scout.report !== null) lines.push("", scout.report.trimEnd());
  else {
    if (timedOut) lines.push("the wait ended before the report: what it wrote so far");
    lines.push(`written: ${scout.written.join(", ") || "nothing yet"}`);
  }
  return lines.join("\n");
}

export const SCOUT_RENDERERS = {
  "scouts.start": (_params: Record<string, unknown>, result: { scout: ScoutView; timedOut: boolean }) => scoutBlock(result.scout, result.timedOut),
  "scouts.get": (_params: Record<string, unknown>, result: { scout: ScoutView }) => scoutBlock(result.scout),
  "scouts.list": (_params: Record<string, unknown>, result: { scouts: ScoutView[] }) =>
    result.scouts.length === 0
      ? "no scouts"
      : result.scouts.map((scout) => `${head(scout)}  ${scout.caller.kind} ${(scout.caller.id ?? "-").slice(0, 8)}  ${scout.concern}`).join("\n"),
};
