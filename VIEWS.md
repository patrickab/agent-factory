# Views

Every event of the factory (an action's result, a notice) has one view model, its **card** (`src/cards.ts`), built
from the state. Three forms come from it:

- **Full view**: the action's JSON result, stable and complete, for programs: `callAction`, `factory <action> --json`,
  the `result` in a tool's `details`. Every action's parameters: `factory actions <name>`
- **Agent's text**: the card as text (`cardText`), for a model's context: the `factory` tool in Pi, the MCP tool, the
  CLI without `--json`, the text of a notice
- **Card**: for people. A surface (Pi's TUI, gigachad-bot, `factory-tui`) renders the card and never parses the
  agent's text

## The agent's text

- First line: the title, the short id (8 characters; every action accepts it), the state, progress, tag, cost in
  dollars. Then one `label: text` line per row, one line per finding, the text, and last `next:` with the actions
  valid now
- Only what the next decision needs in that state: a question, a failure with its output's tail, the findings, the
  merged commit. Never a path (a home reads `~`), a timestamp or a session id
- An error is one line with its way out: `refused: wave 3f2a91c0 is merged, nothing can be added · next: waves.get`
- `tasks.list` and `waves.list` show what is not finished, then a count of the rest. `tasks.timeline` has no agent's
  text: it is not in the agent's tools, the CLI prints JSON

A task that asks, as a notice in its origin session (`factory: ` before the card's text):

```
factory: a coder asks  id 4ae7325b  waiting_answer  factory/w1  $2.10
  task: feat(waves): declare a wave
  round: 1
waves.start takes overrides the tasks inherit, but the declaration has no field for them. Add one?
  next: tasks.message (answers it), tasks.cancel
```

A wave, as `waves.get` answers it:

```
wave factory/w1  id 3f2a91c0  rejected  1/3 done  $18.40
  wave: the wave mechanism
  tasks: record done (record00), actions running (actions0), docs pending (docs0000)
  review: 2: rejected
  major  src/wave-runner.ts:309  A wave whose tasks can never start stays building forever.
  next: waves.add, waves.cancel
```

## The card

```ts
interface FactoryCard {
  v: 1;                          // a renderer ignores fields it does not know
  kind: "wave" | "task" | "scout" | "proof" | "contract" | "decision" | "action";
  tone: "attention" | "quiet";
  title: string;                 // one line, no "factory:" prefix
  tag?: string; id?: string;     // the wave's tag; the short id
  state?: string;
  cost?: number;                 // cents
  progress?: { done: number; total: number };
  rows?: { label: string; text: string }[];   // the row "next": the actions valid now
  findings?: { severity: "blocker" | "major" | "minor"; file?: string; line?: number; text: string }[];
  text?: string;                 // markdown: a question, a message sent, a report; failures fenced
  answers?: string;              // decision: the notice key it settles
}
```

No field is undefined and no list empty: a card survives JSON unchanged. A notice carries `details {key, card}`, a
`factory` tool result `details {result, card}` (none on an error).

- **Kinds**: `task`, `wave`, `scout`, `proof` (a gate proof), `contract` (a contract change that reached done tasks),
  `decision` (a supervisor's action that settles something: `answers` names the notice it settles, read from state
  when the action runs; logged per origin, `decisions.list`), `action` (any other result: lists, settings, models)
- **Tones**: `attention` for what needs a ruling (a question, blocked, rejected, waiting for approve, interrupted,
  tasks that can never start, failing gates); everything else, a merged wave included, is `quiet`

## Pi

Notices (`factory-notice`) and the `factory` tool's calls and results are drawn as cards (`src/pi/cards-tui.ts`):
icon `◆`, title (toned when it needs a ruling), tag, state, cost, progress, rows, findings by severity (collapsed to
counts), text. Readable is the default; **Alt+V** toggles every factory card of the session to the agent's text. In
a session that declared waves, a widget above the editor (`src/session-widget.ts`) shows the active waves and counts
the cards to rule on: the latest attention notice per task, wave, scout or proof that no decision answered.
