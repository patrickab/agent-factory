# Views: what the factory stores, what programs get, what agents get

As built in factory/w2. Three layers:

- **Record**: the append-only logs on disk. Nobody reads them directly
- **Full view**: JSON, stable, everything. For the board, the TUI, pi-host, scripts (`factory <action> --json`, pi-host's `callAction`)
- **Agent view**: text lines, only what the next decision needs (`src/agent-view.ts`). For agents: the `factory` tool in
  Pi, the MCP tool, and the CLI by default

One renderer serves all three interfaces; they hold no logic. The only switch is the CLI's `--json` (anywhere after
the action): no action takes a `full` or a `show` param.

Rules of the agent view:

- first line: kind, short id (8 chars, every action accepts it), state. Then only the lines that matter in that state
- never: paths (a home directory reads `~`), timestamps, settings, the echoed request, session ids, per-message usage
- usage is one cost figure
- `next:` lists the actions valid now
- an agent that needs more than its view holds is a program: the CLI with `--json`

Decisions (user):

- A tool call has two purposes for an agent: trigger an event in the protocol, or answer a question about what is going
  on. `tasks.timeline` and `waves.timeline` do neither: they dump the log. They are **not in the agent's tool** (not in
  the Pi tool, not in the MCP tool). They stay in the core and the CLI (always JSON) for programs to render and replay
- What an agent would have looked up in a timeline is part of `tasks.get` / `waves.get`, chosen by the state:
  blocked -> the failure (the failed gate and its output tail, the merge's error, the stage event's detail) · rejected ->
  the review's findings · done -> the merged commit and the coder's last message · waiting_answer -> the question
- A review's result goes through the protocol: a rejection is pushed to the origin session with the findings in the
  message itself (severity, file:line, text). The supervisor decides and creates the fix tasks with `waves.add`; the
  factory then reviews again by itself. The reviewer never starts tasks
- A merged wave is pushed too and starts a supervisor turn: it is the signal to declare the next wave
- `tasks.list` / `waves.list` in the agent view show what is not finished, and a count of the rest. No `all` parameter
- `tasks.diff` in the agent view: the file list with counts
- Everything that needs attention (a question included) is pushed to the origin session; `tasks.wait` is only for callers
  without a Pi session

## Shared shapes (full view)

```ts
type Usage = { input: number; output: number; cost: number }

type TaskView = {
  id: string; repo: string; title: string
  tag: string; plan: string | null
  wave: string | null                 // the wave it belongs to
  origin: string | null               // Pi session that started it
  worktree: string; branch: string
  sessionId: string; sessionPath: string
  createdAt: string; at: string       // at = last state change
  state: "running" | "merging" | "waiting_answer" | "waiting_approve" | "blocked" | "done" | "cancelled"
  round: number
  reason: string | null               // why it is in this state: "gates", "conflict", "review_rejected", "merged", ...
  question: string | null             // only in waiting_answer
  running: boolean; interrupted: boolean
  settings: { branch: string; merge: "auto" | "review"; maxRounds: number; review: boolean
              models: { coder: string; reviewer: string } }
  usage: Usage | null
  // added in factory/w2, for the agent view's state lines
  lastMessage: string | null          // the coder's last message (not its answer to the commit message ask)
  failure: string | null              // only in blocked: "<gate argv> (exit N)" + output tail, or the merge's error
  review: { round: number; status: string; approved: boolean; findings: Finding[] } | null   // the last review
  merged: string | null               // the commit the last merge landed
  actions: string[]                   // tasks.* valid now
}

type WaveView = {                     // as in the contract
  id: string; repo: string; tag: string; plan: string | null; title: string; request: string
  branch: string | null; target: string; base: string | null   // null while queued: set when it starts
  after: string[]                     // ids of the waves it waits for, [] when none
  origin: string | null; createdAt: string
  stage: "queued" | "building" | "reviewing" | "rejected" | "merging" | "waiting_approve" | "merged" | "blocked" | "cancelled"
  reason: "conflict" | "gates" | "dirty" | "infra" | "review_failed" | null
  detail: string | null               // added in factory/w2: the last stage event's why (queued: why it can never start)
  running: boolean; interrupted: boolean
  tasks: { key: string; title: string; after: string[]; taskId: string | null; sessionId: string | null
           state: string; usage: Usage | null }[]
  counts: { total: number; done: number }
  reviews: { round: number; at: string; sessionId: string | null; model: string | null
             verdict: "approved" | "rejected" | "failed"; status: string
             findings: { severity: "blocker" | "major" | "minor"; file: string; line: number | null; text: string }[]
             usage: Usage | null; wallMs: number }[]
  gates: { at: string; phase: "review" | "merge"; passed: boolean; wallMs: number; log: string | null }[]
  merge: { at: string; from: string; to: string; queueMs: number } | null
  remote: { number: number | null; url: string | null; pushed: string | null; error: string | null } | null
  usage: Usage | null
  actions: string[]
}

type TimelineEntry = { at: string; kind: string; data: object }   // kinds: task, round, coder, user, gate, review, question, merge, state
type WaveEvent = { at: string; kind: "tasks" | "task" | "stage" | "gate" | "review" | "merge" | "remote"; [field: string]: unknown }
```

The agent view of one task and one wave, used by every action below:

```
task 4ae7325b  waiting_answer  round 1  factory/w1  $2.10
  feat(waves): declare a wave and let the factory start its tasks
  question: waves.start takes `overrides` that the wave's tasks inherit, but the declaration has no field for them. ...
  next: tasks.message (answers it), tasks.cancel
```

```
wave 3f2a91c0  rejected  4/5 done  factory/w1  $18.40
  the wave mechanism
  tasks: record done · actions done · runner done · wait done · docs cancelled
  review 2: rejected · 2 major, 1 minor
    major  src/wave-runner.ts:309  A wave whose remaining tasks can never start stays building forever. Fix: ...
    major  src/core.ts:1060  A task that fails to launch is retried every 10 s, silently. Fix: ...
    minor  src/tasks.ts:94  tasks.import can put a task into a wave. Fix: ...
  next: waves.add, waves.cancel
```

State-dependent lines of a task: `question:` (waiting_answer) · `blocked: <reason>` in the header, then `failure:` (the
failed gate and the last lines of its output, or the merge's error) and, blocked by its review, the findings ·
`interrupted:` · `waits for tasks.approve` (waiting_approve) · `done: merged · merged <commit>` and `last message:`
(done). Of a wave: `blocked: <reason>` with `why: <detail>`, the failed gate's last lines or the failed review ·
the findings (rejected, waiting_approve) · `cannot start: <keys>` (unreachable tasks) · `merged <from>..<to>` ·
`remote: <url>` · `waits for: <ids>` (queued), with `queued: can never start` in the header and `why: <detail>` when a
wave it waits for was cancelled.

## Tasks

| Action | Params | Full view | Agent view |
|---|---|---|---|
| `tasks.start` | `{repo, title, request, tag?, plan?, overrides?}` | `TaskView` | `started task 4ae7325b  running  factory/w1` |
| `tasks.get` | `{id}` | `TaskView` | the task block above |
| `tasks.list` | `{repo?, tag?}` | `{tasks: TaskView[]}` | one line per unfinished task, then a count (below) |
| `tasks.timeline` | `{id, since?}` | `{entries: TimelineEntry[], next: number}` | none: not offered to agents; the CLI prints JSON |
| `tasks.diff` | `{id}` | `{base, diff, files: {path, added, removed}[]}` | file list with counts; the patch only in the full view |
| `tasks.message` | `{id, text}` | `TaskView` | `sent to task 4ae7325b  running  round 1` |
| `tasks.approve` · `tasks.retry` · `tasks.cancel` | `{id}` | `TaskView` | `task 4ae7325b  merging` · `... running  round 3` · `... cancelled` |
| `tasks.remove` | `{id, force?}` | `{removed: string, dropped: string \| null}` | `removed task 4ae7325b` (+ ` · dropped: 1 unmerged commit ...`) |
| `tasks.wait` | `{ids? \| tag? \| wave?, ignore?, timeoutMs?}` | `{tasks: TaskView[], waves: WaveView[], attention: string[], timedOut: boolean}` | only what needs attention (below) |

```
tasks.list {repo}
  task a113f7bb  running  round 1  factory/w1  $8.38  feat(waves)!: the wave runner reviews and merges
  task 7cf4e91e  blocked: review_timeout  board/w1  $0.55  feat(factory): the board shows waves
  26 finished, not shown
```

```
tasks.wait {wave: "3f2a91c0"}
  attention:
    task 4ae7325b  waiting_answer  question: waves.start takes `overrides` ...
  still working: 2 tasks · wave building 2/5
```

```
tasks.wait {tag: "factory"}          (nothing wrong)
  wave 3f2a91c0  merged  5/5  0ab12cd..40ca0ce  $21.90
```

```
tasks.wait ...                       (limit reached)
  timed out after 10 min · still working: 3 tasks
```

- A queued wave is still working (`still working: wave 9c4d1e2f queued 0/2`): no attention, the wait goes on. One that
  can never start (a wave it waits for was cancelled) needs attention

## Waves

| Action | Params | Full view | Agent view |
|---|---|---|---|
| `waves.start` | `{repo, tag, title, request, tasks: {key, title, request, after?}[], after?, plan?, overrides?}` | `{wave: WaveView}` | `started wave 3f2a91c0  building  0/5 done  factory/w1 · started: record · waits: actions (record), runner (actions)`; with `after`: `declared wave 9c4d1e2f  queued  0/2 done  factory/w3 · waits for: 3f2a91c0` |
| `waves.add` | `{id, tasks}` | `{wave: WaveView}` | `wave 3f2a91c0  building  4/6 done  factory/w1 · added: fix running` |
| `waves.get` | `{id}` | `{wave: WaveView}` | the wave block above |
| `waves.list` | `{repo?, tag?}` | `{waves: WaveView[]}` | one line per unfinished wave (queued: `after <tags>`, a tag when listed, else the short id), then a count |
| `waves.timeline` | `{id, since?}` | `{events: WaveEvent[], next: number}` | none: not offered to agents; the CLI prints JSON |
| `waves.retry` · `waves.approve` · `waves.cancel` | `{id}` | `{wave: WaveView}` | `wave 3f2a91c0  reviewing  5/5 done  factory/w1` · `... merging ...` · `... cancelled ...` |
| `waves.remove` | `{id, force?}` | `{removed: string}` | `removed wave 3f2a91c0` |

```
waves.list {repo}
  wave 3f2a91c0  reviewing  5/5 done  factory/w1  $19.20  the wave mechanism
  wave 77b0c2e1  building  1/2 done  factory/w2  $1.10  views and notifications
  wave 9c4d1e2f  queued  0/2 done  factory/w3  after factory/w1, factory/w2  the board
  2 merged or cancelled, not shown
```

## Repositories, settings, models, config

| Action | Params | Full view | Agent view |
|---|---|---|---|
| `repos.list` | `{}` | `{repos: string[]}` | one path per line |
| `repos.add` · `repos.remove` | `{repo}` | `{repo, repos}` · `{repos}` | `registered ~/git/app` · `unregistered ...` |
| `branches.list` | `{repo}` | `{branches: {name, default: boolean, hasConfig: boolean}[]}` | `master (default) · waves (factory.yaml)` |
| `models.get` | `{}` | `{models: string[]}` | one id per line |
| `models.set` | `{models}` | `{models: string[]}` | `2 models set` |
| `settings.get` | `{repo}` | `{stored, resolved, defaults}` each `{branch, merge, maxRounds, review, models: {coder, reviewer}, preview, remote}` | the resolved values, one per line, `(default)` after those not stored |
| `settings.set` | `{repo, settings}` | as `settings.get` | the changed values only |
| `config.get` | `{repo, branch?}` | `{exists: boolean, text: string \| null, draft: string \| null, source: string[]}` | `factory.yaml (committed on waves)` + the text; without one: `no factory.yaml` + the draft |
| `config.write` | `{repo, text, overwrite?}` | `{path: string}` | `wrote factory.yaml (not committed)` |

## Errors

The core throws `FactoryError(code, message)`. The CLI with `--json` prints `factory: <code>: <message>` to stderr
(exit 1, `invalid` exit 2); the agent view (the tools, the CLI without `--json` after `factory: `) is one line with the
way out:

```
refused: wave 3f2a91c0 is merged, nothing can be added · next: waves.get shows the actions valid now
not_found: no task has an id starting with "4ae7" · next: tasks.list
```

## Notifications (pushed into the origin session)

The same blocks, with one line on top saying why it arrived. A queued wave says nothing until it can never start:
`factory: wave factory/w3 can never start`, once.

```
factory: wave factory/w1 was rejected
wave 3f2a91c0  rejected  4/5 done  factory/w1  $18.40
  the wave mechanism
  review 2: rejected · 2 major, 1 minor
    major  src/wave-runner.ts:309  A wave whose remaining tasks can never start stays building forever. Fix: ...
    ...
  next: waves.add, waves.cancel
```

```
factory: a coder asks
task 4ae7325b  waiting_answer  factory/w1
  question: waves.start takes `overrides` that the wave's tasks inherit, ...
  next: tasks.message (answers it)
```

## The action list itself

`factory actions` in the agent view: one line per action, `name {params} - summary`. One action's params in full
(type, bounds, description, nested fields): `factory actions <name>`. `factory actions --json`: the `ACTIONS` map as JSON.
