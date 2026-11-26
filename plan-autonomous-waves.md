# Plan: autonomous waves

Definitions, specifications and design decisions for the next step of the factory and of the `parallelize-plan` skill.
To be executed through the factory itself (`parallelize-plan`), on a central branch of this repository. Delete this file
once its parts are in `README.md`.

## Goal

A supervisor declares a whole plan once and the factory runs it to the end without stopping for the user:
waves start when the waves they need are merged, every task is reviewed before it is committed, contracts are written
once and reused, and anyone in the run can send a scout.

## Rollout rule

- The `factory` command runs from this checkout (`src/cli.ts`). A merge into its branch changes the code that drives every running wave
- Build on a central branch and worktree. Merge into the default branch only while no wave of any repository is running (`factory waves.list` shows none unfinished)
- Every change is additive for declarations that do not use it: a wave without `after`, `contracts` or `review` behaves as today

## Terms

| Term | Meaning |
|---|---|
| **Contract** | A named set of facts several tasks build against: signatures, routes, shapes, invariants |
| **Fact** | One memory-store memory, the unit a contract is edited in |
| **Core** | The contract every task of a plan reads: rules, what nobody touches, the user's decisions |
| **Scout** | A read-only agent that explores one concern and writes facts to the map |
| **Round** | One coder turn followed by gates and, with task review, the reviewer's verdict |
| **Baseline** | The target branch's state before the first wave branches |

## 1. Waves wait for waves

### Specification
- `waves.start` takes `after: [<tag or wave id>, ...]`
- A wave with `after` is created in a new stage `waiting`. It gets its branch and starts its tasks when every wave it names is `merged`. The branch is cut then, so it holds their code
- A named wave that is `cancelled` or removed: the waiting wave reports "can never start" to the supervisor, as a task with a cancelled predecessor does. A `rejected` or `blocked` one keeps it waiting
- `waves.get` and the board show what a waiting wave waits for
- A cycle or an unknown name is refused at `waves.start`

### Decisions
- Names resolve inside the declaring supervisor's waves of the same repository and target branch
- `waves.add` cannot change `after`

## 2. Contracts

### Specification
- A contract is a memory-store directory of facts: `<store>/run/contract/<name>/<fact>`. `core` is `<store>/run/contract/core/`
- `waves.start` takes `contracts: [<name>, ...]`. `core` is always included, named or not. The store is the wave's `plan`
- **A coder's request** is prefixed by the factory with the list of its contracts and the command that reads them. The supervisor's request holds the task's description and acceptance only
- **The reviewer's prompt** gets the contracts' text inlined (it may have no shell), read fresh at every review
- **Edits** go through a factory action that wraps one memory-store op:
  ```
  factory contracts.apply '{"store": "<store>", "name": "turn-delete-api",
    "op": {"op": "update", "path": "answer-200", "text": "{ok, removedEntries, removedMedia: [sha256]}"}}'
  ```
  `op` is `add`, `update` or `retire` on one fact
- **Notification**: after an edit the factory
  - sends every running task of every wave that lists the contract a follow-up: the contract's name, the fact's path, its old and its new text, "your contract changed, re-read it"
  - leaves pending tasks alone: they read the current facts when they start
  - reports the done tasks of those waves to the supervisor, who decides whether a follow-up task is needed
- **Direct edits are caught too**: the factory stores a hash of each listed contract per task and compares it at the start of every round. A difference sends the same follow-up, with the facts that differ

### Decisions
- Only the supervisor edits a contract. A coder requests a change in its last message, as today
- The factory reads and writes memory-store through its CLI (`memory-store read`, `memory-store apply`). A missing CLI or store refuses `contracts` at `waves.start`, nothing else changes
- The plan file of a repository is input for the supervisor only. No coder or reviewer is pointed at it

## 3. Review per task

### Specification
- `waves.start` takes `review: "task" | "wave"`. Default `wave`, today's behaviour
- With `task`:
  - One reviewer session per wave. It is resumed for every review of the wave, reviews run one after another
  - A round: coder turn → `gates` → the reviewer reads the task's diff and submits a verdict → approved: `task_gates`, commit, merge into the wave's branch
  - **Blocker and major findings go straight back to the task's coder** as its next round, up to `maxRounds`. When the rounds run out the task is `blocked` and the supervisor is woken
  - **Minor findings** are stored on the task, never start a round, and are listed by `waves.get`
  - A later round's review reads the diff since the commit the reviewer last judged, next to its own earlier findings
  - At the end of the wave: `merge_gates` once, then one short pass of the same reviewer on how the tasks fit together. Findings of that pass go to the supervisor (`rejected`), no single coder owns them
- **`read_diff`** is a tool of the reviewer's extension (`src/pi/reviewer-tool.ts`), the only way a diff reaches the reviewer
  - `read_diff({paths?})` returns the diff under review, lockfiles last, large files cut as the review patch is today
- **A finished round leaves no diff in the reviewer's context.** When `submit_verdict` is called, every tool result of that round (`read_diff`, file reads, searches) is replaced by a one-line stub through `context_edit` entries with a replacement text, e.g. `diff of task 59ee4a75, round 1: reviewed, 1 major`. The verdict stays
  - Replaced, not removed: a tool call without its result breaks the provider's pairing
  - **Guaranteed by the factory, not by the reviewer**: before it resumes the session for the next review, the factory checks the session file and stubs every tool result of an earlier round that is not a stub yet (a reviewer that died before its verdict). A test fails if a resumed session holds an earlier round's diff
- The reviewer is launched with `PI_CACHE_RETENTION=long`: contracts and earlier verdicts stay a cached prefix across the minutes between two tasks

### Decisions
- The task-level `review` setting of today (a fresh reviewer per round) stays for tasks outside a wave
- The reviewer has no shell in task review: `read`, search, `read_diff`, `scout`, `submit_verdict`

## 4. Scouts

### Specification
- A tool `scout` for the supervisor, every coder and the reviewer, and an action `scouts.start` behind it:
  ```
  scout({"concern": "how pi-host restarts a session child", "questions": ["...", "..."], "wait": true})
  ```
- **`wait` is the caller's choice**
  - `true`: the call blocks and returns the report
  - `false`: the call returns a scout id at once; the report arrives as a follow-up message to the caller (a coder, the reviewer) or as a factory report (the supervisor). `scouts.get` reads it
  - A coder's turn does not end while a scout it did not wait for is running: the factory delivers the report first
- **What a scout may do**: read and search the caller's worktree (a coder's scout sees that coder's uncommitted changes), write facts to `<store>/map/`. No shell, no edits, no scout of its own
- **No repeated work**: a scout first reads the map. A fact is stamped with the commit it was explored at. A concern whose facts are current is answered from the map without exploring
- **The report**, complete and untruncated, in this shape:
  ```
  MISSING        what the caller's plan or request does not cover, numbered
  DECISIONS      what the caller must rule on, with the options
  KEY FACTS      at most ten, each with file:line
  MEMORY         the paths written
  ```
  The supervisor's report carries the text and the path of the saved report
- **Model**: the project's small model
- **Cost**: a scout's tokens and cost are stored on the scout, with the id of its caller
  - A task's total includes its scouts'. The board and the text views show that one sum, nothing beside it
  - The split stays in the data: the JSON of `tasks.get` and `waves.get` carries `cost` and `scoutingCost`, `scouts.list` gives each scout's cost and caller, the supervisor's own scouts included
- Scouts replace the pi-subagents scouts in the skill: the factory then needs no subagent extension

### Decisions
- At most four scouts of one caller at a time, further calls queue
- A scout that finds a fact of the map wrong updates it, with its commit stamp
- The reviewer writes to the map like every other caller (decided by the user)

## 5. Gates

### Specification
- **`gates.prove`**: runs `merge_gates` in a worktree of the target branch, in the background, and reports like a wave
  - On a failure it runs the failed step once more. Passes then: `flaky`, with the failing test names. Fails again: `failing`
  - The skill starts it together with the first scouts and declares no wave before it reports `passed` or `flaky`
- **Flaky rule for every gate run** (task, wave review, merge): a failed step is run once more before it counts. A step that passes the second time is recorded as `flaky` on the task or wave with the failing test names and counts as passed. It never costs a round and never blocks
- A wave that waits (`after`) branches from a target that held its predecessors' proven gates: no second proof

### Decisions
- One rerun, not more: a step that fails twice is a failure
- **Review worktrees and packages**: a wave's review worktree is made by the factory, not by `agent-worktree`, so it has no packages unless the repository's `hooks.after_create` supplies them. That is repository configuration (gigachad-bot fixed it in its `factory.yaml`). `src/factory.template.yaml` and `README.md` say so, with an example hook

## 6. Autonomy

### Specification (the skill, `~/.os/chezmoi/dot_agents/skills/parallelize-plan/SKILL.md`)
- Calling the skill means the specification is sufficient. The run never stops for the user and never asks
- Removed: "show a sketch and get a yes"
- Every substantial deviation, decision or detail the supervisor had to settle is recorded as it happens (`run/decisions`, one fact each) and listed in the final overview under **Decisions taken**, next to the minor findings left open
- The supervisor's loop shrinks to: scout and prove → write contracts → declare every wave with `after` → handle reports (a coder's question, a blocked task, a rejected wave, a wave that can never start) → final smoke run, retro, overview
- Contracts are facts in `run/contract/<name>/`, one source of truth. The skill no longer restates rules in requests

## Order of work

| Wave | Delivers | Needs |
|---|---|---|
| `waves/1` | `after` on waves, the `waiting` stage | nothing |
| `contracts/1` | `contracts` on waves, `contracts.apply`, notification, hash check | nothing |
| `gates/1` | `gates.prove`, the flaky rule, template and README note on review worktrees | nothing |
| `scouts/1` | `scouts.start`, the `scout` tool, report shape, cost split | nothing |
| `review/1` | `review: "task"`, the reused reviewer, `read_diff`, stubbing with the factory's guarantee, long cache | `contracts/1` (inlined contracts), `scouts/1` (the reviewer's tool) |
| `skill/1` | the rewritten skill, `README.md`, this file removed | all of the above |

- The first four share little: check their file overlap in `src/core.ts`, `src/waves.ts` and `src/wave-runner.ts` before declaring them parallel
- This plan is built with today's factory: its waves are declared one after another by hand, reviewed per wave

## Risks

- **A change to the wave runner while waves run**: the rollout rule above
- **Session surgery**: the stubbing rests on Pi's `context_edit` entries. Pin the behaviour with a test against a real session file of the installed Pi version
- **Prompt cache**: a stub written into the middle of a session invalidates the cache after it. Stubbing only ever touches the newest round, so the prefix before it stays
- **A scout a coder did not wait for** can outlive the coder's turn: the factory holds the turn's end until its scouts reported
- **memory-store as a dependency** of contracts and scouts: both features refuse cleanly without it

## Settled after scouting

The scouts' facts are in memory-store `agent-factory/autonomous-waves`, `map/*`. Their gaps, ruled on by the supervisor:

### Waves wait for waves
- The stage is named **`queued`** (`waiting_approve` exists, `waiting` would read like it)
- `after` is stored in the declaration. A queued wave has no branch and no `base` yet: both are set by an event when it starts. Its branch name is reserved: taken at declaration or at the start, the wave is refused or blocks with that reason
- A merged wave pokes every queued wave of its repository and target that names it. No polling
- Names are tags or ids of waves of the same repository and target branch, whoever declared them. A tag carried by several waves means the newest that is not cancelled. Unknown name or the wave itself: refused
- `waves.remove` of a wave that a queued wave names is refused. `waves.cancel` of it marks the queued wave as one that can never start: reported to the supervisor once, attention in `tasks.wait`, shown by `waves.get`
- `waves.cancel` and `waves.remove` of a queued wave have no branch to stop or delete

### Contracts
- `plan` on a wave is the memory-store name (as `agent-factory/autonomous-waves`). `contracts` without `plan` is refused
- The prefix is added when a task's coder is launched, not stored in the request: the wave log and the reviewer keep the supervisor's text
- The contract hash lives on the task record. It is compared by the task's runner before each coder turn it starts, the place that has the core
- A changed contract reaches a task in `running` as a follow-up and one in `waiting_answer` together with its answer. Resting tasks are not woken: the supervisor gets them listed
- Tests use a fake `memory-store` on `PATH`, as they fake `pi`

### Gates
- One rerun helper for the three gate loops. No rerun after exit 75, a kill or a timeout
- `flaky: string[]` (the step's failing test names, or its command when none can be read) on the gate records of tasks and waves
- `gates.prove` is a record of its own beside waves, with the states `running`, `passed`, `flaky`, `failing`, reported through the same notifier. Its worktree is removed when it ends

### Review per task
- The setting is named **`reviewEach: true`** on `waves.start` (the boolean `review` keeps its meaning)
- The reviewer's session: a stable `--session-id` per wave with a fixed working directory and session directory. One process per review, none between reviews
- Reviews of a wave run in the wave's runner, one after another: a task's pipeline hands its round to it and waits for the verdict
- Stubbing: the factory appends the `context_edit` lines to the session file before every resume, when no process holds it. That one path is the guarantee and the only implementation. A stub starts with `[reviewed]`, which also tells it from a real result. The first task of the wave proves it against the installed Pi with a real session
- The request and the contracts are in the prompt, not read by tool, so stubbing every tool result loses nothing
- Minor findings: a field on the review record, listed by `tasks.get` and `waves.get`. Only blocker and major make a verdict a rejection
- Rounds: the task's existing `roundsUsed` and `maxRounds`
- The cached prefix needs the same model, system prompt and tools at every resume: all three are fixed per wave

### Scouts
- A scout is a `pi -p` child in the caller's working directory with `read`, `grep`, `find`, `ls` and a `map_write` tool (which runs `memory-store apply` on the plan's store and stamps the commit). The store is the `plan` of the caller's task or wave, for a supervisor the `store` it passes
- The reviewer's scouts always wait. A coder chooses; the end of its turn is held with `agent_before_settle` until its scouts reported
- A waiting call ends after 15 minutes with what the scout wrote so far. A cancelled caller cancels its scouts
- Scout records live in their own directory with caller, tokens and cost, and are summed into the caller's task and wave figures also when the scout was killed

### Order of work, corrected (the user: waves run in parallel, also on the same files)
- `waves/1`, `gates/1`, `scouts/1` and `sync/1` run at once, `contracts/1` when `waves/1` merged (both rewrite the parameters of `waves.start`), `review/1` after `contracts/1` and `scouts/1`, `skill/1` last
- Until `sync/1` is merged and live, a collision shows as a wave's rebase conflict, which the supervisor resolves

## 7. Files in step (`sync/1`)

Parallel tasks and waves may edit the same files. The factory keeps them in step instead of the supervisor keeping them apart.

### Specification
- **Who has which file** is read from each task's session file: the paths of its `read`, `edit` and `write` tool calls. Nothing is declared
- **When a change lands** (a task merges into its wave's branch, a wave merges into the target), the factory takes the changed files of that merge and, for every running task below that branch (the wave's own tasks; for the target, the tasks of every open wave on it):
  1. between two coder turns, rebases the task's worktree onto the new tip, its uncommitted work carried over
  2. sends the coder a follow-up naming the files it has read or edited that changed, with the subjects of the commits that changed them: "re-read these before you go on"
  3. a file both sides changed that does not merge cleanly is left with conflict markers and named first in that follow-up: resolving it is the coder's next step, with both intents in front of it
- An open wave's branch is rebased onto the target the same way when another wave merges, so its review sees no surprise
- A task that touched none of the changed files is rebased silently, without a message
- **Contracts and the map** need none of this: a fact is one keyed memory, edits are atomic per fact, and contract changes are announced by section 2

### Decisions
- A running turn is never interrupted: the rebase waits for the turn's end, before the gates
- The follow-up counts as no round
- A conflict the coder cannot settle goes to the supervisor through `factory_ask_supervisor`, as every question does

## 8. Throughput (`throughput/1`, the user's design after the first parallel run)

Parallel waves on the same lines are wanted. Conflicts must be rare, and cheap when they happen.

### Specification
- **Test queue**: full-suite runs (`merge_gates`) of all waves and repositories on the machine run through one queue, a fixed number at a time (default 1), each with all cores. Per-turn `gates` and `task_gates` take slots from the same pool, so nothing oversubscribes the machine. A wave's reviewer starts when its full suite passed
- **After a merge into the target**: every open wave branch and its running tasks are brought onto it (section 7)
- **Conflicts, three steps, cheapest first**:
  1. both sides only added lines at one place (lists, imports, docs): the factory keeps both, no model involved, then runs the gates. Its own check per hunk that both sides are pure additions; never git's `union` driver, which also keeps both versions of changed lines (it broke code fences and doubled lines in this plan's own run)
  2. anything else: the wave's reviewer gets both sides' commits and the conflicting hunks and starts a `fix: <...>` task in the wave (a coder writes the resolution, the reviewer reviews it like every task)
  3. the reviewer cannot settle it, or its fix task used up its rounds: `notify_supervisor`
- **The reviewer's authority**: it may start `fix:` tasks in the waves it reviews, for conflicts and for its own blocker and major findings at the wave's final pass. At most three per wave, then the supervisor. Each is reported to the supervisor as information, not as a question
- **Registrations per feature**: actions, renderers and notices are registered from one module per feature, collected by a list that merges by union, so two waves adding a feature do not meet in `core.ts`, `agent-view.ts` or `notify.ts`

### Decisions
- The reviewer never edits code itself: whoever approves a change did not write it
- The supervisor's part is the contracts: shared interfaces are agreed before the waves start, so what is left to collide is lists and docs

## 9. An adjustable plan, feedback, the reviewer's voice (built in `contracts/1` and `review/1`)

### Specification
- **A plan is declared whole and stays correctable**: all waves at once, later ones `queued` behind the waves they need. Only the supervisor adjusts it
  - `tasks.update {id, title?, request?, after?, model?}`: a pending task's brief is replaced; a running one is replaced and its coder gets old and new text; a done one is refused (add a task)
  - `waves.update {id, title?, request?}`: a wave's goal and reviewer instructions; the next review reads the new text
  - `waves.add`, `tasks.cancel`: the set of tasks. `contracts.apply`: a shared rule
  - Fixed: what a queued wave waits for
- **`feedback {kind, what, cost?, suggestion?}`**, a tool of coders, the reviewer and scouts. `kind`: `runtime`, `context`, `request`, `contract`, `tools`, `environment`, `communication`. The rest is free text (`cost` e.g. "2 avoidable reviewer and coder rounds"). The description asks for what cost runtime or context, one call per problem when it happens. Stored by the factory under `run/feedback` with task, wave and role; wakes nobody
- **`notify_supervisor {text}`**, a tool of the reviewer: something about the plan the supervisor should know while the wave can still be changed. It wakes the supervisor, the review goes on

## 10. The supervisor's part (the skill)

- **Maximize parallel work through contracts**: every interface two tasks or waves share (a signature, a route, a shape, the parameters of a shared function) is agreed in a contract before they start. What is then left to collide is lists and docs, which sections 7 and 8 make cheap
- A shared function two waves must both extend is a contract fact naming its final signature, owned by one of them
- Contract changes are safe to make mid-run: the factory tells every affected running task the changed fact (section 2)

## What the first parallel run showed (2026-11, five waves at once on today's factory)

| Seen | Answered by |
|---|---|
| Load 60 on 8 cores, tests timing out, a wave blocked on an unrelated test | test queue and shared slots (8), flaky rerun (5) |
| Seven rebase conflicts resolved by the supervisor, all in shared lists and docs | registrations per feature and the additions-only merge (8), syncs (7) |
| Two waves each added a fourth parameter to one function | a contract fact for the shared signature (10) |
| The supervisor's union rule damaged two docs | no union driver (8) |
| A reviewer's instructions could not be changed after the declaration | contracts read fresh at every review (2), `waves.update` (9) |
| A wave's type check failed on another wave's merged file | syncs bring open waves onto each merge (7) |

## 11. Views (`views/1` here, a wave of its own in gigachad-bot)

Everything of a run that reaches the supervisor's context is traceable for the user, readable, and the same in Pi's TUI and in gigachad-bot.

### Specification
- **Two forms of one event.** The text an agent reads stays as it is (written for agents). Every report the factory sends into a session and every result of the `factory` tool also carries the structured data it was rendered from (`details`: event kind, wave, tasks, state, cost, findings with severity and `file:line`, the question, the message sent)
- **One view model, two renderers.** A card per event kind, defined once (`src/views/`), rendered by the factory's Pi extension in the TUI and by gigachad-bot in the browser. Every factory event carries the factory icon, reports included (today only tool calls do)

  | Event | The card shows |
  |---|---|
  | wave merged, rejected, blocked, interrupted | tag, title, state, cost, task progress; findings by severity with file links, collapsed to a count |
  | a coder asks | the question as text, code spans as code |
  | the supervisor answers, adds or updates a task, retries, edits a contract | what was decided in one line, the full text below; an answer names the question it answers |
  | scout report, gate proof | concern or branch, state, the report's sections |

- **The timeline is what happened, in the order it happened.** No regrouping: a card stands where its event arrived. A wave's cards are tied together by its tag on each card, not by moving them
- **Quiet and attention.** Events that need a ruling (a coder asks, rejected, blocked, can never start) stand out; information (merged, retried, started, synced) is quiet
- **The switch.** Readable is the default. One toggle per card and one for the session show exactly what the agent has in context for it. The same key in the TUI and in gigachad-bot
- **Above the composer**, only what fits there without pushing the conversation: one line per open wave (tag, state, cost) and the count of events waiting for a ruling. The decisions of the run are a list opened from there, each entry jumping to its card in the timeline
- **Detail lives in the timeline**: decisions, merges, rejections and messages are cards there, never only in the strip

### Decisions
- The decisions list is filled from the supervisor's own actions (`tasks.message` to a question, `tasks.update`, `waves.update`, `waves.add` after a rejection, `contracts.apply`), not from a separate log the supervisor must remember to write
- gigachad-bot's cards follow its UI rules (`AGENTS.md`: shared primitives, no tooltips, muted)
