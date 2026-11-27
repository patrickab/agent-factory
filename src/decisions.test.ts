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
import { waveLook } from "./core-waves.ts";
import { taskNotice, waveNotice } from "./notify.ts";
import { liveWaveRunners, pokeWave, stopWaveRunners } from "./wave-poke.ts";
import { appendWaveEvent, createWave, readWave, type WaveView } from "./waves.ts";

useCoreFixture();

const spec = (key: string) => ({ key, title: `Task ${key}`, request: `do ${key}`, after: [], id: crypto.randomUUID() });
const tool = (params: Record<string, unknown>, origin: string) => callFactoryTool(params, false, { origin }, () => "text");

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

  test("a task added to a rejected wave names the rejection; then an action with no open cause is a decision without answers", async () => {
    const origin = `decide-w-${RUN}`;
    const repo = makeRepo();
    await callAction("repos.add", {}, { cwd: repo });
    const started = (await callAction("waves.start", { tag: "factory/d1", title: "Wave", request: "review", tasks: [spec("a")] }, { cwd: repo, origin })) as { wave: WaveView };
    const id = started.wave.id;
    await until(async () => ((await callAction("waves.get", { id })) as { wave: WaveView }).wave.tasks[0].taskId !== null);
    await appendWaveEvent(id, { kind: "stage", stage: "rejected", reason: null });
    await pokeWave(id);
    await until(async () => (await liveWaveRunners(id)).length === 0);
    const file = await readWave(id);
    const rejection = waveNotice({ ...(await waveLook(file)), events: file.events }, origin);
    expect(rejection?.key).toStartWith(`wave:${id}:rejected:`);

    const added = await tool({ action: "waves.add", id, tasks: [spec("fix")] }, origin);
    expect(added.card).toMatchObject({ kind: "decision", answers: rejection?.key, title: "added 1 task to wave factory/d1" });
    await stopWaveRunners(id);

    // A wave queued after another that still builds: nothing about it is open.
    const queued = `dec00000-${RUN}-4000-8000-000000000002`;
    await createWave({ id: queued, repo, tag: "factory/d2", plan: null, title: "w", request: "r", branch: null, target: "main", base: null, after: [id], origin, createdAt: "2026-01-01T00:00:00.000Z", overrides: {} });
    const updated = await tool({ action: "waves.update", id: queued, title: "renamed" }, origin);
    expect(updated.card.kind).toBe("decision");
    expect(updated.card.answers).toBeUndefined();

    // A read is no decision.
    const listed = await tool({ action: "decisions.list" }, origin);
    expect((listed.result as { decisions: unknown[] }).decisions.length).toBe(2);
    const decisions = await readDecisions(origin);
    expect(decisions.map((entry) => [entry.card.title, entry.card.answers])).toEqual([
      ["added 1 task to wave factory/d1", rejection?.key],
      ["updated wave factory/d2", undefined],
    ]);
  }, 40_000);

  test("waves.add to a wave that is not rejected or blocked is no decision", async () => {
    const origin = `decide-n-${RUN}`;
    const repo = makeRepo();
    const other = `dec00000-${RUN}-4000-8000-000000000003`;
    const queued = `dec00000-${RUN}-4000-8000-000000000004`;
    await createWave({ id: other, repo, tag: "factory/d3", plan: null, title: "w", request: "r", branch: null, target: "main", base: null, after: [queued], origin: null, createdAt: "2026-01-01T00:00:00.000Z", overrides: {} });
    await createWave({ id: queued, repo, tag: "factory/d4", plan: null, title: "w", request: "r", branch: null, target: "main", base: null, after: [other], origin, createdAt: "2026-01-01T00:00:00.000Z", overrides: {} });
    const added = await tool({ action: "waves.add", id: queued, tasks: [spec("x")] }, origin);
    expect(added.card.kind).toBe("action");
    expect(await readDecisions(origin)).toEqual([]);
  });

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
