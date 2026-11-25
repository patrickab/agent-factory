# Views: what the factory stores, what programs get, what agents get

Draft for factory/w2. Three layers:

- **Record**: the append-only logs on disk. Nobody reads them directly
- **Full view**: JSON, stable, everything. For the board, the TUI, pi-host, scripts (`factory <action> --json`, pi-host's `callAction`)
- **Agent view**: text lines, only what the next decision needs. For agents (the `factory` tool, MCP, and the CLI by default)

Rules of the agent view:

- first line: kind, short id (8 chars, every action accepts it), state. Then only the lines that matter in that state
- never: paths, timestamps, settings, the echoed request, session ids, per-message usage
- usage is one cost figure
- `next:` lists the actions valid now
- an agent that needs more asks for it: `full: true` on any action returns the full view as JSON

## Decisions that override the tables below (user, after the first draft)

- A tool call has two purposes for an agent: trigger an event in the protocol, or answer a question about what is going
  on. `tasks.timeline` and `waves.timeline` do neither: they dump the log. They are **not in the agent's tool**. They stay
  for programs (full view) to render and replay
- What an agent would have looked up in a timeline is part of `tasks.get` / `waves.get`, chosen by the state:
  blocked -> the failure (gate output tail, conflict files) · rejected -> the review's findings · done -> the coder's final
  message · waiting_answer -> the question
- A review's result goes through the protocol: a rejection is pushed to the origin session with the findings in the
  message itself (severity, file:line, text). The supervisor decides and creates the fix tasks with `waves.add`; the
  factory then reviews again by itself. The reviewer never starts tasks
- The timelines are not tool calls at all: not in the Pi tool, not in the MCP tool. They are part of the core library and
  the CLI (`--json`), which is what pi-host, the board and the TUI use
- A merged wave is pushed too and starts a supervisor turn: it is the signal to declare the next wave
- `tasks.list` / `waves.list` in the agent view show what is not finished, and a count of the rest. No `all` parameter
- No `show` parameter anywhere
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
  actions: string[]                   // tasks.* valid now
}

type WaveView = {                     // as in the contract
  id: string; repo: string; tag: string; plan: string | null; title: string; request: string
  branch: string; target: string; base: string; origin: string | null; createdAt: string
  stage: "building" | "reviewing" | "rejected" | "merging" | "waiting_approve" | "merged" | "blocked" | "cancelled"
  reason: "conflict" | "gates" | "dirty" | "infra" | "review_failed" | null
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
  review 2: rejected · 2 major, 5 minor   (waves.timeline {id, show: "findings"})
  next: waves.add, waves.cancel
```

State-dependent lines of a task: `question:` (waiting_answer) · `blocked: <reason>` plus the failed gate's last lines or the
conflict's files (blocked) · `interrupted` · `waits for tasks.approve` (waiting_approve) · `merged <commit>` (done).
Of a wave: `blocked: <reason>` with its detail · `cannot start: <keys>` (unreachable tasks) · `merged <from>..<to>` ·
`remote: <url>`.

## Tasks

| Action | Params | Full view | Agent view |
|---|---|---|---|
| `tasks.start` | `{repo, title, request, tag?, plan?, overrides?}` | `{task: TaskView}` | `started task 4ae7325b  running  factory/w1` |
| `tasks.get` | `{id}` | `{task: TaskView}` | the task block above |
| `tasks.list` | `{repo?, tag?, all?}` | `{tasks: TaskView[]}` | one line per unfinished task, then a count (below) |
| `tasks.timeline` | `{id, since?, show?}` | `{entries: TimelineEntry[], next: number}` | by `show` (below) |
| `tasks.diff` | `{id}` | `{base, paths: {path, added, removed}[], patch}` | file list with counts; the patch only with `full` |
| `tasks.message` | `{id, text}` | `{task: TaskView}` | `sent to task 4ae7325b  running` (or `answered task ...`) |
| `tasks.approve` · `tasks.retry` · `tasks.cancel` | `{id}` | `{task: TaskView}` | `task 4ae7325b  merging` · `... running  round 3` · `... cancelled` |
| `tasks.remove` | `{id, force?}` | `{removed: string, dropped: string \| null}` | `removed task 4ae7325b` (+ `dropped: 1 unmerged commit`) |
| `tasks.wait` | `{ids? \| tag? \| wave?, ignore?, timeoutMs?}` | `{tasks: TaskView[], waves: WaveView[], attention: string[], timedOut: boolean}` | only what needs attention (below) |

```
tasks.list {repo}
  task a113f7bb  running  round 1  factory/w1  $8.38  feat(waves)!: the wave runner reviews and merges
  task 7cf4e91e  blocked: review_timeout  board/w1  $0.55  feat(factory): the board shows waves
  26 finished, not shown (all: true)
```

```
tasks.timeline {id, show}            show: "last" (default) | "failure" | "findings" | "all"
  last      the coder's final message, verbatim
  failure   blocked: gates · bun run types (exit 1) + the gate's output tail
  findings  review 1: rejected + one line per finding: major src/core.ts:816 <text>
  all       one line per entry: 10:07:16 gate types passed 7.6s  (coder text cut to its first line)
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

## Waves

| Action | Params | Full view | Agent view |
|---|---|---|---|
| `waves.start` | `{repo, tag, title, request, tasks: {key, title, request, after?}[], plan?, overrides?}` | `{wave: WaveView}` | `started wave 3f2a91c0  building  0/5  factory/w1` + `started: record` + `waits: actions (record) · runner (actions)` |
| `waves.add` | `{id, tasks}` | `{wave: WaveView}` | `wave 3f2a91c0  building  4/6` + `started: fix` |
| `waves.get` | `{id}` | `{wave: WaveView}` | the wave block above |
| `waves.list` | `{repo?, tag?, all?}` | `{waves: WaveView[]}` | one line per unfinished wave, then a count |
| `waves.timeline` | `{id, since?, show?}` | `{events: WaveEvent[], next: number}` | `show`: `findings` (default after a review), `failure`, `all` |
| `waves.retry` · `waves.approve` · `waves.cancel` | `{id}` | `{wave: WaveView}` | `wave 3f2a91c0  reviewing` · `... merging` · `... cancelled` |
| `waves.remove` | `{id, force?}` | `{removed: string}` | `removed wave 3f2a91c0 and 5 tasks` |

```
waves.list {repo}
  wave 3f2a91c0  reviewing  5/5  factory/w1  $19.20
  wave 77b0c2e1  building   1/2  factory/w2  $1.10
  2 merged, not shown (all: true)
```

```
waves.timeline {id, show: "findings"}
  review 2: rejected  (opus, 6 min, $0.90)
    major  src/wave-runner.ts:309  A wave whose remaining tasks can never start stays building forever. Fix: ...
    major  src/core.ts:1060        A task that fails to launch is retried every 10 s, silently. Fix: ...
    minor  src/tasks.ts:94         tasks.import can put a task into a wave. Fix: ...
```

## Repositories, settings, models, config

| Action | Params | Full view | Agent view |
|---|---|---|---|
| `repos.list` | `{}` | `{repos: string[]}` | one path per line |
| `repos.add` · `repos.remove` | `{repo}` | `{repos: string[]}` | `registered /home/me/git/app` · `unregistered ...` |
| `branches.list` | `{repo}` | `{branches: {name, default: boolean, hasConfig: boolean}[]}` | `master (default) · waves (factory.yaml)` |
| `models.get` | `{}` | `{models: string[]}` | one id per line |
| `models.set` | `{models}` | `{models: string[]}` | `2 models set` |
| `settings.get` | `{repo}` | `{stored, resolved, defaults}` each `{branch, merge, maxRounds, review, models: {coder, reviewer}, preview, remote}` | the resolved values, one per line, `(default)` after those not stored |
| `settings.set` | `{repo, settings}` | as `settings.get` | the changed values only |
| `config.get` | `{repo, branch?}` | `{exists: boolean, text: string \| null, draft: string \| null, source: string[]}` | `factory.yaml (committed on waves)` + the text; without one: `no factory.yaml` + the draft |
| `config.write` | `{repo, text, overwrite?}` | `{path: string}` | `wrote factory.yaml (not committed)` |

## Errors

Full view: `{error: {code, message}}` (CLI: exit 1, `invalid` exit 2). Agent view, one line with the way out:

```
refused: wave 3f2a91c0 is merged, nothing can be added · next: waves.remove
not_found: no task matches "4ae7" (2 match "4a": 4ae7325b, 4a01c9d2)
```

## Notifications (pushed into the origin session)

The same blocks, with one line on top saying why it arrived:

```
factory: wave factory/w1 was rejected
wave 3f2a91c0  rejected  4/5 done  $18.40
  review 2: rejected · 2 major, 5 minor   (waves.timeline {id, show: "findings"})
  next: waves.add, waves.cancel
```

```
factory: a coder asks
task 4ae7325b  waiting_answer  factory/w1
  question: waves.start takes `overrides` that the wave's tasks inherit, ...
  next: tasks.message (answers it)
```

## The action list itself

`factory actions` in the agent view: one line per action, `name {params} - summary`. One action's full parameter schema:
`factory actions {name}`. Full view: the JSON schema of every action, as today.
