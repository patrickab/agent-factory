/**
 * Decisions (contract `cards`): the cause a supervisor's action settles is read from state at call time, the card of
 * its tool result answers that notice's key, and the session's log lists them in order, also after a restart.
 */
import { describe, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { callAction, type TaskView } from "./core.ts";
import { caseDir, makeRepo, RUN, runnerEnded, startTask, stateOf, until, useCoreFixture } from "./core-test-kit.ts";
import { appendDecision, decisionsPath, readDecisions } from "./decisions.ts";
import { callFactoryTool } from "./factory-tool.ts";
import { taskNotice } from "./notify.ts";

useCoreFixture();

const tool = (params: Record<string, unknown>, origin: string) => callFactoryTool(params, false, { origin });

describe("decisions", () => {
  test("an answer to a question names that question's notice key; the log holds it under the session", async () => {
    const origin = `decide-q-${RUN}`;
    const repo = makeRepo();
    process.env.FAKE_PI_START_END = "waiting_answer";
    const record = await startTask(repo);
    await until(async () => (await stateOf(record)) === "waiting_answer");
    await until(() => runnerEnded(record));
    const asked = (await callAction("tasks.get", { id: record.id })) as TaskView;
    const question = taskNotice(asked, origin);
    expect(question?.key).toStartWith(`task:${record.id}:waiting_answer:`);
    const answer = await tool({ action: "tasks.message", id: record.id, text: "use the old table" }, origin);
    expect(answer.card).toMatchObject({ kind: "decision", answers: question?.key, text: "use the old table" });
    // The message started a runner: stopped without the tool, so the log keeps only the answer.
    await callAction("tasks.cancel", { id: record.id });
    await until(() => runnerEnded(record));
    expect(await readDecisions(origin)).toEqual([{ at: expect.any(String), card: answer.card }]);
  }, 30_000);

  test("the list is in order, skips a torn line and survives a restart", async () => {
    const origin = `decide-r-${RUN}`;
    const card = (title: string) => ({ v: 1 as const, kind: "decision" as const, tone: "quiet" as const, title });
    await appendDecision(origin, { at: "2026-01-01T00:00:01.000Z", card: card("first") });
    appendFileSync(decisionsPath(origin), '{"at": "2026-01-01T00:00:0');
    appendFileSync(decisionsPath(origin), "\n");
    await appendDecision(origin, { at: "2026-01-01T00:00:02.000Z", card: card("second") });
    const listed = (await callAction("decisions.list", { origin })) as { decisions: { card: { title: string } }[] };
    expect(listed.decisions.map((entry) => entry.card.title)).toEqual(["first", "second"]);
    expect(await callAction("decisions.list", {}, { origin })).toEqual(listed);

    // Another process (a restarted Pi) reads the same log.
    const child = Bun.spawnSync(["bun", "-e", `import { callAction } from ${JSON.stringify(`${import.meta.dir}/core.ts`)}; console.log(JSON.stringify(await callAction("decisions.list", { origin: ${JSON.stringify(origin)} })));`], {
      cwd: caseDir,
      env: process.env,
    });
    expect(JSON.parse(child.stdout.toString())).toEqual(listed);
    await expect(callAction("decisions.list", {})).rejects.toThrow("decisions.list needs origin");
  });
});
