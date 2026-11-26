# Plan: simplify the factory

A core-behaviour preserving simplification. The features do not justify the size: 80 source files, 17,800 lines
(930 KB), and 61 test files, 14,500 lines (880 KB). Target: about half the source, well under half the tests. The
target is a hypothesis until the audit confirms it.

Status: agreed in outline with the user, nothing started. Open points at the end.

## What stays, what goes

- **Stays** (it prevented or caught real problems in three rounds): waves and tasks in worktrees with one commit per
  task · gates after every turn and on the rebased tree · the reviewer, per task and for the fit · contracts with
  deterministic notification · a coder's question to the supervisor · the conflict task · test slots · squash landing
  with the task commits under a ref · notices and cards · scouts
- **Stays because someone uses it**: the Python TUI (`tui/`, the user inspects runs with it) · previews and the
  approval gates (`merge: review`, `tasks.approve`, `waves.approve`): gigachad-bot uses both
- **Purged**: every compatibility with old logs and records, and the old records themselves · `tasks.import` · the
  "merge request" task kind (a wave's merge is the runner's step, a conflict a conflict task)
- **Decided**: the archive becomes one home (a wave's log and sessions live under the plan's store from the start, a
  removal leaves them; no copy, no index, no second view path)

## Where the size is believed to be (to verify or refute in the audit)

| Area | Now (source + tests) | The simplifying move | Saves, estimate |
|---|---|---|---|
| Two renderings of everything (`agent-view.ts`, `cards.ts`, `pi/cards-tui.ts`, `view-fixtures.ts`) | 2,400 | one view model, the agent text derived from it | 1,000 |
| Hand-written parsing and old shapes (`waves.ts`, `state.ts`, `core-tasks.ts`) | 2,300 | the factory reads only what it wrote | 800 |
| A setting listed in eight places (`settings.ts`, `core-settings.ts`, `feature-settings.ts`, `feature.ts`, ...) | 900 | one table the parser, the views and the tool schema read | 500 |
| Files in step (`sync.ts`) | 990 | only "rebase a wave's branch when the target moves"; the conflict task covers the rest | 700 |
| Additions-only merge (`additions-merge.ts`) | 375 | delete; a conflict task on the small model does it | 375 |
| The archive as a copy (`archive.ts`, the archived view in `core-waves.ts`) | 650 | one home | 550 |
| Reviewer context editing (`review-session.ts`) | 270 | a fresh session per review, earlier findings as text | 270 |
| Gate proofs as their own state machine (`gates-prove.ts`) | 610 | a thin command that runs the gates once in a worktree | 400 |
| Forge fallbacks (`remote.ts`) | 370 | two cases: merged on the forge, or landed locally | 150 |
| `core-waves.ts`, `wave-runner.ts`, `core-tasks.ts` | 5,500 | split by stage, shared helpers | 1,500 |
| Tests | 14,500 lines | behaviour someone relies on, not a test per clause | 6,000 |
| `README.md`, `VIEWS.md` | 975 long lines | concepts, not a restatement of the code | half |

## What the retros say caused trouble (input for every reviewer)

Store `agent-factory/simplify`, `run/retro-2026-11-26.md`, holds today's retro, the cost per wave and the open minor
findings. The recurring causes over all four retros:

- Contracts that list cases instead of invariants: every clause became code and tests (the archive as a copy, the
  forge fallbacks, "old names still read")
- Parallel work in the few files everything hooks into (`core-waves.ts`, `wave-runner.ts`, `notify.ts`, `core-tasks.ts`)
- A value added in one place and missing from the lists that enumerate it (a task state in the sync, a tone on the
  notice): enumerations spread over many files
- Tests that test their own stand-in, tests by call order, tests reaching real processes, fixed ids shared between tests
- Two forms of everything kept in step by hand (agent text and card, README and VIEWS and the tool description)
- State with two homes (a record and a session, a log and an archive, a module cached by a host)

## Steps

### 1. Audit: six read-only review agents on the big model, in parallel, no code changes

Each applies the skill `thermo-nuclear-code-quality-review` (`~/.agents/skills/thermo-nuclear-code-quality-review/SKILL.md`)
to its area, gets this plan and the retro, and writes `~/git/worktrees/agent-factory/audit/<n>-<area>.md`: a ranked
cut list, each entry with what, `file:line`, the simplifying move, lines before and after, the risk, and what it must
come after. A proposal to remove a feature (not code) is marked as such.

| # | Area | Files |
|---|---|---|
| 1 | The wave path | `core-waves.ts`, `waves.ts`, `wave-runner.ts`, `wave-poke.ts`, `core-plan.ts`, `core-wait.ts`, `queue.ts` |
| 2 | The task path | `core-tasks.ts`, `tasks.ts`, `launch.ts`, `runner.ts`, `ops.ts`, `pipeline.ts`, `merge.ts`, `git.ts`, `draft.ts`, `state.ts`, `spawn.ts`, `run.ts`, `commitmsg.ts`, `review.ts`, `review-each.ts`, `review-session.ts`, `review-diff.ts` |
| 3 | Views and surfaces | `agent-view.ts`, `cards.ts`, `view-fixtures.ts`, `feature*.ts`, `features.ts`, `core.ts`, `factory-tool.ts`, `cli.ts`, `mcp.ts`, `notify.ts`, `notified.ts`, `decisions.ts`, `session-widget.ts`, `src/pi/*`, `README.md`, `VIEWS.md` |
| 4 | Side features | `sync.ts`, `additions-merge.ts`, `archive.ts`, `remote.ts`, `gates-prove.ts`, `flaky-rerun.ts`, `test-slots.ts`, `scouts.ts`, `scout-*.ts`, `core-scouts.ts`, `contracts.ts`, `core-contracts.ts`, `feedback.ts`, `settings.ts`, `core-settings.ts`, `config.ts`, `models.ts` |
| 5 | The outside contract | what gigachad-bot (`src/lib/factory*.py`, `pi-host/src/factory.ts`, `src/frontend/features/factory/`, `features/pi/SessionWaves.tsx`, `factoryCard`) and `tui/` call and read: the actions and fields that are "core behaviour", and the ones nobody reads |
| 6 | Tests | every `*.test.ts`, the kits (`core-test-kit.ts`, `test-case.ts`, `fake-memory-store.ts`, `test-preload.ts`): what to purge, what a small suite that guards the core looks like, and four or five rules for writing tests that add value |

### 2. One plan from the six reports

The supervisor merges them, reads the cited lines for every cut it accepts, orders them, and shows the user the
result before any wave is declared, with every feature removal flagged.

### 3. Sequential waves, one area each

- A restructure cannot run in parallel on the same files: one wave at a time, each on the tip the last one left
- Purges first (old shapes and records, `tasks.import`, the merge request kind, what the audit shows nobody reads),
  so later waves restructure less code
- Tests are deleted with the code they cover, in the same wave. A test that pins behaviour nobody relies on is
  deleted, not adapted
- Every wave: the suite passes, the source is smaller than before, gigachad-bot and the TUI still work against it
  (the outside contract of report 5 is the check)
- Declared through the `factory` tool (never the CLI in a script: no origin, no reports), `reviewEach` on, the
  reviewer told to apply the review skill and to reject a wave that moves complexity around without deleting it
- No line budget in the gates

### 4. Rules that keep it small

- The test rules of report 6 go into `AGENTS.md` and the skill `parallelize-plan`
- `AGENTS.md` already has "Simplicity"; the skill has "simplest solution first" and "design before the contract"

### 5. After the refactor

- Old factory records and logs under `~/.pi/agent/factory/` deleted (allowed by the user)
- The factory repository's old worktrees and branches, and the gigachad-bot branches the cleanup kept
  (`learnharness`, `fix-zem`, three `waves-*`, `perf-frontend-1`, two unmerged worktrees): a reason for each, then removed or kept
- gigachad-bot: whatever the outside contract changed; the cost display reads the one home
- `README.md` and `VIEWS.md` rewritten short; this file deleted

## Open points (the supervisor's defaults, the audit may overrule with evidence)

1. Files in step reduced to "rebase a wave's branch when the target moves" plus the conflict task
2. Reviewer context editing replaced by a fresh session per review with the earlier findings as text (simpler, some
   prompt cache lost)
3. The leftover worktree cleanup happens after the refactor (step 5)

## Working facts

- Live factory: the checkout `~/git/agent-factory` (`master`); work on the branch `autonomous-waves` in
  `~/git/worktrees/agent-factory/autonomous-waves`, merge into `master` only when nothing runs, then restart what
  imports the core (gigachad-bot's dev stack: `systemctl --user restart gigachad-bot-dev`; it no longer ends runners)
- Gates: `bun run types`, `bun scripts/changed-tests.ts` (`--all` for the suite); a single file `env bun test <file>`
- Models: small `anthropic/claude-sonnet-5-5`, big and reviewer `anthropic/claude-opus-5-5`
- `squash` is on for both repositories, `remote` off
- A backup of the purged memory stores: `/tmp/memory_store-before-purge.tgz` (gone at the next reboot)
