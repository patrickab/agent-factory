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
  on. `tasks.timeline` does neither: it dumps the log. It is **not in the agent's tool** (not in
  the Pi tool, not in the MCP tool). It stays in the core and the CLI (always JSON) for programs to render and replay
- What an agent would have looked up in a timeline is part of `tasks.get` / `waves.get`, chosen by the state:
  blocked -> the failure (the failed gate and its output tail, the merge's error, the stage event's detail) · rejected ->
  the review's findings · done -> the merged commit and the coder's last message · waiting_answer -> the question
- A review's result goes through the protocol: a rejection is pushed to the origin session with the findings in the
  message itself (severity, file:line, text). The supervisor decides and creates the fix tasks with `waves.add`; the
  factory then reviews again by itself. The reviewer adds `fix:` tasks itself (at most three per wave) and may send the supervisor one quiet note (`notify_supervisor`)
- A task's review is not pushed: the verdict goes back to the task (a next round or on to the merge); only a rejection of the wave's last pass, a note or a reviewer's `fix:` task reaches the supervisor
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
  state: "running" | "reviewing" | "merging" | "waiting_answer" | "waiting_approve" | "blocked" | "done" | "cancelled"
  round: number
  reason: string | null               // why it is in this state: "gates", "conflict", "review_rejected", "merged", ...
  question: string | null             // only in waiting_answer
  running: boolean; interrupted: boolean
  settings: { branch: string; merge: "auto" | "review"; maxRounds: number; review: boolean
              models: { coder: string; reviewer: string } }
  usage: Usage | null                 // coder, reviews and scouts
  // added in factory/w2, for the agent view's state lines
  lastMessage: string | null          // the coder's last message (not its answer to the commit message ask)
  failure: string | null              // only in blocked: "<gate argv> (exit N)" + output tail, or the merge's error
  review: { round: number; status: string; approved: boolean; findings: Finding[] } | null   // the last review
  minors: { round: number; file: string; line: number | null; text: string }[]   // minor findings of every review: kept, never a round
  merged: string | null               // the commit the last merge landed
  flaky: string[]                     // gate steps that failed, then passed on their rerun: failing test names, else commands
  actions: string[]                   // tasks.* valid now
}

type WaveView = {                     // as in the contract
  id: string; repo: string; tag: string; plan: string | null; title: string; request: string
  branch: string; target: string
  after: string[]                     // ids of the waves it waits for, [] when none
  origin: string | null; createdAt: string
  stage: "queued" | "building" | "reviewing" | "rejected" | "merging" | "waiting_approve" | "merged" | "blocked" | "cancelled"
  reason: "conflict" | "gates" | "dirty" | "infra" | "review_failed" | null
  detail: string | null               // added in factory/w2: the last stage event's why (queued: why it can never start)
  running: boolean; interrupted: boolean
  tasks: { key: string; title: string; after: string[]; taskId: string | null; sessionId: string | null
           state: string; usage: Usage | null
           id?: string }[]                // its task id, declared with it (pending too); absent in a log written before ids
  counts: { total: number; done: number }
  reviews: { round: number; at: string; sessionId: string | null; model: string | null
             verdict: "approved" | "rejected" | "failed"; status: string
             findings: { severity: "blocker" | "major" | "minor"; file: string; line: number | null; text: string }[]
             usage: Usage | null; wallMs: number }[]
  minors: { round: number; task?: string; file: string; line: number | null; text: string }[]   // its tasks' (task: key), then its own
  gates: { at: string; phase: "review" | "merge"; passed: boolean; wallMs: number; log: string | null; flaky?: string[] }[]
  merge: { at: string; from: string; to: string; ref?: string; commits?: number } | null   // ref, commits: a squash wave's task commits
  usage: Usage | null                 // tasks, reviews and scouts
  actions: string[]
  updates?: { at: string; key: string | null; fields: string[] }[]   // tasks.update (key) and waves.update (null) events, oldest first
  feedback?: { kind: string; what: string; cost: string | null; suggestion: string | null; task: string | null; wave: string | null; role: string }[]   // waves.get only, oldest first; task null: the wave reviewer's fit pass
}

type TimelineEntry = { at: string; kind: string; data: object }   // kinds: task, round, coder, user, gate, review, question, merge, state
type WaveEvent = { at: string; kind: "tasks" | "task" | "stage" | "gate" | "review" | "merge" | "update" | "launch" | "contract" | "task_review" | "conflict" | "note"; [field: string]: unknown }
// task_review: a task's review inside the wave · conflict: a rebase conflict left to a task · note: {text, taskId} a supervisor note
// update: tasks.update {key, title?, request?, after?, model?} or waves.update {title?, request?} · launch: the runner
// launches the pending task {key, title?, request?: the text it launched with} · contract: contracts.apply {name, paths, done}
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
  minor findings: 1
    minor  src/tasks.ts:94  tasks.import can put a task into a wave. Fix: ...  (review 2)
  updated: docs (request), wave (title)
  feedback: 1
    context (coder, task a113f7bb): read 40 files, needed 3 · cost: 2 avoidable rounds · suggestion: ...
  next: waves.add, waves.cancel
```

State-dependent lines of a task: `question:` (waiting_answer) · `blocked: <reason>` in the header, then `failure:` (the
failed gate and the last lines of its output, or the merge's error) and, blocked by its review, the findings ·
`interrupted:` · `waits for tasks.approve` (waiting_approve) · `done: merged · merged <commit>` and `last message:`
(done). Of a wave: `blocked: <reason>` with `why: <detail>`, the failed gate's last lines or the failed review ·
the findings (rejected, waiting_approve) · `cannot start: <keys>` (unreachable tasks) · `merged <from>..<to>` · `history: <ref> (<n> commits)` (squash) ·
`waits for: <ids>` (queued), with `queued: can never start` in the header and `why: <detail>` when a
wave it waits for was cancelled. Of both: `flaky: <names>` when a gate step passed only on its rerun; `minor findings: N` with one line each (a review's
lines list only blocker and major findings: only they reject).

## Tasks

| Action | Params | Full view | Agent view |
|---|---|---|---|
| `tasks.start` | `{repo, title, request, tag?, overrides?}` | `TaskView` | `started task 4ae7325b  running  factory/w1` |
| `tasks.get` | `{id}` | `TaskView` | the task block above |
| `tasks.list` | `{repo?, tag?}` | `{tasks: TaskView[]}` | one line per unfinished task, then a count (below) |
| `tasks.timeline` | `{id, since?}` | `{entries: TimelineEntry[], next: number}` | none: not offered to agents; the CLI prints JSON |
| `tasks.diff` | `{id}` | `{diff, files: {path, added, removed}[]}` | file list with counts; the patch only in the full view |
| `tasks.message` | `{id, text}` | `TaskView` | `sent to task 4ae7325b  running  round 1` |
| `tasks.approve` · `tasks.retry` · `tasks.cancel` | `{id}` | `TaskView` | `task 4ae7325b  merging` · `... running  round 3` · `... cancelled` |
| `tasks.remove` | `{id, force?}` | `{removed: string, dropped: string \| null}` | `removed task 4ae7325b` (+ ` · dropped: 1 unmerged commit ...`) |
| `tasks.wait` | `{ids? \| tag? \| wave?, timeoutMs?}` | `{tasks: TaskView[], waves: WaveView[], attention: string[], timedOut: boolean}` | only what needs attention (below) |

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
| `waves.start` | `{repo, tag, title, request, tasks: {key, title, request, after?}[], after?, plan?, contracts?, overrides?}` | `{wave: WaveView}` | `started wave 3f2a91c0  building  0/5 done  factory/w1 · started: record · waits: actions (record), runner (actions)`; with `after`: `declared wave 9c4d1e2f  queued  0/2 done  factory/w3 · waits for: 3f2a91c0` |
| `waves.add` | `{id, tasks}` | `{wave: WaveView}` | `wave 3f2a91c0  building  4/6 done  factory/w1 · added: fix running` |
| `waves.get` | `{id}` | `{wave: WaveView}` | the wave block above |
| `waves.list` | `{repo?, tag?, origin?, open?}` | `{waves: WaveView[]}` | one line per unfinished wave (queued: `after <tags>`, a tag when listed, else the short id), then a count |
| `waves.retry` | `{id}` | `{wave: WaveView, retried: string[], refused: {id, why}[]}` | the wave line, `retried tasks: 3f2a, 9c4d` · `refused task 3f2a: <why>`; the card lists them |
| `waves.approve` · `waves.cancel` | `{id}` | `{wave: WaveView}` | `wave 3f2a91c0  merging  5/5 done  factory/w1` · `... cancelled ...` |
| `waves.update` | `{id, title?, request?}` | `{wave: WaveView, changed: boolean}` | the wave line, `updated, the next review reads it` · `nothing changed` |
| `tasks.update` | `{id, title?, request?, after?, model?}` | `{wave: WaveView, key, changed: boolean, delivery: "pending"\|"sent"\|"kept"\|"starting"}` | the wave line, `task docs updated, <starts with it \| its coder was told \| its coder is told at its next turn \| its coder is told as it starts>` · `task docs: nothing changed` |
| `contracts.apply` | `{store, name, op}` | `{store, name, changed: string[], notified, kept, done: {wave, tag, key, task}[]}` | `contract core: 1 fact changed · told: factory/w1:docs · next turn: ... · done, may need a follow-up task: ...` · `contract core: nothing changed` |
| `waves.remove` | `{id, force?}` | `{removed: string}` | `removed wave 3f2a91c0` |

```
waves.list {repo}
  wave 3f2a91c0  reviewing  5/5 done  factory/w1  $19.20  the wave mechanism
  wave 77b0c2e1  building  1/2 done  factory/w2  $1.10  views and notifications
  wave 9c4d1e2f  queued  0/2 done  factory/w3  after factory/w1, factory/w2  the board
  2 merged or cancelled, not shown
```

## Scouts

| Action | Params | Full view | Agent view |
|---|---|---|---|
| `scouts.start` | `{concern, questions?, wait?, store?, repo?}` | `{scout: ScoutView, timedOut: boolean}` | the scout block; the Pi tools add where the report arrives |
| `scouts.get` | `{id}` | `{scout: ScoutView}` | the scout block |

```
scout 5c0a7d21  done  $0.12
concern: how pi-host restarts a session child

MISSING
1. ...
```

## Gate proofs

| Action | Params | Full view | Agent view |
|---|---|---|---|
| `gates.prove` | `{repo, branch?}` | `{proof: ProofView}` | `started proof 9c1d2e3f  running  master 0ab12cd` |

`ProofView`: `{id, repo, branch, commit, origin, createdAt, state: running \| passed \| flaky \| failing, steps: {command, passed, wallMs, flaky}[], flaky, failing: {step, tail, log} \| null, endedAt, running, interrupted}`.
`tasks.wait {ids}` takes proof ids: `proofs` in its answer, a `failing` or interrupted proof in `attention`. The
proof block of a notice:

```
  proof 9c1d2e3f  failing  master 0ab12cd
    failing: bun scripts/changed-tests.ts, last lines:
      (fail) the wave merges
      changed-tests: 41 passed, 1 failed in 80s: src/waves.test.ts
    next: fix the branch, then gates.prove again
```

## Repositories, settings, models, config

| Action | Params | Full view | Agent view |
|---|---|---|---|
| `repos.list` | `{}` | `{repos: string[]}` | one path per line |
| `repos.add` | `{repo}` | `{repo, repos}` | `registered ~/git/app` |
| `branches.list` | `{repo}` | `{branches: {name}[]}` | `master · waves` |
| `models.get` | `{}` | `{models: string[]}` | one id per line |
| `models.set` | `{models}` | `{models: string[]}` | `2 models set` |
| `settings.get` | `{repo}` | `{stored, resolved, defaults}` each `{branch, merge, maxRounds, review, models: {coder, reviewer}, preview, squash}` | the resolved values, one per line, `(default)` after those not stored |
| `settings.set` | `{repo, settings}` | as `settings.get` | the changed values only |
| `config.get` | `{repo}` | `{exists: boolean, text: string \| null, draft: string \| null, source: string[]}` | `factory.yaml (working copy)` + the text; without one: `no factory.yaml` + the draft |
| `config.write` | `{repo, text, overwrite?}` | `{path: string}` | `wrote factory.yaml (not committed)` |

## Waves and tasks: throughput lines

- `waiting for a test slot`: a task's or wave's runner waits for one of the machine's test slots (`waitingForSlot: true` in the full view)
- `conflicts` (full view, absent when none): the conflict tasks added to the wave `{at, phase: "review" | "merge", key: "conflict-<n>", head, onto, files}`; the task is a `fix: resolve the conflict of ...` in the task list. Not in the agent view

## Errors

The core throws `FactoryError(code, message)`. The CLI with `--json` prints `factory: <code>: <message>` to stderr
(exit 1, `invalid` exit 2); the agent view (the tools, the CLI without `--json` after `factory: `) is one line with the
way out:

```
refused: wave 3f2a91c0 is merged, nothing can be added · next: waves.get shows the actions valid now
not_found: no task has an id starting with "4ae7" · next: tasks.list
```

## Notifications (pushed into the origin session)

A contract change that reaches done tasks of a wave: `factory: contract core changed (<facts>): wave factory/w1 has done tasks docs, which may need a follow-up task`, once.

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

A scout a supervisor session did not wait for (a coder gets the same block as a `factory-scout` message):

```
factory: scout 5c0a7d21 reported
scout 5c0a7d21  done  $0.12
concern: how pi-host restarts a session child

MISSING
...
report: ~/.pi/agent/factory/scouts/session-.../5c0a7d21-.../report.md
```

A gate proof, when it ends:

```
factory: the gates of master pass, flaky
proof 9c1d2e3f  flaky  master 0ab12cd
  steps passed: 3
  flaky: the wave merges
  next: waves.start on it
```

## Cards

Fourth form, for people: next to the agent's text, every notice (`details {key, card}`) and every `factory` tool result
(`details {result, card}`, none on an error) carries a `FactoryCard`, computed by the factory in `src/cards.ts` from the
event's view object (each feature registers a builder per action). A surface (Pi's TUI, gigachad-bot) renders it and
never parses the agent's text. No undefined field, no empty list: it survives JSON unchanged.

```ts
interface FactoryCard {
  v: 1;                              // unknown fields are ignored by a renderer
  kind: "wave" | "task" | "scout" | "proof" | "contract" | "decision" | "action";
  tone: "attention" | "quiet";       // attention: needs a ruling (question, rejected, blocked, waiting for approve,
                                     //   interrupted, can never start, failing gates)
  title: string;                     // one line, no "factory:" prefix
  tag?: string; id?: string;         // the wave's tag; the short id
  state?: string;
  cost?: number;                     // cents
  progress?: { done: number; total: number };
  rows?: { label: string; text: string }[];
  findings?: { severity: "blocker" | "major" | "minor"; file?: string; line?: number; text: string }[];
  text?: string;                     // markdown: question, message sent, report; failures and logs fenced
  answers?: string;                  // decision: the notice key it settles
}
```

Kinds, each with an example (JSON abridged):

- `wave`: tag, id, stage as state, cost, task progress; rows wave, why, waits for, can never start, merged,
  tasks; the last review's findings unless approved
  `{kind:"wave", tone:"attention", title:"wave factory/w1 was rejected", tag:"factory/w1", id:"3f2a91c0", state:"rejected", cost:1840, progress:{done:4,total:5}, rows:[{label:"why",text:"review 2 rejected"}], findings:[{severity:"major", file:"src/wave-runner.ts", line:309, text:"..."}]}`
- `task`: id, tag, state, cost; rows task, round, why, merged, flaky; text is the question, the failure (fenced) or the coder's last message
  `{kind:"task", tone:"attention", title:"a coder asks", id:"4ae7325b", state:"waiting_answer", tag:"factory/w1", text:"waves.start takes overrides ..."}`
- `scout`: id, state, cost; rows concern, questions, error, report; text is the report
  `{kind:"scout", tone:"quiet", title:"scout 5c0a7d21 reported", id:"5c0a7d21", state:"done", cost:12, text:"MISSING ..."}`
- `proof`: id, state; rows branch, steps, flaky, failing, log; text is the failing step's tail (fenced)
  `{kind:"proof", tone:"quiet", title:"the gates of master pass, flaky", id:"9c1d2e3f", state:"flaky", rows:[{label:"flaky",text:"the wave merges"}]}`
- `contract`: a contract change that reached done tasks; rows changed, done tasks, next
  `{kind:"contract", tone:"quiet", title:"contract core changed", tag:"factory/w1", rows:[{label:"done tasks",text:"docs"}]}`
- `decision`: the card of a supervisor's settling action; `text` is what was sent or changed, `answers` the notice key
  `{kind:"decision", tone:"quiet", title:"updated task docs of wave factory/w1", text:"<the new request>", answers:"task:4ae7325b:waiting_answer:1@..."}`
- `action`: any other action's result (lists, settings, models, timelines); rows hold the entries
  `{kind:"action", tone:"quiet", title:"2 tasks", rows:[{label:"4ae7325b", text:"running  factory/w1  the wave mechanism"}]}`

Decisions: `tasks.message` (to a task in `waiting_answer` or `blocked`), `tasks.update`, `waves.update`, `waves.add` (to a
rejected or blocked wave), `tasks.retry`, `waves.retry`, `tasks.cancel`, `waves.cancel`, `contracts.apply`. The factory
reads the cause from state at call time (the task's open question, block or rejection; for `contracts.apply` the latest
rejection or block of a wave listing the contract) and the agent passes nothing. With nothing open the card is a
decision without `answers`. Each is appended to `decisions/<origin>.jsonl` under the factory home;
`decisions.list` answers in order.

| Action | Params | Full view | Agent view |
|---|---|---|---|
| `decisions.list` | `{origin?}` | `{decisions: {at, card}[]}` (`card.answers`: the notice key) | one line per decision: time, title |

Pi: notices (`factory-notice`) and the `factory` tool's call and result are drawn as cards: icon `◆`, title, tag, state,
cost, progress, rows, findings grouped by severity (collapsed to counts, expanded shows all), text. Readable is the
default; **Alt+V** toggles all factory cards of the session to the agent's text. The widget above the editor counts the
cards waiting for a ruling: the latest attention notice per task, wave, scout or proof that no later decision answered.

## The action list itself

`factory actions` in the agent view: one line per action, `name {params} - summary`. One action's params in full
(type, bounds, description, nested fields): `factory actions <name>`. `factory actions --json`: the `ACTIONS` map as JSON.
