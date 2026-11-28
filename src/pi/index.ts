/**
 * Agent factory's Pi extension: the pipeline of a task, run inside the task's own session, and the tools, notices,
 * cards and widget of every other session. Without a `factory-task` entry no task handler does anything.
 * - After every coder turn (`agent_before_settle`): gates, protected paths, review. The merge starts in `agent_settled`,
 *   the first place that knows whether the run was aborted; it is not awaited there: Pi defers every prompt,
 *   `/factory cancel` included, until those handlers return
 * - `factory.yaml` and the role prompts come from the task's base commit, never from the tree the coder edits
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { cardsToRule, sessionWidget } from "../session-widget.ts";
import { registerCardRenderers } from "./cards-tui.ts";
import type { WaveView } from "../waves.ts";
import { registerFeedbackTool } from "./feedback-tool.ts";
import { retitleSessionTask, sessionWave } from "../core.ts";
import { DONE_REFUSAL, refusesDone } from "../launch.ts";
import { snapshotTree } from "../git.ts";
import { modelsCommand } from "../models.ts";
import { isConventionalTitle, parseCommitMessage } from "../commitmsg.ts";
import { commitAnswerDrafts, messageRoundDrafts, runRound, type RoundResult } from "../pipeline.ts";
import {
  applyReviewed,
  approveTask,
  askSupervisor,
  cancelTask,
  conflictMessage,
  endState,
  finishMerge,
  initConfig,
  newTaskSession,
  openRun,
  pipelineSteps,
  resumeAnswered,
  resumeTask,
  retryTask,
  startRun,
  startTask,
  STATUS_KEY,
  taskFiles,
  type OpResult,
  type OpsDeps,
  type RunOpening,
} from "../ops.ts";
import { applyEntry, followUpMessages, messageText, rebuild, isResting, stateDraft, type Draft, type State } from "../state.ts";
import { startNotifier, type Notifier } from "./notifier.ts";
import { createScoutTracker, registerScoutTool } from "./scout-tool.ts";
import { isTaskSession, registerFactoryTool, toolError, toolText } from "./tool.ts";
import { TASK_SESSION_ENV } from "../runner.ts";
import { errorText, isRecord } from "../util.ts";
import { sessionTask, type TaskRecord } from "../tasks.ts";

/** Tag of the system prompt section that carries `.factory/agents/coder.md`. */
const ROLE_SECTION = "factory_role";
/** Key of the widget above the editor that lists the session's waves. */
const WAVES_WIDGET = "factory-waves";

/** The text of the last assistant message of a session branch, empty when there is none. */
function lastAssistantText(entries: Iterable<{ type: string }>): string {
  let text = "";
  for (const entry of entries) {
    const { message } = entry as { message?: { role?: unknown; content?: unknown } };
    if (entry.type === "message" && message?.role === "assistant") text = messageText(message);
  }
  return text;
}

/** The tool calls of the session's last assistant message: Pi records the message before it runs any of its calls. */
function lastAssistantToolCalls(entries: Iterable<{ type: string }>): number {
  let calls = 0;
  for (const entry of entries) {
    const { message } = entry as { message?: { role?: unknown; content?: unknown } };
    if (entry.type !== "message" || message?.role !== "assistant") continue;
    calls = Array.isArray(message.content) ? message.content.filter((part) => isRecord(part) && part.type === "toolCall").length : 0;
  }
  return calls;
}

export default function (pi: ExtensionAPI) {
  const session = newTaskSession();
  // A turn end with the commit message ask open waits for no scout (`agent_before_settle`): a scout then is not owed.
  const scouts = createScoutTracker({ isCoder: () => session.snapshot !== undefined, holds: () => session.snapshot?.state === "running" && commitAsk === undefined });
  const cards = registerCardRenderers(pi);
  registerFactoryTool(pi, scouts, cards);
  registerScoutTool(pi, scouts);
  /** The state the last `agent_before_settle` pipeline ended in, until `agent_settled` has acted on it. */
  let roundEnd: State | undefined;
  /** What the `input` handler checked for the user message whose run `before_agent_start` opens next. */
  let opened: RunOpening | undefined;
  /** The commit message ask of a passed round awaiting the coder's answer: the state it passed into, the tree that passed. */
  let commitAsk: { passedInto: State; tree: string } | undefined;
  let taskTools = false;
  /** The factory's record of this session's task, looked up once. */
  let taskRecord: Promise<TaskRecord | undefined> | undefined;
  const sessionRecord = (ctx: ExtensionContext): Promise<TaskRecord | undefined> => {
    taskRecord ??= sessionTask(ctx.sessionManager.getSessionId()).catch(() => undefined);
    return taskRecord;
  };
  /** `feedback` and `factory_ask_supervisor` exist in task sessions only: registered once the session holds a task. */
  const registerTaskTools = () => {
    if (taskTools || !session.snapshot) return;
    taskTools = true;
    registerFeedbackTool(pi, {
      role: "coder",
      context: async (ctx) => {
        const record = await sessionRecord(ctx);
        return record === undefined ? null : { task: record.id, wave: record.wave, plan: record.plan };
      },
    });
    // A terminating call, so the turn ends with the question. Pi ends a turn early only when every call of the batch
    // terminates, and runs a queued message anyway: the call is refused next to another tool call or while a message
    // is queued, so an accepted question always ends the turn.
    pi.registerTool({
      name: "factory_ask_supervisor",
      label: "Ask the supervisor",
      description:
        "Ask whoever runs this factory task a question you cannot answer from the request or the code (a decision, missing information). Call it alone, with no other tool call in the same message. Your turn ends with the call; the answer arrives as the next message and you continue the same round. Ask only when guessing would risk wrong work.",
      promptSnippet: "Ask the task's supervisor a blocking question; the turn ends and the answer comes as the next message",
      parameters: {
        type: "object",
        required: ["question"],
        properties: { question: { type: "string", description: "The question, self-contained: the supervisor has not seen your work" } },
      } as never,
      async execute(_toolCallId, params: unknown, _signal, _onUpdate, ctx) {
        const fail = (text: string) => toolError(`factory_ask_supervisor: ${text}`);
        if (session.snapshot?.state !== "running") return fail("only the coder of a running task may ask");
        const { question } = isRecord(params) ? params : {};
        if (typeof question !== "string" || question.trim() === "") return fail("question must not be empty");
        if (lastAssistantToolCalls(ctx.sessionManager.getBranch()) > 1) return fail("call it alone, with no other tool call in the same message: the turn could not end with it");
        if (ctx.hasPendingMessages()) return fail("a message is queued for you: read it first, then ask if the question still stands");
        askSupervisor(deps(ctx), session.snapshot, question);
        return { ...toolText("Question recorded. Stop now: the answer arrives as the next message.", { question }), terminate: true };
      },
    });
  };

  const deps = (ctx: ExtensionContext): OpsDeps => ({
    session,
    cwd: ctx.cwd,
    appendEntry: (customType, data) => pi.appendEntry(customType, data),
    sendUserMessage: (text) => pi.sendUserMessage(text),
    sendMessage: (message, options) => pi.sendMessage(message, options),
    setStatus: (key, text) => ctx.ui.setStatus(key, text),
    isIdle: () => ctx.isIdle(),
    abort: () => ctx.abort(),
    setModel: async (name) => {
      const slash = name.indexOf("/");
      const model = ctx.modelRegistry.find(name.slice(0, slash), name.slice(slash + 1));
      if (model === undefined) return false;
      // Already on it (the runner starts Pi with `--model`): no switch, so no `model_select` that an extension could
      // persist into the worktree's `.pi/settings.json`.
      if (ctx.model?.provider === model.provider && ctx.model.id === model.id) return ctx.modelRegistry.hasConfiguredAuth(model);
      return pi.setModel(model);
    },
    hasPendingMessages: () => ctx.hasPendingMessages(),
    followUps: () => followUpMessages(ctx.sessionManager.getBranch()),
    sessionModel: () => (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null),
    sessionId: () => ctx.sessionManager.getSessionId(),
    wave: () => sessionWave(ctx.sessionManager.getSessionId()),
  });

  const command = (args: string, ops: OpsDeps): Promise<OpResult> => {
    const text = args.trim();
    const verb = text.split(/\s+/, 1)[0];
    if (verb === "start") {
      return startTask(ops, text.slice(verb.length).trim()).then((result) => {
        registerTaskTools();
        return result;
      });
    }
    if (verb === "init") return initConfig(ops);
    const current = session.snapshot;
    if (!current) return Promise.resolve({ ok: false, error: "this session holds no task" });
    if (verb === "approve") return approveTask(ops, current);
    if (verb === "retry") return retryTask(ops, current);
    if (verb === "cancel") return cancelTask(ops, current);
    if (verb === "reviewed") return applyReviewed(ops, current, text.slice(verb.length).trim());
    return Promise.resolve({ ok: false, error: `unknown command "${verb}"` });
  };

  pi.registerCommand("factory", {
    description: "Agent factory: init (draft factory.yaml) | models [add|remove|set ...] | waves (show/hide finished waves) | task: start <json> | approve | retry | cancel",
    handler: async (args, ctx) => {
      const [verb = ""] = args.trim().split(/\s+/, 1);
      if (verb === "models") {
        await modelsCommand(args.trim().slice(verb.length).trim(), ctx).catch((error) => ctx.ui.notify(`factory: ${errorText(error)}`, "error"));
        return;
      }
      if (verb === "waves") {
        widget.showFinished = !widget.showFinished;
        showWidget();
        return;
      }
      const result = await command(args, deps(ctx)).catch((error): OpResult => ({ ok: false, error: errorText(error) }));
      if (!result.ok) ctx.ui.notify(`factory: ${result.error}`, "error");
      else if (result.message) ctx.ui.notify(`factory: ${result.message}`, "info");
    },
  });

  /** The session's waves widget: the views of the notifier's last look, the context of the session it shows in. */
  const widget: { waves: WaveView[]; showFinished: boolean; ctx: ExtensionContext | undefined } = { waves: [], showFinished: false, ctx: undefined };
  const showWidget = () => {
    const { ctx, waves, showFinished } = widget;
    if (ctx === undefined) return;
    const rulings = cardsToRule(ctx.sessionManager.getBranch());
    if (sessionWidget(waves, { showFinished, width: 80, rulings }).length === 0) {
      ctx.ui.setWidget(WAVES_WIDGET, undefined);
      return;
    }
    // sessionWidget counts code points; a wide character takes two columns, so pi-tui cuts every line to the width.
    const render = (width: number) => sessionWidget(waves, { showFinished, width, rulings }).map((line) => truncateToWidth(line, width));
    ctx.ui.setWidget(WAVES_WIDGET, () => ({ render, invalidate: () => undefined }));
  };
  // A decision taken in a turn settles a card: the count follows without waiting for the notifier's next look.
  pi.on("turn_end", () => showWidget());

  let notifier: Notifier | undefined;
  pi.on("session_start", async (_event, ctx) => {
    notifier?.stop();
    notifier = undefined;
    widget.ctx?.ui.setWidget(WAVES_WIDGET, undefined);
    widget.ctx = undefined;
    widget.waves = [];
    // A runner's Pi is a task's own session from the start; a session that gets its task later is checked per look.
    if (process.env[TASK_SESSION_ENV] !== "1") {
      const taskSession = () => session.snapshot !== undefined || isTaskSession(ctx.sessionManager.getBranch());
      // The widget only in the interactive terminal UI: not in RPC, JSON or print mode.
      if (ctx.mode === "tui") widget.ctx = ctx;
      notifier = startNotifier({
        origin: ctx.sessionManager.getSessionId(),
        send: (text, notice) => pi.sendMessage({ customType: "factory-notice", content: text, display: true, details: { key: notice.key, card: notice.card } }, { triggerTurn: true }),
        skipScout: (id) => scouts.waiting.has(id),
        isTaskSession: () => {
          const task = taskSession();
          if (task && widget.ctx !== undefined) {
            widget.ctx.ui.setWidget(WAVES_WIDGET, undefined);
            widget.ctx = undefined;
          }
          return task;
        },
        onWaves: (waves) => {
          widget.waves = waves;
          showWidget();
        },
      });
    }
    session.snapshot = rebuild(ctx.sessionManager.getBranch());
    session.files = undefined;
    taskRecord = undefined;
    registerTaskTools();
    // A run is active only inside the process that started it: a task loaded in a state that does not rest was interrupted.
    if (session.snapshot && !isResting(session.snapshot.state)) await resumeTask(deps(ctx), session.snapshot);
  });

  pi.on("session_tree", (_event, ctx) => {
    session.snapshot = rebuild(ctx.sessionManager.getBranch());
    session.files = undefined;
  });

  pi.on("session_shutdown", () => {
    notifier?.stop();
    notifier = undefined;
    widget.ctx = undefined;
    session.disposed = true;
    session.runner.cancel();
  });

  pi.on("input", async (_event, ctx) => {
    const atRest = session.snapshot;
    if (!atRest) return;
    if (atRest.state === "merging") {
      ctx.ui.notify("factory: a merge is running, send the message when it has ended", "warning");
      return { action: "handled" };
    }
    // The answer to the coder's question continues its round: no rebase, so the worktree stays as the coder left it.
    if (atRest.state === "waiting_answer") return;
    if (!isResting(atRest.state)) return;
    if (refusesDone(atRest.state, (await sessionRecord(ctx))?.wave ?? null)) {
      ctx.ui.notify(`factory: this task ${DONE_REFUSAL}`, "error");
      return { action: "handled" };
    }
    const ops = deps(ctx);
    try {
      opened = await openRun(ops, atRest);
    } catch (error) {
      ctx.ui.notify(`factory: the message starts no run: ${errorText(error)}`, "error");
      return { action: "handled" };
    }
    if (opened.failed !== undefined) {
      const { failed } = opened;
      opened = undefined;
      endState(ops, atRest, "blocked", failed);
      ctx.ui.notify(`factory: the message starts no run: ${failed}`, "error");
      return { action: "handled" };
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const atRest = session.snapshot;
    if (!atRest) return;
    const opening = opened ?? {};
    opened = undefined;
    const ops = deps(ctx);
    const answers = event.messageType === "user" && atRest.state === "waiting_answer";
    const opens = event.messageType === "user" && !answers && isResting(atRest.state);
    if (answers) resumeAnswered(ops, atRest);
    if (opens) startRun(ops, atRest, "message", opening);
    // A `factory.yaml` that does not parse is reported by the round, not here.
    const taskFilesNow = await taskFiles(ops, atRest.task).catch(() => undefined);
    if (taskFilesNow?.prompts.coder) event.systemPromptOptions.sections[ROLE_SECTION] = taskFilesNow.prompts.coder;
    // The user's message and the conflict both reach the coder in this run.
    if (opens && opening.conflict !== undefined) return { message: conflictMessage(atRest.round, opening.conflict) };
  });

  pi.on("agent_start", (_event, ctx) => {
    if (session.snapshot?.state === "running") ctx.ui.setStatus(STATUS_KEY, `round ${session.snapshot.round}: coder`);
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    const current = session.snapshot;
    if (!current || current.state !== "running") return;
    // An aborted run is classified in `agent_settled`, which is also reached when this boundary is skipped.
    if (event.outcome === "aborted") return;
    // Held until the coder's scouts reported: their reports carry the run on, the round's steps wait for its next end.
    if (event.outcome !== "error" && commitAsk === undefined) {
      const reports = await scouts.held(() => session.disposed || session.runner.cancelled);
      if (reports.length > 0) return { entries: [...event.entries, ...reports], continue: true };
    }
    const { round, task } = current;
    const stopped = (reason: string): RoundResult => {
      const entries: Draft[] = [stateDraft("blocked", round, reason)];
      // A message queued meanwhile runs right after this boundary: it gets its round.
      return ctx.hasPendingMessages() ? { entries: [...entries, ...messageRoundDrafts(round)], continue: true } : { entries, continue: false };
    };
    let result: RoundResult;
    const asked = commitAsk;
    commitAsk = undefined;
    if (event.outcome === "error") {
      result = stopped("agent_error");
    } else {
      try {
        const ops = deps(ctx);
        const { runner } = session;
        // The answer to the commit message ask, unless the coder changed files with it: then the round runs again.
        if (asked && (await snapshotTree(runner.run, ctx.cwd)) === asked.tree) {
          const answer = lastAssistantText(ctx.sessionManager.getBranch());
          // The coder's subject becomes the title of a task dropped in plain words; a follow-up run keeps the first title.
          const subject = parseCommitMessage(answer)?.title;
          // A title that cannot be written leaves the old one: the commit still lands.
          if (subject !== undefined && !isConventionalTitle(current.task.title) && current.mergedCommit == null) {
            await retitleSessionTask(ctx.sessionManager.getSessionId(), subject).catch((error: unknown) => console.error(`factory: the commit subject did not become the task's title: ${errorText(error)}`));
          }
          result = commitAnswerDrafts(current, answer, asked.passedInto, ctx.hasPendingMessages());
        } else {
          result = await runRound(current, pipelineSteps(ops, task, await taskFiles(ops, task), false));
          if (result.commitAsk) commitAsk = { passedInto: result.commitAsk, tree: await snapshotTree(runner.run, ctx.cwd) };
        }
      } catch (error) {
        result = stopped(`pipeline_error: ${errorText(error)}`);
      }
    }
    // Pi commits the returned entries: the snapshot follows them without `appendEntry`.
    for (const draft of result.entries) if (draft.type === "custom") session.snapshot = applyEntry(session.snapshot, draft.customType, draft.data);
    roundEnd = session.snapshot?.state;
    const entries = [...event.entries, ...result.entries];
    return result.continue ? { entries, continue: true } : { entries };
  });

  pi.on("agent_settled", async (event, ctx) => {
    const current = session.snapshot;
    if (!current) return;
    const ops = deps(ctx);
    const ended = roundEnd === current.state ? roundEnd : undefined;
    roundEnd = undefined;
    // `running`: no step ended the run. `merging`: the round passed and its merge is due. An aborted run keeps neither,
    // and no approve or wave review either: the abort may have come while the round's steps ran, which they cannot see.
    const open = current.state === "running" || ended === "merging" || ((ended === "waiting_approve" || ended === "reviewing") && event.aborted);
    if (open && session.runner.cancelled) endState(ops, current, "cancelled", "cancelled");
    else if (open && event.aborted) endState(ops, current, "blocked", "stopped");
    else if (ended === "merging") {
      // Not awaited: Pi holds back every prompt until this handler returns, `/factory cancel` too.
      void finishMerge(ops, current).catch(() => undefined);
      return;
    } else if (current.state === "running") endState(ops, current, "blocked", "interrupted");
    ctx.ui.setStatus(STATUS_KEY, undefined);
    session.runner.reset();
  });
}
