# factory-tui

A read-only terminal view of the agent factory for when no browser is open. It talks only to the `factory` CLI
(`factory <action> '<json>' --json`, the full view): the binary from `PATH`, or the one in `FACTORY_CLI`.

- Left: the repositories, under each its waves as a tree by tag (track > milestone > wave, with `done/total`, stage and
  cost; tracks and milestones sum their waves), and its tasks outside a wave
- Right: the selected wave (stage, tasks, reviews with findings, gates, merge, usage) or task (state, round, usage, the
  last timeline entries)
- It refreshes every 10 seconds. A factory without `waves.list` shows tasks only

## Install

```sh
uv tool install ./tui
factory-tui
```

## Keys

| Key | Does |
|---|---|
| `↑` `↓` / `k` `j` | move in the tree, scroll the detail |
| `←` `→` / `h` `l` | tree / detail pane |
| `enter`, `space` | fold a node |
| `/` | filter waves and tasks (id, tag, title, stage, branch); `enter` back to the tree, `esc` clears |
| `r` | refresh now |
| `q` | quit |

## Develop

```sh
cd tui && uv run pytest -q
```
