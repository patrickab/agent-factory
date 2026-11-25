# Plan: waves as a factory object

A wave becomes something the factory knows: a declared set of tasks on one branch, reviewed and merged as a whole.
It replaces the `merge_request` task kind. Nothing about a wave needs a Pi session of its own.

## What a wave is

- **Declared once** by a supervisor: tag, target branch, title, reviewer instructions, its tasks and which task waits for which
- **Runs by itself**: the factory creates the wave's branch off the target, starts every task whose predecessors are done, and reviews and merges when all tasks are finished
- **Stops for judgement only**: a blocked task, a coder's question, a rejected review. The supervisor decides, the factory continues

```
declared ─▶ building ─▶ reviewing ─▶ merging ─▶ merged
               ▲            │
               └─ rejected ◀┘   (supervisor adds fix tasks, the wave builds again)
```

| Stage | Meaning | Leaves it when |
|---|---|---|
| `building` | tasks run and merge into the wave's branch | every task is `done` or `cancelled` |
| `reviewing` | rebase onto the target (unsquashed), gates, the reviewer judges the whole diff | the reviewer answers |
| `rejected` | findings wait for the supervisor | tasks are added |
| `merging` | merge queue: merge gates, fast-forward of the target | the target moved |
| `merged` | done | never |
| `blocked` | rebase conflict, failed gates, a dirty worktree, an infrastructure error | `waves.retry`, or tasks are added |

- A cancelled task leaves the count. A blocked task holds the wave in `building`
- With no task left (all cancelled) the wave ends `cancelled`
- The invariant of the old merge request stays: gates and review see exactly the committed tree that reaches the target

## The record

One file per wave: `<agent dir>/factory/waves/<id>.jsonl`, append-only. Line 1 declares the wave, every later line is one
event. The current state is the fold of the events, as a task's state is the fold of its session entries.

- **Why a log**: what happened can be replayed and shown later, and nothing is overwritten
- **Declaration**: `id`, `tag`, `plan`, `title`, `request` (reviewer instructions), `repo`, `branch`, `target`, `base` (the commit it branched from), `origin` (the declaring Pi session's id, when there is one), `createdAt`
- **Events** (each `{at, kind, ...}`):

| Kind | Carries |
|---|---|
| `tasks` | tasks added: `[{key, title, request, after: [keys]}]` |
| `task` | a task started: `key`, `taskId`, `sessionId` |
| `stage` | the new stage, a reason for `blocked` |
| `gate` | which gates, result, duration, log path |
| `review` | round, reviewer `sessionId`, model, verdict, findings `[{severity, file, line, text}]`, tokens, cost, duration |
| `merge` | queue wait, merge-gate result, the commit range that reached the target |
| `remote` | request number and URL, pushed commit |

- **Tasks** keep their own record and session. A task gains `wave: <id>`; its `tag` is the wave's
- **Usage** of a wave = its reviews plus its tasks' usage, summed when read. Tracks and milestones are tag prefixes: their numbers are sums over their waves, never stored

## Interface

| Action | Does |
|---|---|
| `waves.start {repo, tag, title, request, tasks, plan?, overrides?}` | declares the wave, creates the branch, starts what can start. `overrides` as for tasks (`branch` = the target, `models`, `maxRounds`, `merge`) |
| `waves.add {id, tasks}` | adds tasks (fixes, or work found late). A `rejected`, `blocked` or `reviewing` wave goes back to `building` |
| `waves.get {id}` · `waves.list {repo?, tag?}` | a `WaveView`: declaration, stage, tasks with their state and session ids, counts, reviews, merge, usage, remote |
| `waves.timeline {id, since?}` | the events |
| `waves.retry {id}` | runs review and merge again from the rebase (after `blocked`) |
| `waves.approve {id}` | with `merge: review`: the wave waits after an approved review until this |
| `waves.cancel {id}` | cancels its running tasks and the wave. The branch stays |
| `waves.remove {id}` | removes the record and its tasks. The branch is deleted only when merged |
| `tasks.wait {tag \| ids \| wave}` | also answers when a watched wave needs attention (`rejected`, `blocked`, waiting for approve) or is `merged` |

- `tasks.start {wave}` is refused: tasks join a wave through `waves.add`, so the wave's count is always true
- Removed: `kind: "merge_request"`, `source`, the non-public `sessionManager.appendMessage` call

## How it runs

- **A wave runner** (`bun wave-runner.ts <id>`), detached like a task's runner, one per wave while it is not resting. It
  starts tasks as their predecessors finish, and runs review and merge. It ends when the wave rests
- **Woken by**: `waves.start`, `waves.add`, `waves.retry`, `waves.approve`, and by a task of the wave reaching a resting state
  (the task's pipeline pokes its wave)
- **Reviewer**: the existing reviewer child (`review.ts`), in a detached worktree of the wave's branch that exists only
  for the review and merge
- **Restart**: a wave whose runner died is `interrupted`, as a task is, and `waves.retry` or the next poke resumes it from
  the log

## Remote (setting `remote: false | true`, per repo, default off)

- Off: nothing is pushed. Merging the target (the plan's central branch) into the default branch stays the user's
- On: the wave's branch is pushed when the review starts (force-with-lease after a rebase) and a pull/merge request is
  opened against the target, which is pushed once so it can be the base. The review's verdict is posted as a comment.
  After the fast-forward the target is pushed and the forge shows the request as merged with its commits
- The forge is the origin's: `gh` for GitHub, `glab` for GitLab. A missing CLI or a refused push blocks nothing: the
  wave records the failure and continues locally
- Merging the target into the default branch stays the user's here too

## Board (gigachad-bot)

- A wave's row is the only thing shown for it: name, `3/8`, stage, usage
- Opened: description (memory-store), its tasks sorted by state, the reviews with findings and a link to the reviewer's
  session, the merge, the link to the declaring session, the remote request
- Tracks and milestones sum their waves: counts and usage
- The tree is built from `waves.list`, no longer from task tags. Tasks outside a wave stay in the columns

## TUI (`factory-tui`, Textual)

A small terminal view of the factory for when no browser is open. A Python package in `tui/` of this repository, which
talks only to the `factory` CLI (`factory <action> '<json>'`): no logic of its own, no import of the core.

- Left: repositories, and under each its waves as a tree by tag (track > milestone > wave, with `3/8`, stage, usage) and
  its tasks outside a wave
- Right: the selected wave (declaration, tasks with state, reviews with findings, merge) or task (state, round, usage,
  the last timeline entries)
- Keys in memory-store's TUI style: arrows and `hjkl`, `r` refresh, `/` filter, `q` quit. It refreshes on a timer. Read
  only: no start, cancel or approve
- Installed as an optional tool: `uv tool install ./tui`

## Skill

The wave loop shrinks to: scout, contract, describe, `waves.start`, `tasks.wait`, decide (question, blocked task,
rejection), next wave. No branches, no chain bookkeeping, no merge request.

## Work

| Track | Wave | Tasks |
|---|---|---|
| factory | 1 | the wave record and its fold · `waves.start/add/get/list/timeline` with the task scheduler · the wave runner: review and merge, replacing `merge_request` · `tasks.wait` on waves, `waves.retry/approve/cancel/remove` |
| factory | 2 | the `remote` setting |
| board | 1 | wave rows from `waves.list`: progress, stage, usage · reviews, sessions and merge inside the row |
| tui | 1 | the Textual app over the `factory` CLI: tree, detail pane, refresh, filter |
| skill | 1 | the shorter wave loop, `SUBAGENT_PROTOCOL.md` |

Board wave 1 and TUI wave 1 build against this plan's interface while factory wave 1 is built.
