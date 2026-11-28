# agent-factory

Background coding work for agents. A **task** is one request in its own git worktree and branch: a coder agent (Pi)
works on it in rounds, the repository's gates check every round, and a passed round lands on the target branch. A
**wave** is a planned set of tasks on one branch of its own: each task is reviewed, then how they fit together, and the
wave lands on its target as a whole. Agents and hosts reach the factory through one core (`src/core.ts`): the Pi
extension, a CLI (`factory`) and an MCP server (`factory-mcp`). State is plain files; there is no daemon.

The views (what agents read, what people see): `VIEWS.md`. Every action's parameters and contract: `factory actions`.

## Concepts

| Term | Meaning |
|---|---|
| **task** | One request, one worktree, one branch, run by a detached runner that drives `pi --mode rpc` |
| **round** | A coder turn, then the gates and the review; a failed round goes back to the coder, up to `maxRounds` |
| **gates** | The commands of the target's `factory.yaml` that must pass on exactly the tree that lands |
| **wave** | Declared tasks on the branch `<target>-<tag with / as ->`, started in the order of their `after`, then reviewed and merged by the wave's runner |
| **tag** | Path segments (`plugin/m1/w1`) grouping tasks and waves; filters match the tag or its prefix + `/` |
| **plan** | A memory-store store a wave works by: its contracts, its map for scouts, its feedback and the wave's home |
| **contract** | Facts the tasks of a wave work by (`<plan>/run/contract/<name>/<fact>` or `<plan>/run/contract/<name>.md`); only the supervisor changes them (`contracts.apply`), the factory tells the affected tasks |
| **scout** | A read-only `pi` child that answers a concern from the plan's `map/` and writes what it learns there |
| **rest** | No runner lives and the task waits (`waiting_approve`, `waiting_answer`, `blocked`), ended (`done`, `cancelled`) or was interrupted |
| **attention** | A rest that needs the supervisor: a question, a block, a rejection, waiting for approve, an interruption, tasks that can never start |
| **origin** | The Pi session that started a task or declared a wave: its notices go there |
| **card** | The readable form of an event, for people (`VIEWS.md`) |

Invariants every step keeps:

- Nothing reaches a target but a commit rebased onto it that passed the gates on exactly that tree; a target only
  fast-forwards. A wave's gates and reviewer see only the committed tree: a dirty worktree blocks it (`dirty`)
- Whoever approves a change did not write it: the reviewer judges and may add `fix:` tasks, it never edits
- A wave never waits silently: whatever needs the supervisor is a resting stage with a `detail` that says why
- Every notice reaches its origin once, also across restarts (`notified.jsonl`)

## How a task runs

1. `tasks.start` makes the worktree (`agent-worktree` when it is on PATH, else `git worktree add` into
   `<repo>/../worktrees/<repo name>/<task>`), runs `hooks.after_create` there and spawns the runner (`src/runner.ts`)
2. The runner starts `pi --mode rpc` in the worktree with `/factory start`; the extension (`src/pi/index.ts`) records
   the task and every step as `factory-*` session entries: the task's truth
3. After each coder turn: `gates`, the protected-path check and, with `review` on, the reviewer. A problem goes back
   to the coder as the next round; out of rounds the task is `blocked`
4. A passed round is squashed into one commit (its message: a conventional title, else one the coder is asked for),
   rebased onto the target and merged through the merge queue (`merge_gates`, fast-forward), or waits in
   `waiting_approve` with `merge: review`
5. The runner ends when the task rests. `tasks.approve`, `tasks.retry`, `tasks.cancel` and `tasks.message` to a
   resting task start a runner for one command; a live runner gets `tasks.message` through the task's inbox
6. A coder may ask the supervisor (`factory_ask_supervisor`): the task rests `waiting_answer`, and the next
   `tasks.message` is the answer within the same round. A `done` task takes no message: more work goes to its wave
   (`waves.add`) or a new task

## How a wave runs

1. `waves.start {repo, tag, title, request, tasks, after?, plan?, contracts?, overrides?}` cuts the wave's branch off
   the target and pokes the wave's runner (`src/wave-runner.ts`), one process per wave, no Pi session. With `after`
   naming other waves it is `queued` and starts by itself once they are `merged`
2. `building`: the runner starts every task whose `after` are `done`; each merges into the wave's branch (`gates`,
   then `task_gates`). Every task's passed round is judged by the wave's reviewer first (one resumed session per
   wave): blocker and major findings start the task's next round, minor ones are only kept
3. `reviewing`, once every task is `done` or `cancelled`: a review worktree on the wave's branch, the rebase onto the
   target (every commit kept), `merge_gates` once, then the reviewer on how the tasks fit. Its findings become a `fix:`
   task (the wave builds again); with no fix left (at most three per wave), the wave is `rejected`
4. `merging` (after `waves.approve` with `merge: review`): the merge queue fast-forwards the target, `merge_gates`
   again only when the target moved. With the repository setting `squash` the wave lands as one commit, its task
   commits kept under `refs/factory/waves/<tag>-<id 8>`
5. A rebase conflict adds a task `fix: resolve the conflict ...` (at most two per wave); anything else that stops it
   rests `blocked` with a `reason` (`conflict`, `gates`, `dirty`, `infra`, `review_failed`) and nothing is deleted

The supervisor's loop:

1. Declare the whole plan: `waves.start` per wave, later waves with `after`; settle shared interfaces in contracts
2. Wait: `tasks.wait {wave}` (or `{tag}`) answers when everything rests or one needs attention; in Pi the notices
   arrive by themselves
3. Decide, from the view's `next:` line: answer a question (`tasks.message`), add tasks (`waves.add`), correct the
   plan (`tasks.update`, `waves.update`, `contracts.apply`), `tasks.retry`/`waves.retry` after fixing a cause,
   `waves.approve`, or cancel. Each such action is recorded as a decision (`decisions.list`). Then wait again

## The outside contract

- **Core**: `import { ACTIONS, callAction } from "agent-factory"` (`src/core.ts`). `ACTIONS` maps each name to
  `{summary, params (JSON schema), mutates}`; `callAction(name, params, {cwd?, signal?, env?, origin?})` takes and
  returns plain JSON. A failure throws `FactoryError(code, message)`, `code` one of `invalid`, `not_found`, `busy`,
  `refused`, `failed`. `env` is the environment of every runner the action starts (a host passes one without its
  secrets); `origin` is the calling Pi session. A `repo` param is a path inside the repository, relative to `cwd`; an
  `id` may be a unique prefix. The core imports only Bun and `node:`
- **Actions**: one module per feature (`src/feature-<name>.ts`) registers its actions, views, cards and notices;
  `src/features.ts` lists the features. `factory actions` prints them, `factory actions <name>` one in full
- **CLI** (`src/cli.ts`): `factory <action> [<json params> | -] [--json]`. stdout gets the agent's text, with `--json`
  the full view; an error goes to stderr as `factory: <code>: <message>`, exit 2 for `invalid`, else 1. Also
  `factory actions [<name>] [--json]`, `factory --help`, `factory --core-path` (the path of `src/core.ts`) and
  `factory slot -- <command...>` (runs a command holding a test slot)
- **MCP** (`src/mcp.ts`): stdio, one tool `factory` with the Pi tool's name, description and schema
  (`src/factory-tool.ts`), `{action, ...params}`; the answer is the agent's text
- **Pi extension** (`src/pi/`): the tools `factory` (answer: the agent's text, `details {result, card}`), `scout`,
  and in task sessions `feedback` and `factory_ask_supervisor`. In a task's own session the
  `factory` tool (and the MCP server a runner starts) offers only the actions with `mutates: false`. Notices arrive
  in the origin session as `factory-notice` messages with `details {key, card}`. Commands: `/factory init` (a draft
  `factory.yaml`), `/factory models [add|remove|set ...]`, `/factory waves` (the widget's finished waves), and in a
  task's session `/factory start|approve|retry|cancel`
- **Session entries** a task's Pi session holds (`src/state.ts`): `factory-task`, `-round`, `-gate`, `-review`,
  `-merge-intent`, `-merge`, `-state`, `-commit-message`, `-question`
- **Settings** (`settings.get`/`settings.set`, the table `SETTINGS` in `src/settings.ts`): `branch`, `merge`
  (`auto` | `review`), `maxRounds`, `review`, `models` (`big`, `small`, `reviewer`), `preview` (stored for clients),
  `squash`, `extensions` (a coder's Pi loads only the factory's plugin and the listed sources, no skills, prompt templates or themes; MCP, codemode and tool search only as `builtin:<name>`). Tasks and waves take some as `overrides`. A model must be on the factory models list
  (`models.get`/`models.set`); `defaults.yaml` names the default `small` and `big`
- **Environment**: `PI_CODING_AGENT_DIR` (the agent dir, default `~/.pi/agent`), `MEMORY_STORE_ROOT` (default
  `~/.pi/memory_store`), `FACTORY_SLOTS` (test slots, default cores / 4), `FACTORY_TEST_JOBS`

## `factory.yaml`

Read from a commit of the target branch, never from the coder's tree. Example: `src/factory.template.yaml`.

| Key | What |
|---|---|
| `hooks.after_create` | argv lists run in every worktree the factory makes (install packages here) |
| `hooks.after_merge` | run in the main checkout after a merge that changed a lockfile |
| `gates` | fast checks, after every coder turn |
| `task_gates` | the tests a wave's task reaches, at its merge into the wave's branch; env `FACTORY_BASE` = the commit its change sits on |
| `merge_gates` | the full suite before a merge into the target (default: `gates`); `gates.prove` runs them on a branch |
| `protected` | globs the coder must not change (default `factory.yaml`, `.factory/**`) |
| `preview` | read by clients only |

A gate step that exits 0 passes, 75 means a broken environment (the task blocks), anything else fails. A failed step
runs once more; passing then it is recorded `flaky`. A step that reruns its own failures ends its output with
`gate-reruns: {"flaky": [...], "reran": [...]}` and is not run again. `scripts/changed-tests.ts` is such a step: it
runs the test files a change reaches (`--all`: every one). Every gate runs holding one of the machine's test slots
(`src/test-slots.ts`). Role prompts: `.factory/agents/coder.md`, `.factory/agents/reviewer.md`.

## Install

```bash
git clone https://github.com/patrickab/agent-factory
cd agent-factory
bun install
bun link                           # factory and factory-mcp on PATH (bun's global bin dir)
pi install "$PWD"                  # Pi loads the extension from this clone
pi mcp add factory -- factory-mcp  # only for a harness that wants the MCP tool
```

- One copy: the CLI, the MCP server, the runners and the Pi extension all run from the clone. Update with `git pull`
- On PATH: `pi`, `git`, `bun`, `sh`, `awk`, `flock`, `sleep`; optional `agent-worktree`, `systemd-run` (each runner in
  a user scope of its own), `memory-store` (contracts, scouts, feedback)
- Linux only (`flock`, `/proc`)
- The target branch must hold a committed `factory.yaml` (`/factory init` drafts one). Set the factory models first:
  `factory models.set '{"models":["provider/model"]}'`
- Other MCP clients: `{"mcpServers": {"factory": {"command": "factory-mcp"}}}`; tasks still run in Pi
- Optional read-only terminal view: `uv tool install ./tui`, then `factory-tui`

## Where state lives

Under `<agent dir>/factory/`:

- `tasks/<id>.json` the record, `.log` the runner's output, `.lock` whoever acts on the task, `.inbox` messages for
  the live runner; `sessions/` the Pi sessions of tasks outside a wave
- `waves/<id>`: a link to the wave's home, `<plan store>/run/waves/<tag>/<id 8>/` (else `homes/<tag>/<id 8>/`),
  which holds `wave.jsonl` (declaration, then one event per line), `reviews/` and `sessions/`; `waves.remove` leaves
  it. Next to the link: `.lock`, `.log.lock`, `.poke`, `.log`
- `repos/<URI-encoded path>.yaml`: a repository's settings, its registration; `models.yaml`: the factory models
- `scouts/`, `proofs/`, `decisions/<origin>.jsonl`, `notified.jsonl`, `slots/`, `cache/sessions/` (only a cache)
- The reviews of tasks outside a wave: `<agent dir>/factory-reviews/`. The merge lock: in the repository's git dir

## Development

- Gates: `bun run types`, `bun scripts/changed-tests.ts` (`--all`); one file: `env bun test <file>`
- `src/` the core (Bun and `node:` only), `src/pi/` what imports Pi's API, tests beside their modules

## Troubleshooting

- A restart of a service that hosts the declaring Pi interrupts the runners it spawned when its stop signals its
  whole process tree: a runner stays the child of the Pi that spawned it, its own systemd scope does not shield it
  from a signal by pid. Signal only pids in the service's own cgroup (or `KillMode=control-group`); `waves.retry`
  and `tasks.retry` resume what was interrupted
