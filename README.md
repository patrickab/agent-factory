# agent-factory

Background coding tasks for agents. Each task gets its own git worktree and branch; a coder agent (Pi) works on it in
rounds, and after every turn the repo's hooks and gates run, then an optional review, and problems go back to the
coder. A passed round merges into the target branch, or waits for approve. A wave runs a declared set of tasks on a
branch of its own and reviews and merges that branch into its target as a whole, without a Pi session. Agents and hosts reach the factory through one core (`src/core.ts`): the Pi extension
(the `factory` tool and `/factory` commands), a CLI (`factory`) and an MCP server (`factory-mcp`). State is plain
files under Pi's agent dir; there is no daemon.

## Terms

| Term | Meaning |
|---|---|
| **task** | One request in one worktree on its own branch, run by a detached runner that drives `pi --mode rpc`. |
| **round** | A coder turn, then `after_code`, the gates and the optional review; a failed round goes back to the coder. |
| **gates** | The commands in the target's `factory.yaml` that must pass: `gates` after every turn, `task_gates` when a wave's task merges, `merge_gates` before the merge. |
| **tag** | Path segments (`plugin/m1/w1`) grouping tasks; `tasks.list` and `tasks.wait` filter by a tag or its prefix. |
| **wave** | A declared set of tasks on one branch, started in order, then reviewed and merged as a whole by its runner. |
| **rest** | No runner lives and the task waits (`waiting_approve`, `waiting_answer`, `blocked`), ended (`done`, `cancelled`) or was interrupted. |

## Install

```bash
git clone https://github.com/patrickab/agent-factory
cd agent-factory
bun install
bun link                         # factory and factory-mcp into bun's global bin dir
pi install "$PWD"                # Pi loads the extension from this same clone
pi mcp add factory -- factory-mcp  # only for a harness that wants the MCP tool (below)
```

- One copy: the CLI, the MCP server, the runners they start and the Pi extension all run from the clone, so the
  core and the extension (which writes the entries the core reads) are always one revision. Update with `git pull`
  in the clone (and `bun install` when `bun.lock` changed); a second install elsewhere (`bun install -g`,
  `pi install git:...`) is a copy that drifts
- `bun link` links the binaries into bun's global bin dir (`bun pm bin -g`, usually `~/.bun/bin`), which must be on
  PATH
- The Pi extension is required: a task's runner starts `pi` in the task's worktree, and the extension there runs the
  task (`/factory start`, the gates, the review, the merge). Pi loads it as an installed package
  (`package.json` `pi.extensions`: `src/pi/index.ts`); the runner passes no `-e`
- On PATH: `pi`, `git`, `bun` (the detached task runner), `pgrep` (finds a task's runner; without it task actions
  fail), `sh`, `awk`, `flock` and `sleep` (the merge lock and queue)
- Optional terminal view: `factory-tui` (`tui/`, read-only, the full view over `factory ... --json`), install with
  `uv tool install ./tui`
- Linux is the supported platform (`flock`, `/proc` for process liveness); macOS is untested
- Optional: `agent-worktree` on PATH. When it is there, task worktrees are made with it, else with `git worktree add`
  into `<repo>/../worktrees/<repo name>/<task>`
- The target branch must hold a committed `factory.yaml` (`/factory init` writes a draft into the main checkout)
- Set the factory models before the first task: `factory models.set '{"models":["provider/model"]}'` or
  `/factory models add <id>`

## MCP setup

The MCP server is meant for harnesses other than Pi; Pi has the extension's `factory` tool. Both can coexist in Pi:
Pi names an MCP tool `mcp__<server>__<tool>`, so the server's tool is `mcp__factory__factory` and does not clash
with the extension's `factory`.

```bash
pi mcp add factory -- factory-mcp
```

Claude Code, Codex or any other stdio MCP client:

```json
{
  "mcpServers": {
    "factory": { "command": "factory-mcp" }
  }
}
```

(Claude Code: `claude mcp add factory -- factory-mcp`.) The server's working directory is where a call's `repo`
defaults to. Tasks still run in Pi: the extension must be installed whatever the client is.

## `factory.yaml` (read from the task's base commit, never from the coder's tree)

- `hooks.after_create`: argv lists, run once in a new task worktree, and in the worktrees the factory makes itself (a
  wave's review worktree, a `gates.prove` worktree). Those are not made by `agent-worktree`: nothing copies packages
  into them, so the repository installs them here, e.g. `after_create: [[bun, install, --frozen-lockfile]]`
- `hooks.after_code`: run after every coder turn, before the gates
- `hooks.after_merge`: run in the main checkout after a merge that changed a lockfile
- Gates, three argv lists. Exit 0 passes, 75 = broken environment (the task blocks), else fails. A failed step runs
  once more (not after exit 75, a kill or a timeout): passing then, it counts as passed and is recorded `flaky` (the
  failing test names from its output, else its command) on the task or wave. A step that reruns its own failures
  prints `gate-flaky: <name>` per name that passed only on its rerun (passed: recorded `flaky`) and `gate-reran:
  <name>` per name that failed again; a step that printed either is not run once more:

  | List | What | When |
  |---|---|---|
  | `gates` | fast checks (lint, types) | after every coder turn; a wave's task again at its merge into the wave's branch |
  | `task_gates` | the tests a wave's task's change reaches; env `FACTORY_BASE` = the commit its rebased change sits on. Default: none | a wave's task at its merge, after `gates` |
  | `merge_gates` | the full suite. Default: `gates` | a task outside a wave at its merge; a wave once before its reviewer (a failure blocks it, `gates`), again at its merge only when the target moved since |

  `scripts/changed-tests.ts` is a command for `task_gates` and `merge_gates`: it runs the test files the change reaches
  (a changed `*.test.ts`, the test next to a changed source, the tests importing it, transitively over relative
  imports). The change starts at `$FACTORY_BASE`, else at the merge base with the default branch; `--all` runs every
  test file. One `bun test` process per file, the cores but two at once (`FACTORY_TEST_JOBS` overrides), at low
  priority; a file that fails beside the others runs once more alone: passing then, it passes and is printed as
  `gate-flaky: <file>`, else `gate-reran: <file>`. So the gate records it `flaky` and never runs the suite again
- `protected`: globs the coder must not change. Default: `factory.yaml`, `.factory/**`
- `lockfiles`: file names that trigger `after_merge` and go last in the review patch. Default:
  `uv.lock`, `package-lock.json`, `bun.lock`, `bun.lockb`
- Role prompts: `.factory/agents/coder.md`, `.factory/agents/reviewer.md`
- See `src/factory.template.yaml` for a commented example

## Interface

Three layers (`VIEWS.md`): the **record** (append-only logs on disk, nobody reads them directly), the **full view**
(`callAction`'s JSON, stable, everything: board, TUI, pi-host, scripts with `factory ... --json`) and the **agent
view** (`src/agent-view.ts`, text lines with only what the next decision needs, no paths, timestamps or session ids:
the `factory` tool in Pi, the MCP tool and the CLI by default). One renderer serves all three interfaces; they hold no
logic. The timelines are for programs only: not in the Pi or MCP tool, JSON in the CLI.

### Core (`src/core.ts`)

- `core.ts` is the one module clients import, the package's entry (`import { callAction } from "agent-factory"`): `ACTIONS` (name -> `{summary, params (JSON schema), mutates, hostOnly}`)
  and `callAction(name, params, {cwd?, signal?, env?, origin?})`, plain JSON in and out (`origin`: the calling Pi
  session's id, which `waves.start` records; the Pi tool passes it, the CLI and MCP do not). A failure throws
  `FactoryError(code, message, detail?)`, one sentence, `code` one of `invalid`, `not_found`, `busy`, `refused`,
  `failed`; `detail` is `{force: true}` on a refused `tasks.remove` that `force` would carry out. It imports only Bun
  and `node:`
- `env` is the environment of every runner the action starts (default `process.env`): a host passes one without its
  secrets. With `systemd-run` on PATH every runner (a task's, a wave's) runs in a systemd user scope of its own
  (`systemd-run --user --scope --quiet --collect`), else detached in its own process group: a restart of the service
  or the terminal the caller lived in leaves it running
- Actions: `repos.list|add|remove` (a repo's settings file is its registration; `add` -> `{repo, repos}`),
  `branches.list`, `settings.get|set` (`{stored, resolved, defaults}`; `preview` is a stored boolean only clients
  read), `config.get` (working copy, or a branch's committed `factory.yaml`, a draft when there is none),
  `config.write` (a registered repo; checked, not committed; replaces a file only with `overwrite: true`),
  `tasks.list|get` (a `TaskView`: record fields (`tag`, `plan`, `wave` included), last state with its time, `question`
  (the coder's open question while `waiting_answer`, else null), `running` = a live runner holds it,
  `interrupted`, the task's settings, token (`input` uncached, `output`, `cacheRead`, `cacheWrite`) and cost usage of coder and reviews, `lastMessage` (the coder's last
  message, not its commit message), `failure` (while `blocked`: the failed gate with its output tail, or the merge's
  error), `review` (the last one: round, status, approved, findings), `merged` (the commit the last merge landed), `flaky` (gate steps that passed on their rerun),
  `actions` = the task actions the core accepts now), `tasks.timeline` (session entries as `{at, kind, data}`,
  `since`/`next` = a byte cursor, read from `since` on), `tasks.diff` (base, patch, per-file added/removed lines),
  `tasks.start|approve|retry|cancel|remove|message`, `tasks.wait`,
  `waves.start|add|get|list|timeline|retry|approve|cancel|remove` (below), `scouts.start|get|list` (below),
  `gates.prove|get` (below)
- `tasks.list {repo?, tag?}`: `tag` keeps the tasks whose tag is it or starts with `tag + "/"` (`a` holds `a/b`, not
  `ab`)
- `tasks.wait {ids? | tag? | wave?, ignore?, timeoutMs?}` (`mutates: false`): exactly one of `ids` (ids or unique
  prefixes of tasks or gate proofs, resolved once), `tag` (the tasks and the waves under it as in `tasks.list`, re-listed on every poll, so
  tasks and waves started later count) and `wave` (that wave, id or unique prefix, and its tasks); `ignore` leaves task
  or wave ids out; `timeoutMs` 1000..3600000, default 600000. A task rests when no runner lives and its state is
  `waiting_approve`, `waiting_answer`, `blocked`, `done` or `cancelled`, or it is interrupted; it needs attention when
  it rests and is not `done` (a `cancelled` task of a watched wave needs none: it left the wave, which goes on). A wave
  rests `merged` or `cancelled`; it needs attention `rejected`, `blocked`, `waiting_approve`, interrupted,
  `building` with tasks that can never start (a task they wait for was cancelled or removed) while none of its started
  tasks is active (its runner rests then; the wave is not interrupted), or `queued` after a wave that was cancelled. A
  `queued` wave that can still start neither rests nor needs attention: the wait goes on. Answers
  `{tasks, waves, proofs, attention: task, wave and proof ids, timedOut}` once everything watched rests, one needs attention, the
  timeout passes or nothing is watched; an abort fails it. A wave's tasks all resting while the wave builds, reviews
  or merges is not the end. A poll re-reads a session file only when it changed and looks for runners only where that
  decides the answer
- `tasks.import` (`hostOnly`, `{record}`): registers a task record another store kept; an existing id stays. It refuses
  a record unless `repo` is a primary checkout and `worktree` one of its linked worktrees with `branch` checked out. A
  `wave` field is dropped: an imported task belongs to no wave
- A `repo` param is a path inside the repository, relative to the caller's `cwd`, which is also its default; without
  `cwd` it must be absolute. `id` accepts a unique prefix. Each action that checks a task's state and acts on it holds a
  per-task lock from the check on (a runner keeps it until it exits)
- `tasks.start` (`title`, `request`, `overrides`, `tag`, `plan`): `tag` is path segments of
  `[A-Za-z0-9._@+-]` joined by `/` (default the system user name), `plan` a memory_store path the factory only stores.
  It creates the worktree, runs
  `after_create`, spawns the runner and returns. An abort before the runner is spawned kills the hook and removes the
  worktree and branch
- `tasks.approve` (from `waiting_approve`), `tasks.retry` (from `blocked`, `cancelled` or interrupted), `tasks.cancel`
  (stops a live runner first), `tasks.message` (a live runner gets it as a follow-up through the task's inbox, a
  resting or interrupted task a new runner; to a task in `waiting_answer` it is the answer; refused while merging). A line that reaches the inbox after the runner
  closed Pi goes to a successor runner. Cancel or retry of an interrupted task fails when its runner ends before it ran
- `tasks.remove`: deletes the record, log, worktree and the task's own branch (through git) of a task that is not
  running (an interrupted task counts as not running) and not in `waiting_answer`. It refuses a task with commits its target branch lacks or
  uncommitted changes (untracked files count whatever `status.showUntrackedFiles` says); with `force: true` it removes it anyway and names what it dropped. A record an older
  version wrote with a `kind` loads; an old `merge_request` keeps its limits: its `branch` is the source it merged,
  which removing it keeps (its commits count as no unmerged work), and approve, retry, cancel and message are refused
- `overrides` and stored settings: `merge` (`auto` | `review`), `maxRounds` (1..20), `review` (bool), `branch`,
  `models.coder`, `models.reviewer`, `models.big`, `models.small` (`provider/model`). `coder` and `reviewer` mean
  what they always did: each the stored or overridden one, else Pi's session model (no reviewer is implied by the
  coder's). `big` is an alias of `coder`, accepted and answered alongside it, always equal (`coder` wins when both are
  given and differ); `small` is the coder's of a wave's task that asks for it. Stored and resolved settings answer
  the names that are set
- `defaults.yaml` at the package root names `models: {small, big}`. It is only what `small` means for a wave's task
  that asks for it where no setting names one, and then only when that model is on the factory models list (else Pi's
  session model). It never makes a model mandatory: with nothing stored and no override a task runs with Pi's session
  model, and nothing is refused for a default that is not on the list
- Commands the factory runs for a task or a wave (hooks, gates, merge gates, git, the reviewer) never inherit the
  runners' `FACTORY_TASK_SESSION`, `FACTORY_TASK_LOCK`, `FACTORY_TASK_WAVE` and `FACTORY_WAVE_LOCK`

### Waves (`src/waves.ts`, actions in `src/core.ts`)

- A wave is a declared set of tasks on one branch: `waves.start {repo, tag, title, request, tasks, after?, plan?, overrides?}`
  (`mutates: true`) checks the specs (`tasks: [{key, title, request, after?, model?}]`, `key` unique of
  `[A-Za-z0-9._-]`, `after` keys of the wave, no cycle, `model` `"small"` or `"big"`, else `invalid`), refuses an unregistered repo, a target (`overrides.branch`, else the repo's
  branch) without a committed `factory.yaml` and an existing wave branch `<target>-<tag with "/" as "-">`, creates that
  branch off the target's tip (`base`), writes the record and pokes the wave's runner, which starts every task whose
  `after` are all `done`. `origin` is the declaring Pi session. Answers `{wave}`
- `waves.start` with `after: [<tag or wave id>, ...]` (waves of the same repository and target, whoever declared them; a
  tag carried by several: the newest not cancelled; an unknown name or the wave itself: `invalid`): the wave is
  declared `queued`, stored with `after` as ids, without `branch` and `base` (null; its branch name is reserved, taken
  already: refused). It starts (a `start` event sets both, the branch is cut off the target's tip, its tasks start) when
  every wave it names is `merged`: their runner pokes it, nothing polls. Its branch taken by then: `blocked`
  (`waves.retry` queues it again). A named wave `rejected` or `blocked` keeps it queued; `waves.cancel` of one makes it a wave that can never start (a `stage`
  event, still `queued`, its `detail` says why; reported once, attention in `tasks.wait`). `waves.remove` of a wave a
  queued one names is refused. `waves.add` cannot change `after`; it adds tasks to a queued wave, which stays queued
- `overrides` are stored with the wave: its tasks start with their `models`, `maxRounds`, `review`, target = the wave
  branch and `merge: auto` (a task merges into the wave branch by itself); `merge` is the wave's own
- A task's `model` (`"small"` | `"big"`, default `big`) picks which of the wave's two models its coder runs with,
  resolved against the wave's stored settings when the task starts. It is stored in the `tasks` event (absent: `big`)
  and shown as `WaveView.tasks[].model`, never null (`big` also for logs written before the field). The reviewer's
  model stays the wave's: a chain of easy tasks runs on a cheaper model without a wave of its own
- The wave's tasks carry its `tag`, `plan` and `wave` id; `tasks.start` cannot set `wave` (a task joins a wave only
  through `waves.start`/`waves.add`)
- `waves.add {id, tasks}`: more tasks (specs as for `waves.start`, `model` too; `after` may name existing keys); a `rejected`, `blocked`, `reviewing` or
  `waiting_approve` wave goes back to `building`; refused when `merged`, `cancelled` or `merging`. Pending tasks that
  can never start (a task they wait for was cancelled or removed) are dropped (`dropped` in the `tasks` event): they
  count as cancelled. Added during `reviewing`, the running review is killed at once
- `waves.retry {id}`: a `blocked` wave with tasks not started or not finished (a launch failed) builds again (stage
  `building`); any other `blocked` wave runs review and merge again from the rebase (stage `reviewing`); an interrupted
  one resumes the stage its log holds; it pokes the runner. `waves.approve {id}`: only from `waiting_approve` (the
  wave's `merge: review`), on to `merging`. Both answer `{wave}`
- `waves.cancel {id}`: refused when `merged` or `cancelled`; records `cancelled`, stops the wave's runner and cancels
  its tasks that are not `done` or `cancelled` (as `tasks.cancel`). The wave's branch stays (a queued wave has none).
  Answers `{wave}`
- `waves.remove {id, force?}`: refused while the wave's runner lives or one of its tasks runs or waits for an answer;
  removes its tasks as `tasks.remove` does (refused, before anything is deleted, for unmerged work without `force`),
  then its record, lock, log and reviews. The wave's branch is deleted only when the wave is `merged`. Answers
  `{removed: id}`
- `WaveView.actions` lists exactly the `waves.*` actions valid now
- The record `waves/<id>.jsonl` is an event log, append-only: line 1 the declaration, then one event per line
  (`tasks`, `task`, `stage`, `gate`, `review`, `merge`, `remote`); the wave's state is their fold plus its tasks' states
  and is never stored. Every append holds `waves/<id>.log.lock` from its read of the log to its write, and a stage
  change is a compare-and-append on the stage it leaves (a `waves.add` that came first wins). `waves.timeline` replays it
- A wave never waits silently: whenever it cannot move without the supervisor it rests in a stage or state
  `tasks.wait` reports as attention, and a `stage` event's `detail` says why (a block's cause: the conflicting paths,
  the failing gate, the dirty worktree (named by its wave, never by its path: that is in the runner's log) and the
  files it holds, the error; the tasks that can never start)

#### The supervisor's loop

1. Declare: `waves.start` with every task of the wave and which waits for which (tasks' `after`), the reviewer's
   instructions as `request`; the next wave may be declared at once with `after` naming this one: it stays `queued`
   (`waves.get` shows `waits for:`) and starts by itself once this one is merged
2. Wait: `tasks.wait {wave}` answers when the wave is `merged` or `cancelled` or something needs the supervisor: a
   task's question (`tasks.message` answers it), a blocked task (`tasks.retry`, `tasks.message` or `tasks.cancel`), a
   `rejected`, `blocked`, `waiting_approve` or interrupted wave, a building wave whose pending tasks can never start, a
   queued wave that can never start (a wave it waits for was cancelled). A queued wave that can still start keeps the
   wait going. Then wait again
3. Decide after a rejection: read the findings (`waves.get` shows them), then `waves.add` fix tasks (the wave builds
   again, then is reviewed again) or `waves.cancel`. Nothing moves until then: the factory never creates fix tasks.
   After `blocked`: read why (`waves.get`: the last `stage` event's `detail` as `why:`), fix the cause, then
   `waves.retry` (or `waves.add`); `waiting_approve`: `waves.approve`; tasks that can never start: `waves.add`
   replacements or `waves.cancel`; a queued wave that can never start: `waves.cancel` (or `waves.remove`) it and
   declare it again

### The wave runner (`src/wave-runner.ts`, `src/wave-poke.ts`)

- `bun wave-runner.ts <wave id>`: a detached process like a task's runner (`spawn.ts`), one per wave: it holds the
  wave's lock `waves/<id>.lock` for its life, logs to `waves/<id>.log` and lives while the wave does not rest
  (`running`; a wave not resting without one is `interrupted`). No Pi session: it calls the pure steps (`git.ts`,
  `rebaseWorktree`, `mergeTask`, `runReview`, the merge queue) with its own commands
- Poked by `waves.start`, `waves.add`, `waves.retry`, `waves.approve`, by the runner of a wave that merged (every queued wave naming it) and by a wave's task whose runner ends with the task at rest (`FACTORY_TASK_WAVE`
  is set on the runners of a wave's tasks). A poke writes `waves/<id>.poke` and starts a runner unless a live one holds
  the lock: that one sees the marker and looks again before it ends, a second runner never starts
- `queued`: no runner drives it. Poked (by the merge of a wave it names, `waves.add`), its runner starts it when every
  wave it names is `merged`, else rests; one of them cancelled: it records why once (`stage` event, still `queued`)
- `building`: starts the tasks whose `after` are all `done` (target = the wave branch); a blocked task holds the wave
  here. Once every task is `done` or `cancelled`: `reviewing` (all cancelled: `cancelled`). A task that fails to
  launch blocks the wave (`infra`, the error in the `stage` event). Tasks that can never start while no started task
  is active: the runner records why (one `stage` event, still `building`) and rests. A record of the wave that no
  `task` event names (a runner died between a launch and its event) is adopted, never launched twice
- `reviewing`: a worktree on the wave's branch (`hooks.after_create` run when it is made), the rebase onto the target
  without squashing (every commit of the wave survives), the `merge_gates` (the full suite, once per wave; a failure
  blocks it before any reviewer starts), then the reviewer on the whole diff since the
  target, with the wave's `request` verbatim in its prompt under its own heading. Approved: `merging`, or
  `waiting_approve` with the wave's `merge: review`; rejected: `rejected` (findings in `reviews`); nothing differs from
  the target: `merged` without a review. `factory.yaml` and the reviewer prompt come from the target's tip
- `merging`: the normal merge queue (`merge_gates` only when the target moved since the review's run, fast-forward of
  the target); `merge` records the commit range and the queue wait
- The reviewer has no time limit, a wave's and a task's alike: it runs until it answers or is cancelled
  (`waves.cancel`, `tasks.cancel`). `timeout`, a status of older review entries, still reads
- A rebase conflict, failed gates (`gates`; exit 75: `infra`), a dirty worktree (`dirty`), a failed reviewer
  (`review_failed`) or anything else (`infra`) ends it `blocked` with that `reason`, and nothing is deleted
- The gates and the reviewer see exactly the committed tree that reaches the target: before the rebase, after it (the
  target's .gitignore may stop ignoring a file) and before the merge, a changed tracked file or an untracked file that
  is not ignored ends it `blocked` `dirty` and is left as it is. After the gates and the merge gates, passed or
  failed, a changed tracked file ends it `blocked` `dirty` too, and the untracked files they left are deleted
  (`git clean -fd`). Ignored files never count and are never deleted
- Every step appends its event (`stage`, `gate`, `review` with the reviewer's session id, model, findings, usage and
  wall time, `merge`). The review worktree is removed when the wave leaves review and merge (unless it is dirty: then
  it stays). A runner started on a wave in `reviewing` or `merging` runs that step again from its start
- `waves.get {id}` / `waves.list {repo?, tag?}` (tag: equal or prefix + `/`) answer `WaveView`s: the declaration
  (without `overrides`), `stage`, `detail` (the last `stage` event's why, else null), each task's `state` (`pending`
  before it started) and `usage`, `counts` (`{total, done}`, cancelled tasks in neither), `usage` (tasks plus
  reviews), `reviews`, `gates` (each with `flaky` when a step passed on its rerun), `merge`, `remote`, `running`, `interrupted`, `actions`. `waves.timeline {id, since?}`
  answers `{events, next}` (`since`/`next` count events)

### Files in step (`src/sync.ts`)

- Parallel tasks and waves may edit the same files: a merge reaches the running tasks below its branch at the end of
  their coder turn, not at their own merge
- A task merges into its wave's branch: the wave's other tasks in `running` get a due sync. A wave merges into its
  target: the branch of every other `building` wave on that target is rebased onto it first (no worktree; a conflict
  or a checkout leaves it as it is), then its tasks in `running` get one. Plain tasks are never synced
- At the end of the coder turn, before the gates: the worktree's snapshot, then a three-way merge of the task's whole
  change onto the branch's tip, left uncommitted (untracked files too); the tip is the task's base from then on. Two
  merges before the turn ends make one sync
- The task has read or edited a changed file (its `read`, `edit`, `write` calls, `session-files.ts`): one
  `factory-sync` message to the coder, the changed files with the subjects of their commits, conflicting files first
  with their markers left, and "re-read these". It counts as no round; the gates run at the end of the next turn.
  Markers of that sync still in a file it named then: said once more. Without such a file: no message
- Every sync is a `factory-sync` session entry (`synced` with tip, named and conflicting files; `failed` with the error
  and whether the snapshot was restored; `reminded`; `cleared`). A failure restores HEAD, worktree and index, consumes
  the due syncs and blocks nothing: the task meets the change at its merge
- Marks, branch rebases and syncs hold the merge lock; a running turn, a gate run or a merge is never interrupted

### Gate proofs (`src/gates-prove.ts`)

- `gates.prove {repo, branch?}` (`mutates: true`): runs `merge_gates` of the branch's committed `factory.yaml` on its
  tip, in the background: a detached worktree of the tip, `hooks.after_create`, then every step, a failed one once
  more (as every gate run). Branch: the given one, else the repo's stored branch, else its default; refused without a
  committed `factory.yaml`. Env `FACTORY_BASE` = the empty tree: the whole tree is the change. `origin` is the
  declaring Pi session. Answers `{proof}` at once
- States: `running`, `passed`, `flaky` (a step passed on its rerun; `flaky` holds the failing test names, else the
  command), `failing` (`failing`: the step, `hooks.after_create` for a hook, its output's tail and `log`, the path of
  its full output, a hook's included). `interrupted`: `running` and its runner no longer lives, or noted no pid 10
  seconds after the declaration. The worktree is removed (forced) before the end is recorded; one an interrupted
  proof left by the next `gates.get` of it or `gates.prove` in its repo
- `gates.get {id}`: `{proof: ProofView}` (declaration, `state`, `steps` with `flaky`, `flaky`, `failing`, `endedAt`,
  `running`, `interrupted`). `tasks.wait {ids}` watches a proof; it needs attention `failing` or interrupted
- The declaring Pi session gets one notice when it ends: `passed`, `flaky`, `failing` or `interrupted`

### CLI (`factory`)

```bash
factory --help                                          # one line per action with its summary
factory actions                                         # one line per action: name {params} - summary
factory actions tasks.start                             # one action's params in full
factory actions --json                                  # the ACTIONS map as JSON
factory repos.add                                       # repo = the current directory
factory tasks.start '{"title": "feat: add b", "request": "Add b.txt", "tag": "me/w1"}'
echo '{"tag": "me/w1"}' | factory tasks.wait -           # params from stdin
factory tasks.list --json                               # the full view, for scripts
factory --core-path                                     # absolute path of src/core.ts, for hosts that import it
```

- `factory <action> [<json params> | -] [--json]`: no params means `{}`, `-` reads them from stdin. stdout gets the
  agent view, or with `--json` (anywhere after the action) the full view, `callAction`'s result as JSON; exit 0.
  Scripts that parse the output pass `--json`. `tasks.timeline` and `waves.timeline` always print JSON. `cwd` is the
  caller's directory. `hostOnly` actions are available (the CLI is the host); Ctrl-C aborts a blocking `tasks.wait`
- The CLI is the host's interface: it is not restricted in a task session (`FACTORY_TASK_SESSION=1`), where the
  `factory` tool and the MCP server offer only the actions with `mutates: false`. A coder with a shell and `factory`
  on PATH reaches every action
- A `FactoryError` goes to stderr as `factory: <code>: <message>` (without `--json` followed by ` · next: <the way
  out>`): exit 2 for `invalid` (also bad JSON, an unknown action), exit 1 for the others
- It holds no logic of its own: it parses arguments, calls `callAction` and prints one of the two views

### MCP server (`factory-mcp`)

- stdio, one tool `factory` with the name, description and schema of the Pi tool (both come from
  `src/factory-tool.ts`, so they cannot drift): `{action, ...params}`, `action` an `ACTIONS` name that is neither
  `hostOnly` nor a timeline
- The answer is the agent view as text; a failure is an error result, the agent view's one line
  (`<code>: <message> · next: <the way out>`). Started by a task's runner (`FACTORY_TASK_SESSION=1`) it offers only
  the actions with `mutates: false`
- It names itself (`serverInfo`) with the package's `name` and `version` from `package.json`

### Pi extension (`src/pi/`)

- The `factory` tool for agents: `{action, ...}` with `action` an `ACTIONS` name that is neither `hostOnly` nor a
  timeline, and that action's params. The answer is the agent view as text and the full view as `details`; errors
  are error results, the agent view's one line. Calls run one at a time
- In a task's own session (Pi started by the runner, `FACTORY_TASK_SESSION=1`, or a session holding a `factory-task`
  entry) the tool offers only the actions with `mutates: false`; a mutating one (`tasks.start`, `models.set`, ...)
  answers as unknown. A task's coder starts a task only through `factory_new_task` (below)
- The `scout` tool (Scouts, below)
- In a session that declared waves (their `origin`), the interactive terminal UI shows them above the editor
  (`src/session-widget.ts`): a header with the active count, how many need the supervisor and their cost, then the
  active waves (those that need the supervisor first, then newest first) and a `<n> finished` line.
  `/factory waves` opens or closes the finished ones. The notifier's looks refresh it; RPC, JSON and print mode and
  a task's own session show nothing

Commands (inside a task's own Pi session):

- `/factory init`: write a draft `factory.yaml` into the main checkout (any session), uncommitted
- `/factory start <json>`: `{"request", "title", "settings"}`; what the tool's runner and gigachad-bot send
- `/factory approve`, `/factory retry`, `/factory cancel`
- A plain message to a resting task starts a new run; to a task in `waiting_answer` it is the answer (below)

## Factory models (`models.ts`)

- One user-level list of `provider/model` ids every task and repository picks from, in `<agent dir>/factory/models.yaml`.
  Actions `models.get` (`{models}`) and `models.set` (`{models}`, deduplicated); `/factory models` lists it,
  `/factory models add <id>`, `remove <id>`, `set <id> ...` change it (in the TUI `add` alone offers Pi's models)
- `tasks.start` and `settings.set` are `refused` for a model not on the list, and for anything while it is empty
  ("no factory models are set (set them with /factory models)"). Reading settings and listing tasks never check it

## Tags

- Give related tasks one tag: `tasks.start {..., tag: "plugin/m1/w1"}` (default the system user name), then
  `tasks.list {tag: "plugin/m1"}` lists them and `tasks.wait {tag: "plugin/m1"}` blocks until the tasks and waves
  under it rest or one needs attention. `plan` stores a memory_store path next to the tag; the factory only keeps it
- A wave's tasks merge into a wave branch; its runner then gates that branch into the target all waves flow into

## Questions to the supervisor

- In a task session the coder may call `factory_ask_supervisor {question}` while its task is `running`: it records a
  `factory-question {text}` entry (timeline kind `question`, `TaskView.question`) and the resting state
  `waiting_answer`, and ends the coder's turn. The round's hooks, gates and review do not run; the runner ends. It is
  refused next to another tool call in the same message and while a message is queued for the coder: Pi would carry
  the turn on past either
- The next message (`tasks.message`) is the answer: the coder continues the same round, with no new round, no fresh
  round budget and no squash or rebase of the worktree (the state goes back to `running`, reason `answer`). The
  round's steps run when that turn ends, as for any turn. In `waiting_answer` the actions are `tasks.message` and
  `tasks.cancel`; `tasks.wait` counts the task as needing attention

## Scouts

- `scouts.start {concern, questions?, wait?, store?, repo?}`: a read-only `pi -p` child on the project's small model in
  the caller's working directory (`read`, `grep`, `find`, `ls`, `map_write`). It answers from `map/` of the memory store
  (the task's or wave's `plan`, else `store`; none: `refused`), explores where the map is not current, writes there and
  reports `MISSING` / `DECISIONS` / `KEY FACTS` / `MEMORY`. At most four of a caller run, more queue. A scout starts no
  scout. `scouts.get {id}`, `scouts.list {repo?, caller?}`
- The Pi tool `scout` (same params) in supervisor sessions and coders, never in a scout's child. `wait: true` returns the
  report, after 15 minutes at the latest with what it wrote so far; `wait: false` returns its id at once
- A coder's report arrives as a `factory-scout` message: its turn does not end (`agent_before_settle`) before its
  scouts reported, the round's steps run at the end of the turn after the reports
- A supervisor's report arrives as a factory report (`factory-notice`): the report's text and file path. Each scout
  reports once: a waited call and the notifier claim the same key in `notified.jsonl`. The `factory` tool's
  `scouts.start` takes the same path

## How a task runs

- `tasks.start` makes the worktree, runs `after_create` and spawns the runner, which starts `pi --mode rpc` in the
  worktree with `/factory start`. The extension records the task and its rounds as `factory-*` session entries: the
  coder's turn, `after_code`, the gates, the review; a failure goes back to the coder until `maxRounds`, then the
  task blocks. A passed round is squashed into one commit, rebased onto the target and joins the merge queue (`merge_gates`, fast-forward), or
  waits in `waiting_approve` with `merge: review`
- `tasks.approve`, `retry` and `cancel` each start a runner for one command, as does `message` to a task no runner
  holds (a live runner gets it through the task's inbox); a runner ends when the task rests again

### The runner

- `bun src/runner.ts <worktree> <sessionDir> <sessionId> <inboxPath> <message>` spawns `pi --mode rpc` in the worktree, sends one
  command and closes Pi's stdin once no agent run is active and the task rests (for `approve`/`retry`: after it
  has left the state it started in). Detached, one runner per command. A prompt Pi did not handle as a command (the
  extension is not installed in Pi) makes it abort and exit 1; extension dialogs are answered as cancelled

### Commit message

- A task title that is a conventional commit title (`type(scope)!: summary`) is the merge commit's message. Else,
  after the last round passed and before the merge, the coder is asked for one: a conventional title of at most 72
  characters, a blank line, `- ` bullets (at most 50 lines, 4096 characters, no control characters). An invalid
  answer falls back to the task title. The message is the `factory-commit-message` entry and goes into the
  `factory-merge-intent` entry, so a later runner's approve uses it

### Follow-up on a merged task

- A message to a task that is `done`/`merged` opens a follow-up run: the coder works in the task's worktree (made
  again from the task branch when it is gone). Once the gates pass, the change merges as a normal new commit through
  the usual merge, with its own commit message (the coder is always asked for it in a follow-up). No history is
  rewritten
- A part of the request outside the task's scope goes to a new task: the coder calls `factory_new_task {title,
  handoff}` (title a conventional commit title, handoff the complete request). The tool exists in task sessions only,
  works only in a follow-up run on a merged task, once per user message; the new task takes over this task's target
  branch and merge mode, and the parent records a `factory-spawn` entry (timeline kind `spawn`)

## Where state lives (`<agent dir>/factory/`, agent dir = `PI_CODING_AGENT_DIR` or `~/.pi/agent`)

- `tasks/<id>.json`: the task record (repo, worktree, branch, title, session id and dir, tag, plan, wave; a record
  without the last three reads as the system user's, no plan, no wave; an older record's `kind` is ignored); `tasks/<id>.log`: runner
  output; `tasks/<id>.lock`: `<pid> <start time>` of whoever acts on the task (a dead holder's lock is taken over); `tasks/<id>.inbox`:
  messages for the live runner (`<inbox>.read`: how far it sent them)
- `sessions/<repo dir name>/` (`/a/b` -> `--a-b--`): the Pi session files of a repository's tasks, apart from
  Pi's own sessions (`pi -r` does not list them). The task's truth is its `factory-*` session entries
- `repos/<URI-encoded path>.yaml` (`/a/b` -> `%2Fa%2Fb.yaml`): per-repo settings (`merge`, `maxRounds`, `review`, `branch`, `models` (`coder` with its alias `big`, `reviewer`, `small`), `preview`, `remote`); the file registers the repo
- `models.yaml`: the factory models, a YAML list of `provider/model` ids
- `waves/<id>.jsonl`: a wave, append-only: line 1 its declaration, every later line one event; `waves/<id>.lock` its
  runner's lock, `.log.lock` the append lock, `.poke` an unseen poke, `.log` the runner's output, `.reviews/` its reviewer's
  sessions and patch files
- `sync/<task id>.jsonl`: a task's due syncs, append-only (`due` lines, `done` lines consume them). The worktree before
  its last sync: the ref `refs/factory/sync/<task id>` in the repo
- `scouts/<caller kind>-<caller id>/<id>/`: a scout (`scout.json`, `events.jsonl`, `report.md`, `written.jsonl`)
- `proofs/<id>.jsonl`: a gate proof, append-only, written by its runner: line 1 its declaration, then one `step` per
  gate step and one `end`; `.pid` its runner (pid and start time, written by `gates.prove` and by the runner itself), `.log` the runner's output, `.failing.log` the
  output of the step that failed
- Reviews: `<agent dir>/factory-reviews/<session id>/`. Merge lock and queue: in the repo's git common dir

## Entry protocol

- Version 2 (`PROTOCOL_VERSION` in `state.ts`, written into every `factory-task` entry). Entries: `factory-task`,
  `-round`, `-gate`, `-review`, `-merge-intent`, `-merge`, `-state`, `-commit-message`, `-spawn`, `-question`, and
  `factory-feedback` and `factory-commit-ask` messages

## Suggested system prompt

```text
You can hand coding tasks to the factory (the `factory` tool or the `factory` CLI).
- Give each task a self-contained request and a conventional commit title; group a wave under one tag.
- Start with tasks.start, then block on tasks.wait (ids, tag or wave) instead of polling tasks.get.
- When a task needs attention, read tasks.get (its question, failure, findings or last message): answer a question
  with tasks.message, approve, retry or cancel as its next: line allows.
- Declare a planned set of tasks as a wave (waves.start) and wait on it (tasks.wait {wave}); its runner reviews and
  merges it, never merge it yourself. After a rejection add fix tasks (waves.add) or cancel it (waves.cancel).
```

## Development

- `bun run types`, `bun test`. Tests use temp git repos, a temp agent dir and a fake `pi`; no model is called
- Layout: `src/` the core and what it imports (Bun and `node:` only, loadable without `node_modules`), `src/pi/`
  everything that imports Pi's extension API, `src/cli.ts` and `src/mcp.ts` the binaries, tests beside their modules
- State on disk, the entry protocol and the runner command line are a contract with tasks already running: change
  them only with a migration
