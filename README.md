# agent-factory

Background coding tasks for agents. Each task gets its own git worktree and branch; a coder agent (Pi) works on it in
rounds, and after every turn the repo's hooks and gates run, then an optional review, and problems go back to the
coder. A passed round merges into the target branch, or waits for approve. A merge request gates an existing branch
into its target without a coder. Agents and hosts reach the factory through one core (`src/core.ts`): the Pi extension
(the `factory` tool and `/factory` commands), a CLI (`factory`) and an MCP server (`factory-mcp`). State is plain
files under Pi's agent dir; there is no daemon.

## Terms

| Term | Meaning |
|---|---|
| **task** | One request in one worktree on its own branch, run by a detached runner that drives `pi --mode rpc`. |
| **round** | A coder turn, then `after_code`, the gates and the optional review; a failed round goes back to the coder. |
| **gates** | The commands in the target's `factory.yaml` that must pass: `gates` after every turn, `merge_gates` before the merge. |
| **tag** | Path segments (`plugin/m1/w1`) grouping tasks; `tasks.list` and `tasks.wait` filter by a tag or its prefix. |
| **merge request** | A task without a coder: rebase an existing branch, gate it, review it, merge it. |
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

- `hooks.after_create`: argv lists, run once in a new task worktree
- `hooks.after_code`: run after every coder turn, before the gates
- `hooks.after_merge`: run in the main checkout after a merge that changed a lockfile
- `gates`: fast checks after every coder turn. Exit 0 passes, 75 = broken environment (the task blocks), else fails
- `merge_gates`: run in the merge queue on the rebased branch before the fast-forward. Default: `gates`
- `protected`: globs the coder must not change. Default: `factory.yaml`, `.factory/**`
- `lockfiles`: file names that trigger `after_merge` and go last in the review patch. Default:
  `uv.lock`, `package-lock.json`, `bun.lock`, `bun.lockb`
- Role prompts: `.factory/agents/coder.md`, `.factory/agents/reviewer.md`
- See `src/factory.template.yaml` for a commented example

## Interface

### Core (`src/core.ts`)

- `core.ts` is the one module clients import, the package's entry (`import { callAction } from "agent-factory"`): `ACTIONS` (name -> `{summary, params (JSON schema), mutates, hostOnly}`)
  and `callAction(name, params, {cwd?, signal?, env?})`, plain JSON in and out. A failure throws
  `FactoryError(code, message, detail?)`, one sentence, `code` one of `invalid`, `not_found`, `busy`, `refused`,
  `failed`; `detail` is `{force: true}` on a refused `tasks.remove` that `force` would carry out. It imports only Bun
  and `node:`
- `env` is the environment of every runner the action starts (default `process.env`): a host passes one without its
  secrets. Under a systemd service (`INVOCATION_ID`) with `systemd-run` on PATH a runner runs in a user scope of its
  own, so restarting the service leaves it running
- Actions: `repos.list|add|remove` (a repo's settings file is its registration; `add` -> `{repo, repos}`),
  `branches.list`, `settings.get|set` (`{stored, resolved, defaults}`; `preview` is a stored boolean only clients
  read), `config.get` (working copy, or a branch's committed `factory.yaml`, a draft when there is none),
  `config.write` (a registered repo; checked, not committed; replaces a file only with `overwrite: true`),
  `tasks.list|get` (a `TaskView`: record fields (`tag`, `plan`, `kind` included), last state with its time, `question`
  (the coder's open question while `waiting_answer`, else null), `running` = a live runner holds it,
  `interrupted`, the task's settings, token and cost usage of coder and reviews, `actions` = the task actions the core
  accepts now), `tasks.timeline` (session entries as `{at, kind, data}`, `since`/`next` = a byte cursor, read from
  `since` on), `tasks.diff` (base, patch, per-file added/removed lines), `tasks.start|approve|retry|cancel|remove|message`,
  `tasks.wait`
- `tasks.list {repo?, tag?}`: `tag` keeps the tasks whose tag is it or starts with `tag + "/"` (`a` holds `a/b`, not
  `ab`)
- `tasks.wait {ids?, tag?, ignore?, timeoutMs?}` (`mutates: false`): exactly one of `ids` (ids or unique prefixes,
  resolved once) and `tag` (as in `tasks.list`, re-listed on every poll, so tasks started later count); `ignore` leaves
  ids out; `timeoutMs` 1000..3600000, default 600000. A task rests when no runner lives and its state is
  `waiting_approve`, `waiting_answer`, `blocked`, `done` or `cancelled`, or it is interrupted; it needs attention when
  it rests and is not `done`. Answers `{tasks, attention: ids, timedOut}` once every watched task rests, one needs
  attention, the timeout passes or no task is watched; an abort fails it. A poll re-reads a session file only when it
  changed and looks for runners only where that decides the answer
- `tasks.import` (`hostOnly`, `{record}`): registers a task record another store kept; an existing id stays. It refuses
  a record unless `repo` is a primary checkout and `worktree` one of its linked worktrees with `branch` checked out
- A `repo` param is a path inside the repository, relative to the caller's `cwd`, which is also its default; without
  `cwd` it must be absolute. `id` accepts a unique prefix. Each action that checks a task's state and acts on it holds a
  per-task lock from the check on (a runner keeps it until it exits)
- `tasks.start` (`title`, `request`, `overrides`, `tag`, `plan`, `kind`, `source`): `tag` is path segments of
  `[A-Za-z0-9._@+-]` joined by `/` (default the system user name), `plan` a memory_store path the factory only stores,
  `kind` `task` (default) or `merge_request` (below; `source` is for it only). It creates the worktree, runs
  `after_create`, spawns the runner and returns. An abort before the runner is spawned kills the hook and removes the
  worktree and branch
- `tasks.approve` (from `waiting_approve`), `tasks.retry` (from `blocked`, `cancelled` or interrupted), `tasks.cancel`
  (stops a live runner first), `tasks.message` (a live runner gets it as a follow-up through the task's inbox, a
  resting or interrupted task a new runner; to a task in `waiting_answer` it is the answer; refused while merging and
  for a merge request). A line that reaches the inbox after the runner
  closed Pi goes to a successor runner. Cancel or retry of an interrupted task fails when its runner ends before it ran
- `tasks.remove`: deletes the record, log, worktree and the task's own branch (through git) of a task that is not
  running (an interrupted task counts as not running) and not in `waiting_answer`. It refuses a task with commits its target branch lacks or
  uncommitted changes (untracked files count whatever `status.showUntrackedFiles` says); with `force: true` it removes it anyway and names what it dropped. A merge request's source
  branch is never deleted, so its commits count as nothing dropped
- `overrides` and stored settings: `merge` (`auto` | `review`), `maxRounds` (1..20), `review` (bool), `branch`,
  `models.coder`, `models.reviewer` (`provider/model`)

### CLI (`factory`)

```bash
factory --help                                          # one line per action with its summary
factory actions                                         # the ACTIONS map as JSON
factory repos.add                                       # repo = the current directory
factory tasks.start '{"title": "feat: add b", "request": "Add b.txt", "tag": "me/w1"}'
echo '{"tag": "me/w1"}' | factory tasks.wait -           # params from stdin
factory --core-path                                     # absolute path of src/core.ts, for hosts that import it
```

- `factory <action> [<json params> | -]`: no params means `{}`, `-` reads them from stdin. The result goes to stdout
  as JSON, exit 0. `cwd` is the caller's directory. `hostOnly` actions are available (the CLI is the host); Ctrl-C
  aborts a blocking `tasks.wait`
- The CLI is the host's interface: it is not restricted in a task session (`FACTORY_TASK_SESSION=1`), where the
  `factory` tool and the MCP server offer only the actions with `mutates: false`. A coder with a shell and `factory`
  on PATH reaches every action
- A `FactoryError` goes to stderr as `factory: <code>: <message>`: exit 2 for `invalid` (also bad JSON, an unknown
  action), exit 1 for the others
- It holds no logic of its own: it parses arguments and calls `callAction`

### MCP server (`factory-mcp`)

- stdio, one tool `factory` with the name, description and schema of the Pi tool (both come from
  `src/factory-tool.ts`, so they cannot drift): `{action, ...params}`, `action` an `ACTIONS` name that is not
  `hostOnly`
- The answer is the result as JSON text; a failure is an error result `factory: <message>`. Started by a task's
  runner (`FACTORY_TASK_SESSION=1`) it offers only the actions with `mutates: false`
- It names itself (`serverInfo`) with the package's `name` and `version` from `package.json`

### Pi extension (`src/pi/`)

- The `factory` tool for agents: `{action, ...}` with `action` an `ACTIONS` name that is not `hostOnly` and that
  action's params. The answer is the result as JSON text and `details`; errors are error results starting `factory: `.
  Calls run one at a time
- In a task's own session (Pi started by the runner, `FACTORY_TASK_SESSION=1`, or a session holding a `factory-task`
  entry) the tool offers only the actions with `mutates: false`; a mutating one (`tasks.start`, `models.set`, ...)
  answers as unknown. A task's coder starts a task only through `factory_new_task` (below)

Commands (inside a task's own Pi session):

- `/factory init`: write a draft `factory.yaml` into the main checkout (any session), uncommitted
- `/factory start <json>`: `{"request", "title", "settings", "kind"?}`; what the tool's runner and gigachad-bot send
- `/factory approve`, `/factory retry`, `/factory cancel`
- A plain message to a resting task starts a new run; to a task in `waiting_answer` it is the answer (below)

## Factory models (`models.ts`)

- One user-level list of `provider/model` ids every task and repository picks from, in `<agent dir>/factory/models.yaml`.
  Actions `models.get` (`{models}`) and `models.set` (`{models}`, deduplicated); `/factory models` lists it,
  `/factory models add <id>`, `remove <id>`, `set <id> ...` change it (in the TUI `add` alone offers Pi's models)
- `tasks.start` and `settings.set` are `refused` for a model not on the list, and for anything while it is empty
  ("no factory models are set (set them with /factory models)"). Reading settings and listing tasks never check it

## Tags and merge requests

- Give related tasks one tag: `tasks.start {..., tag: "plugin/m1/w1"}` (default the system user name), then
  `tasks.list {tag: "plugin/m1"}` lists them and `tasks.wait {tag: "plugin/m1/w1"}` blocks until the wave rests or one
  task needs attention. `plan` stores a memory_store path next to the tag; the factory only keeps it
- A wave's tasks merge into a wave branch; a merge request then gates that branch into the branch all waves flow into

### Merge requests

- `tasks.start {kind: "merge_request", source, overrides: {branch: <target>}, title, request}` reviews and merges an
  existing branch, the gate between a wave's branch and the branch all waves flow into. `source` must be a local
  branch other than the target, checked out in no worktree; the task's worktree checks it out (`TaskView.branch` is
  `source`). A failed start or `tasks.remove` never deletes it
- No coder turn ever: the branch is rebased onto the target without squashing (its commits survive, the target gets
  every one of them by fast-forward), the `gates` run (not `after_code`), the reviewer reviews the whole diff against
  the target whatever `review` says, with `request` verbatim in its prompt under its own heading as its instructions.
  Approved: the normal merge queue (`merge_gates`, fast-forward), with `merge: review` after `waiting_approve`
- Nothing is ever committed for it: whenever its gates or review run, its worktree holds nothing but the source's
  committed tree, the one the target gets. Before a run (start and retry), before its merge and again after each
  rebase (the target's .gitignore may stop ignoring a file), a changed tracked file or an untracked file that is not
  ignored (whatever `status.showUntrackedFiles` says) ends it `blocked` `dirty` and is left as it is: the factory made the
  worktree clean, so it is somebody's work (commit it to the source or remove it, then retry). After the gates and
  after the merge gates, passed or failed, a changed tracked file ends it `blocked` `dirty` too (the gate must not
  rewrite tracked files, or the source must already hold what it writes), and the untracked files they left are
  deleted (`git clean -fd`), so neither the review, the next gate nor a retry sees them. Ignored files never count
  and are never deleted. `tasks.diff` shows the committed tree against the target, the diff its reviewer saw
- Nothing opens a round: a rejected review ends `blocked` `review_rejected`, a rebase conflict `blocked` `conflict`,
  failed gates or merge gates `blocked` `gates`; findings and gate output stay in the timeline. `tasks.retry` runs it
  again from the rebase. `tasks.message` is refused and not among its actions, and `factory_ask_supervisor` is not
  registered in its session
- A run aborts any rebase in progress in its worktree first: a dead run's, but also a person's half-finished
  resolution of a `conflict`, which a retry discards. Resolve a conflict by rebasing the source branch elsewhere (or
  finish the rebase with `git rebase --continue` before the retry)
- A source branch that holds merge commits (say it merged the target in and resolved a conflict there) loses them in
  the plain rebase, and the conflicts they resolved come back as `blocked` `conflict`: its owner rebases it onto the
  target first
- `factory.yaml` and the reviewer prompt come from the target branch's tip when a run starts (the start and every
  retry), and read again when its merge starts (auto or approve), never from the source: a retry is held to the gates
  the target has gained meanwhile, and the merge to the merge gates of the tip when its merge starts (a target that
  moves during the merge does not change them). The `factory-task` entry
  (timeline kind `task`) carries `kind` and `source` (null for a `task`)

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

- `tasks/<id>.json`: the task record (repo, worktree, branch, title, session id and dir, tag, plan, kind; a record
  without the last three reads as the system user's, no plan, `task`); `tasks/<id>.log`: runner
  output; `tasks/<id>.lock`: `<pid> <start time>` of whoever acts on the task (a dead holder's lock is taken over); `tasks/<id>.inbox`:
  messages for the live runner (`<inbox>.read`: how far it sent them)
- `sessions/<repo dir name>/` (`/a/b` -> `--a-b--`): the Pi session files of a repository's tasks, apart from
  Pi's own sessions (`pi -r` does not list them). The task's truth is its `factory-*` session entries
- `repos/<URI-encoded path>.yaml` (`/a/b` -> `%2Fa%2Fb.yaml`): per-repo settings (`merge`, `maxRounds`, `review`, `branch`, `models`, `preview`); the file registers the repo
- `models.yaml`: the factory models, a YAML list of `provider/model` ids
- Reviews: `<agent dir>/factory-reviews/<session id>/`. Merge lock and queue: in the repo's git common dir

## Entry protocol

- Version 2 (`PROTOCOL_VERSION` in `state.ts`, written into every `factory-task` entry). Entries: `factory-task`,
  `-round`, `-gate`, `-review`, `-merge-intent`, `-merge`, `-state`, `-commit-message`, `-spawn`, `-question`, and
  `factory-feedback` and `factory-commit-ask` messages

## Suggested system prompt

```text
You can hand coding tasks to the factory (the `factory` tool or the `factory` CLI).
- Give each task a self-contained request and a conventional commit title; group a wave under one tag.
- Start with tasks.start, then block on tasks.wait (ids or tag) instead of polling tasks.get.
- When a task needs attention, read tasks.get and tasks.timeline: answer a question with tasks.message, approve,
  retry or cancel as its actions allow.
- Gate a finished wave branch into its target with a merge_request task, not by merging it yourself.
```

## Development

- `bun run types`, `bun test`. Tests use temp git repos, a temp agent dir and a fake `pi`; no model is called
- Layout: `src/` the core and what it imports (Bun and `node:` only, loadable without `node_modules`), `src/pi/`
  everything that imports Pi's extension API, `src/cli.ts` and `src/mcp.ts` the binaries, tests beside their modules
- State on disk, the entry protocol and the runner command line are a contract with tasks already running: change
  them only with a migration
