# agent-factory

What the factory is and how it works: `README.md`. Its views: `VIEWS.md`. Open work: `backlog.md`. This file holds the rules that every change keeps.

## Design rules

### Two readers, two forms
- **For agents**: everything the factory puts into a model's context (tool results, notices, follow-ups, prefixes) is
  written for an agent: short text, the state, what matters in it, `next:` with the actions valid now. No decoration
- **For people**: everything a user sees (Pi's TUI, gigachad-bot, `factory-tui`) is rendered for reading, from the
  structured data of the same event, never by parsing the agent's text
- One view model per event kind, one renderer per surface. The surfaces show the same cards with the same content
- The readable form is the default. A switch shows exactly what the agent has in context
- Every factory event carries the factory's icon, whether it is a tool call or a notice
- A timeline shows events in the order they happened. Nothing is regrouped
- Events that need a ruling (a question, a rejection, a block) stand out; information (merged, retried, synced) is quiet
- Whatever of a run reaches the supervisor's context is traceable for the user: the supervisor's answers and
  decisions are events like every other

### Safety
- Nothing reaches a branch but one commit that was rebased onto its target and passed the gates on exactly that tree.
  A target only fast-forwards. No feature weakens this, and none adds a second way in
- Whoever approves a change did not write it: the reviewer judges and may start `fix:` tasks, it never edits
- Delivery is exactly once per event, also across restarts
- A step that changes a worktree is all or nothing: snapshot first, restore on any failure
- Never merge text with git's `union` driver: it keeps both versions of changed lines

### Determinism over memory
- What can be known from state is done by the factory, not asked of an agent: who is affected by a contract change,
  which files a task has read, when a wave may start, which decisions were taken
- Feedback, questions to the supervisor and notes to it are tools. No agent needs a shell command or a rule it must
  remember to take part

### Parallel work
- Tasks and waves run in parallel by default, also on the same files. Order comes only from `after`
- Shared interfaces are settled in contracts before work starts; contracts are edited by the supervisor only, and the
  factory tells every affected running task the changed fact
- A plan is declared whole and stays correctable (`tasks.update`, `waves.update`, `waves.add`, `contracts.apply`)
- New features register themselves from their own module. A shared table that every feature edits is a conflict
  between every pair of parallel waves
- Docs are written once per wave by one task, from the code as built

### Autonomy
- A run never stops for the user. The supervisor decides, records each decision, and reports them at the end
- A second rejection on one topic becomes a rule in the contract, not another patch

### Cost
- Every agent's cost is stored with who caused it. Views show one sum; the split stays in the data
- A reviewer's context holds no diff of an earlier round
- Test runs share the machine: no gate may start processes outside the shared limit

## Simplicity

- Always the simplest and most maintainable solution: little code, easy to follow, one home for each piece of data and one path to read it. A feature that adds a second path beside an existing one, or a copy of data that already lives somewhere, is designed again first
- A fallback exists only for a failure that really happens
- The codebase must stay small enough to keep in one's head: a change that removes code is as welcome as one that adds a feature
- Before writing a helper, grep for its twin in the codebase (`util.ts` reads and writes the factory's files), Bun and the packages Pi provides: a second copy of a mechanism drifts from the first
- Trust what the factory produced: a schema is checked once, where it is owned; no re-validation, no field-by-field copy, no `?? zero` for a value never null: each extra check is one more rule to keep in step
- No knob, parameter, interface or export without a caller that sets it, and a test is not that caller: each is a path every reader follows and nobody runs
- Throw the error the caller needs where the fact is known: a wrapper that only re-codes an error is one more hop to read
- A function with one caller is inlined unless it names a real concept: a layer of one call only hides the code
- A comment says what the code cannot (a reason, an invariant, a trap): a header of at most about 8 lines, no doc that repeats the name or signature, no history, since a comment that retells the code goes stale with it

## Tests

Tests are code every later change pays for. Write few, and only ones that would catch a real break.

1. Test what someone relies on, through the surface they use: the state they read, the commit that lands. A test of
   an internal shape or a call order breaks on every refactor and never on a real regression
2. Fake only the boundary you do not own (the model, the network, a CLI), and never write a fake of your own code. A
   test against your own stand-in only proves that you agree with yourself
3. One fact, one test, at the lowest layer that can show it; a table for its cases, not a test per clause. The same
   rule tested at five layers makes every change of it cost five rewrites
4. Never assert wording, the order of logs or argv. Assert the state, and that a secret or path is absent. Wording is
   meant to change
5. Each test owns its world (its dir, its ids, its processes) and waits on events, not on time. Shared globals and
   sleeps collide in parallel runs and flake under load

When a feature or its compatibility path is deleted, its tests go in the same change. A test that pins behaviour
nobody relies on is deleted, not adapted. The kits fake `pi`, git remotes, `memory-store` and time; no test reaches a
model or the network.

## Working on this repository
- The `factory` command on this machine runs from the checkout `~/git/agent-factory`. Work in a worktree on a
  development branch; merge into the default branch only while no wave of any repository is running
- A new feature is one module (`src/feature-<name>.ts`) and one line in `src/features.ts`; its actions, renderers and
  notices register from there. One registration serves the CLI, the MCP server and the Pi tool. A new action or field
  updates its spec (summary and params); `README.md` and `VIEWS.md` change only when a concept changes
- Gates: `bun run types`, `bun scripts/changed-tests.ts` (`--all` for the whole suite)
- Modules live flat in `src/` (and `src/pi/`): the deployed plugin is copied without other subdirectories
- Run a single test file with `env bun test <file>`: an output filter on some machines rewrites plain `bun test` output
  to a wrong summary
- A process that imports the core by path (gigachad-bot's pi-host) keeps the modules it loaded: after a merge into the
  default branch restart it, or it mixes old and new modules ("Export named ... not found")
- Every enumeration has one home; everything else reads it. A new member is added there and nowhere else:
  - task states, resting and final states, session entries: `State`, `RESTING_STATES`, `FINAL_STATES`, `EntryData`
    in `src/state.ts`
  - wave stages, resting, final and attention stages, block reasons, log events: `WaveStage`, `RESTING_WAVE_STAGES`,
    `WAVE_FINAL_STAGES`, `WAVE_ATTENTION_STAGES`, `WaveReason`, `WaveEvent` in `src/waves.ts`
  - actions and the decisions they record: each feature's `actions` (`decides`) in `src/feature-<name>.ts`, listed
    by `src/features.ts`
  - settings: `SETTINGS` in `src/settings.ts`; `factory.yaml` keys: `KNOWN_KEYS` in `src/config.ts`
  - notice events: `TASK_EVENTS` and `waveNotice` in `src/notify.ts`, a feature's own in its `notices`
  - card kinds and tones: `CardKind`, `CardTone` in `src/cards.ts`; error codes: `FactoryErrorCode` in `src/util.ts`
  - feedback kinds: `FEEDBACK_KINDS` in `src/feedback.ts`; proof states: `ProofState` in `src/gates-prove.ts`;
    scout states: `ScoutState` in `src/scouts.ts`
