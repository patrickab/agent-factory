/** The tasks: start, look at, steer and remove them (`core-tasks.ts`). */
import { fields, plural, short, taskBlock, taskHeader, taskList, taskState } from "./agent-view.ts";
import type { TaskView } from "./core-tasks.ts";
import { card, decision, shortId, taskCard, taskCardState } from "./cards.ts";
import { TASK_HANDLERS } from "./core-tasks.ts";
import { taskCause } from "./decisions.ts";
import { feature, ID, REPO, spec, TAG, TAG_FILTER } from "./feature.ts";
import { schemaOf } from "./settings.ts";
import type { Handlers } from "./feature.ts";

export const TASKS = feature({
  name: "tasks",
  actions: {
    "tasks.list": spec("Every task, or the repository's", { repo: { type: "string", description: "Only the tasks of this repository" }, tag: TAG_FILTER }, [], false),
    "tasks.get": spec("One task", { id: ID }, ["id"], false),
    "tasks.timeline": spec(
      "A task's session as entries; poll with since = the last answer's next",
      { id: ID, since: { type: "integer", minimum: 0, description: "The cursor an earlier answer returned as next" } },
      ["id"],
      false,
    ),
    "tasks.diff": spec("A task's worktree against where it branched off its target", { id: ID }, ["id"], false),
    "tasks.start": spec(
      "Start a task in its own worktree; answers once its runner is spawned",
      {
        repo: REPO,
        title: { type: "string", description: "A short title of the task" },
        request: { type: "string", description: "The full, self-contained task for the coder" },
        overrides: { type: "object", description: "Settings over the repository's stored ones", properties: schemaOf("task") },
        tag: { ...TAG, description: `${String(TAG.description)}. Default: the system user` },
      },
      ["repo", "title", "request"],
      true,
    ),
    "tasks.approve": spec("Merge a task waiting for approve", { id: ID }, ["id"], true),
    "tasks.retry": spec("Another round on a blocked, cancelled or interrupted task", { id: ID }, ["id"], true),
    "tasks.cancel": spec("Stop a task", { id: ID }, ["id"], true),
    "tasks.remove": spec(
      "Delete a task's worktree, branch and record",
      { id: ID, force: { type: "boolean", description: "Also drop commits its target branch lacks and uncommitted changes" } },
      ["id"],
      true,
    ),
    "tasks.message": spec(
      "Send a task a message: a resting task runs new rounds, a task in waiting_answer gets it as the answer to its question (same round), a running coder gets it as a follow-up",
      { id: ID, text: { type: "string", description: "The message" } },
      ["id", "text"],
      true,
    ),
  },
  get handlers(): Handlers {
    return TASK_HANDLERS;
  },
  renderers: {
    "tasks.list": (_params, result: { tasks: TaskView[] }) => taskList(result.tasks),
    "tasks.get": (_params, result: TaskView) => taskBlock(result),
    "tasks.diff": (_params, result: { files: { path: string; added: number; removed: number }[] }) => {
      if (result.files.length === 0) return "no changes";
      const added = result.files.reduce((sum, file) => sum + file.added, 0);
      const removed = result.files.reduce((sum, file) => sum + file.removed, 0);
      return [`${plural(result.files.length, "file")}  +${added} -${removed}`, ...result.files.map((file) => `  +${file.added} -${file.removed}  ${file.path}`)].join("\n");
    },
    "tasks.start": (_params, task: TaskView) => {
      return fields(`started task ${short(task.id)}`, taskState(task), task.tag);
    },
    "tasks.approve": (_params, result: TaskView) => taskHeader(result),
    "tasks.retry": (_params, result: TaskView) => taskHeader(result),
    "tasks.cancel": (_params, result: TaskView) => taskHeader(result),
    "tasks.remove": (_params, result: { removed: string; dropped: string | null }) =>
      [`removed task ${short(result.removed)}`, ...(result.dropped ? [`dropped: ${result.dropped}`] : [])].join(" · "),
    "tasks.message": (_params, task: TaskView) => {
      return fields(`sent to task ${short(task.id)}`, taskState(task), task.round === null ? null : `round ${task.round}`);
    },
  },
  decides: {
    "tasks.message": (params) => taskCause(params.id, true),
    "tasks.retry": (params) => taskCause(params.id),
    "tasks.cancel": (params) => taskCause(params.id),
  },
  cards: {
    "tasks.list": (_params, result: { tasks: TaskView[] }) =>
      card("action", "quiet", result.tasks.length === 0 ? "no tasks" : plural(result.tasks.length, "task"), {
        rows: result.tasks.map((task) => ({ label: shortId(task.id), text: `${taskCardState(task)}  ${task.tag}  ${task.title}` })),
      }),
    "tasks.get": (_params, result: TaskView) => taskCard(result, `task ${shortId(result.id)}`),
    "tasks.diff": (_params, result: { files: { path: string; added: number; removed: number }[] }) => {
      if (result.files.length === 0) return card("action", "quiet", "no changes");
      const added = result.files.reduce((sum, file) => sum + file.added, 0);
      const removed = result.files.reduce((sum, file) => sum + file.removed, 0);
      return card("action", "quiet", `${plural(result.files.length, "file")}  +${added} -${removed}`, { rows: result.files.map((file) => ({ label: `+${file.added} -${file.removed}`, text: file.path })) });
    },
    "tasks.start": (_params, result: TaskView) => taskCard(result, `started task ${shortId(result.id)}`),
    "tasks.approve": (_params, result: TaskView) => taskCard(result, `approved task ${shortId(result.id)}`),
    "tasks.retry": (_params, result: TaskView) => decision(taskCard(result, ""), `retried task ${shortId(result.id)}`),
    "tasks.cancel": (_params, result: TaskView) => decision(taskCard(result, ""), `cancelled task ${shortId(result.id)}`),
    "tasks.remove": (_params, result: { removed: string; dropped: string | null }) =>
      card("action", "quiet", `removed task ${shortId(result.removed)}`, { id: shortId(result.removed), rows: result.dropped ? [{ label: "dropped", text: result.dropped }] : [] }),
    // A decision only when it answers a question or a block: `actionCard` makes it one with the key it answers.
    "tasks.message": (params, result: TaskView) => ({ ...decision(taskCard(result, ""), `sent to task ${shortId(result.id)}`, String(params.text ?? "")), kind: "action" }),
  },
});
