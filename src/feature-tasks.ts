/** The tasks: start, look at, steer and remove them (`core-tasks.ts`). */
import { plural } from "./agent-view.ts";
import { card, decision, taskCard, taskState } from "./cards.ts";
import { TASK_HANDLERS, type TaskView } from "./core-tasks.ts";
import { FINAL_STATES } from "./state.ts";
import { taskCause } from "./decisions.ts";
import { feature, ID, REPO, spec, TAG, TAG_FILTER } from "./feature.ts";
import { schemaOf } from "./settings.ts";
import type { Handlers } from "./feature.ts";
import { short } from "./util.ts";

export const TASKS = feature({
  name: "tasks",
  actions: {
    // The finished ones as a count: a long history must not fill an agent's context.
    "tasks.list": spec("Every task, or the repository's", { repo: { type: "string", description: "Only the tasks of this repository" }, tag: TAG_FILTER }, [], false, (_params, result: { tasks: TaskView[] }) => {
      const open = result.tasks.filter((task) => task.state === null || !FINAL_STATES.includes(task.state));
      return card("action", "quiet", result.tasks.length === 0 ? "no tasks" : plural(result.tasks.length, "task"), {
        rows: [
          ...open.map((task) => ({ label: short(task.id), text: `${taskState(task)}  ${task.tag}  ${task.title}` })),
          ...(open.length < result.tasks.length ? [{ label: "finished", text: `${result.tasks.length - open.length}, not shown` }] : []),
        ],
      });
    }),
    "tasks.get": spec("One task", { id: ID }, ["id"], false, (_params, result: TaskView) => taskCard(result, `task ${short(result.id)}`)),
    "tasks.timeline": spec(
      "A task's session as entries; poll with since = the last answer's next",
      { id: ID, since: { type: "integer", minimum: 0, description: "The cursor an earlier answer returned as next" } },
      ["id"],
      false,
    ),
    "tasks.diff": spec("A task's worktree against where it branched off its target", { id: ID }, ["id"], false, (_params, result: { files: { path: string; added: number; removed: number }[] }) => {
      if (result.files.length === 0) return card("action", "quiet", "no changes");
      const added = result.files.reduce((sum, file) => sum + file.added, 0);
      const removed = result.files.reduce((sum, file) => sum + file.removed, 0);
      return card("action", "quiet", `${plural(result.files.length, "file")}  +${added} -${removed}`, { rows: result.files.map((file) => ({ label: `+${file.added} -${file.removed}`, text: file.path })) });
    }),
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
      (_params, result: TaskView) => taskCard(result, `started task ${short(result.id)}`),
    ),
    "tasks.approve": spec("Merge a task waiting for approve", { id: ID }, ["id"], true, (_params, result: TaskView) => taskCard(result, `approved task ${short(result.id)}`)),
    "tasks.retry": spec(
      "Another round on a blocked, cancelled or interrupted task",
      { id: ID },
      ["id"],
      true,
      (_params, result: TaskView) => decision(taskCard(result, ""), `retried task ${short(result.id)}`),
      (params) => taskCause(params.id),
    ),
    "tasks.cancel": spec(
      "Stop a task",
      { id: ID },
      ["id"],
      true,
      (_params, result: TaskView) => decision(taskCard(result, ""), `cancelled task ${short(result.id)}`),
      (params) => taskCause(params.id),
    ),
    "tasks.remove": spec(
      "Delete a task's worktree, branch and record",
      { id: ID, force: { type: "boolean", description: "Also drop commits its target branch lacks and uncommitted changes" } },
      ["id"],
      true,
      (_params, result: { removed: string; dropped: string | null }) =>
        card("action", "quiet", `removed task ${short(result.removed)}`, { id: short(result.removed), rows: result.dropped ? [{ label: "dropped", text: result.dropped }] : [] }),
    ),
    "tasks.message": spec(
      "Send a task a message: a resting task runs new rounds, a task in waiting_answer gets it as the answer to its question (same round), a running coder gets it as a follow-up",
      { id: ID, text: { type: "string", description: "The message" } },
      ["id", "text"],
      true,
      // A decision only when it answers a question or a block: `actionView` makes it one with the key it answers.
      (params, result: TaskView) => ({ ...decision(taskCard(result, ""), `sent to task ${short(result.id)}`, String(params.text ?? "")), kind: "action" }),
      (params) => taskCause(params.id, true),
    ),
  },
  get handlers(): Handlers {
    return TASK_HANDLERS;
  },
});
