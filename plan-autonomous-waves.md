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
