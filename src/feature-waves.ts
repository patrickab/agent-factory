/** The waves: a planned set of tasks on one branch, reviewed and merged once (`core-waves.ts`). */
import { card, decision, shortId, waveCard, waveCardState } from "./cards.ts";
import { afterNames, plural, short, waveBlock, waveList, waveReceipt } from "./agent-view.ts";
import type { Params } from "./core-shared.ts";
import { WAVE_HANDLERS } from "./core-waves.ts";
import { waveCause } from "./decisions.ts";
import { feature, REPO, spec, TAG, WAVE_ID, WAVE_TASK_ITEM } from "./feature.ts";
import { schemaOf } from "./settings.ts";
import type { Handlers } from "./feature.ts";
import type { WaveView } from "./waves.ts";

export const WAVES = feature({
  name: "waves",
  actions: {
    "waves.start": spec(
      "Declare a wave: a set of tasks on one new branch (<target>-<tag with / as ->) off the target, the factory starts each task once the tasks it waits for (after) are done. With after (waves it waits for): queued, its branch cut and its tasks started once every one of them is merged; answers {wave}",
      {
        repo: REPO,
        tag: { ...TAG, description: "The wave's tag (its tasks carry it): segments of A-Z a-z 0-9 . _ @ + - joined by /" },
        title: { type: "string", description: "A short title of the wave" },
        request: { type: "string", description: "The reviewer's instructions for the wave's whole diff" },
        tasks: {
          type: "array",
          description:
            "The wave's tasks: key unique in the wave (A-Z a-z 0-9 . _ -), title, request (full and self-contained for the coder), after: keys this task waits for, model: \"small\" or \"big\", which of the wave's models this task's coder runs with (default big; the reviewer's stays the wave's)",
          items: WAVE_TASK_ITEM,
        },
        plan: { type: "string", description: "The memory_store path of the plan the wave works from (only stored)" },
        after: {
          type: "array",
          items: { type: "string" },
          description:
            "Waves this one waits for, by tag (the newest not cancelled) or id, of the same repository and target: the wave is queued, gets its branch off the target's tip and starts once every one is merged",
        },
        contracts: {
          type: "array",
          items: { type: "string" },
          description:
            "Contracts (memory-store directories run/contract/<name>/ or documents run/contract/<name>.md in plan) the wave's coders work by; core is added when it exists. Needs plan and memory-store on PATH",
        },
        overrides: { type: "object", description: "Settings over the repository's stored ones: branch = the target, merge = the wave's (review: wait for approve)", properties: schemaOf("wave") },
      },
      ["repo", "tag", "title", "request", "tasks"],
      true,
    ),
    "waves.add": spec(
      "Add tasks to a wave (after may name its existing keys); a rejected, blocked, reviewing or waiting_approve wave builds again. Pending tasks that can never start (a task they wait for was cancelled or removed) are dropped: they count as cancelled. Answers {wave}",
      {
        id: WAVE_ID,
        tasks: { type: "array", description: "Tasks as for waves.start: key, title, request, after?, model? (\"small\" or \"big\", default big)", items: WAVE_TASK_ITEM },
      },
      ["id", "tasks"],
      true,
    ),
    "waves.get": spec("One wave: declaration, stage, tasks with state and usage, counts, reviews, merge, usage. Answers {wave}", { id: WAVE_ID }, ["id"], false),
    "waves.list": spec(
      "Every wave, or the repository's, or those under a tag, or a session's, or the open ones (filters combine). Answers {waves}",
      {
        repo: { type: "string", description: "Only the waves of this repository" },
        tag: { type: "string", description: "Only the waves whose tag is this one or lies under it" },
        origin: { type: "string", description: "Only the waves this Pi session (its id) declared" },
        open: { type: "boolean", description: "true: only the waves not merged or cancelled" },
      },
      [],
      false,
    ),
    "waves.retry": spec(
      "Run a blocked or interrupted wave again: a blocked wave with tasks not started or not finished builds again (starts them), else review and merge from the rebase on; an interrupted one resumes from its log; also retries each interrupted task of the wave. Answers {wave, retried, refused}",
      { id: WAVE_ID },
      ["id"],
      true,
    ),
    "waves.approve": spec("Merge a wave waiting for approve (its merge setting is review). Answers {wave}", { id: WAVE_ID }, ["id"], true),
    "waves.cancel": spec("Stop a wave: cancel its tasks that are not done or cancelled, stop its runner; its branch stays. Answers {wave}", { id: WAVE_ID }, ["id"], true),
    "waves.remove": spec(
      "Delete a wave's record, its tasks (as tasks.remove does) and a review worktree a block left (one holding uncommitted changes only with force); its branch only when the wave is merged. Refused while the wave or one of its tasks runs. Answers {removed: id}",
      { id: WAVE_ID, force: { type: "boolean", description: "Also drop commits its target branch lacks and uncommitted changes" } },
      ["id"],
      true,
    ),
  },
  get handlers(): Handlers {
    return WAVE_HANDLERS;
  },
  renderers: {
    "waves.start": (_params, result: { wave: WaveView }) => {
      const wave = result.wave;
      if (wave.stage === "queued") return waveReceipt("declared ", wave, [`waits for: ${afterNames(wave)}`]);
      const started = wave.tasks.filter((task) => task.taskId !== null).map((task) => task.key);
      const waiting = wave.tasks.filter((task) => task.taskId === null && task.state === "pending").map((task) => `${task.key} (${task.after.join(", ")})`);
      return waveReceipt("started ", wave, [`started: ${started.join(", ") || "none"}`, ...(waiting.length > 0 ? [`waits: ${waiting.join(", ")}`] : [])]);
    },
    "waves.add": (params, result: { wave: WaveView }) => {
      const wave = result.wave;
      const keys = new Set(Array.isArray(params.tasks) ? params.tasks.map((task) => String((task as Params).key)) : []);
      const added = wave.tasks.filter((task) => keys.has(task.key)).map((task) => `${task.key} ${task.state}`);
      return waveReceipt("", wave, [`added: ${added.join(", ") || "none"}`]);
    },
    "waves.get": (_params, result: { wave: WaveView }) => waveBlock(result.wave),
    "waves.list": (_params, result: { waves: WaveView[] }) => waveList(result.waves),
    "waves.retry": (_params, result: { wave: WaveView; retried?: string[]; refused?: { id: string; why: string }[] }) =>
      waveReceipt("", result.wave, [
        ...((result.retried ?? []).length > 0 ? [`retried tasks: ${(result.retried ?? []).map(short).join(", ")}`] : []),
        ...(result.refused ?? []).map((task) => `refused task ${short(task.id)}: ${task.why}`),
      ]),
    "waves.approve": (_params, result: { wave: WaveView }) => waveReceipt("", result.wave),
    "waves.cancel": (_params, result: { wave: WaveView }) => waveReceipt("", result.wave),
    "waves.remove": (_params, result: { removed: string }) => `removed wave ${short(result.removed)}`,
  },
  decides: {
    "waves.add": (params) => waveCause(params.id, ["rejected", "blocked"]),
    "waves.retry": (params) => waveCause(params.id),
    "waves.cancel": (params) => waveCause(params.id),
  },
  cards: {
    "waves.start": (_params, result: { wave: WaveView }) => waveCard(result.wave, `${result.wave.stage === "queued" ? "declared" : "started"} wave ${result.wave.tag}`),
    // A decision only when it answers a rejection or a block: `actionCard` makes it one with the key it answers.
    "waves.add": (params, result: { wave: WaveView }) => {
      const added = Array.isArray(params.tasks) ? params.tasks.map((task) => task as Params) : [];
      const text = added.map((task) => `- **${String(task.key)}**: ${String(task.title)}`).join("\n");
      return { ...decision(waveCard(result.wave, ""), `added ${plural(added.length, "task")} to wave ${result.wave.tag}`, text), kind: "action" };
    },
    "waves.get": (_params, result: { wave: WaveView }) => waveCard(result.wave, `wave ${result.wave.tag}`),
    "waves.list": (_params, result: { waves: WaveView[] }) =>
      card("action", "quiet", result.waves.length === 0 ? "no waves" : plural(result.waves.length, "wave"), {
        rows: result.waves.map((wave) => ({ label: wave.tag, text: `${waveCardState(wave)}  ${wave.counts.done}/${wave.counts.total}  ${shortId(wave.id)}` })),
      }),
    "waves.retry": (_params, result: { wave: WaveView; retried?: string[]; refused?: { id: string; why: string }[] }) => {
      const lines = [...(result.retried ?? []).map((id) => `- retried task ${shortId(id)}`), ...(result.refused ?? []).map((task) => `- refused task ${shortId(task.id)}: ${task.why}`)];
      return decision(waveCard(result.wave, ""), `retried wave ${result.wave.tag}`, ...(lines.length > 0 ? [lines.join("\n")] : []));
    },
    "waves.approve": (_params, result: { wave: WaveView }) => waveCard(result.wave, `approved wave ${result.wave.tag}`),
    "waves.cancel": (_params, result: { wave: WaveView }) => decision(waveCard(result.wave, ""), `cancelled wave ${result.wave.tag}`),
    "waves.remove": (_params, result: { removed: string }) => card("action", "quiet", `removed wave ${shortId(result.removed)}`, { id: shortId(result.removed) }),
  },
  toolBlurb:
    '"tasks.start" one self-contained task; "waves.start" a planned set of tasks (after = keys a task waits for) on one branch, each task reviewed, then the whole, merged once; its after = tags or ids of waves it waits for: it stays queued until they are merged.',
});
