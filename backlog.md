# Backlog

## Harness-agnostic agent definitions

- **Want**: define scouts, coders and the reviewer once (role prompt, tools, model, report shape) and run them on any harness (Pi, Claude Code, Codex)
- **Today**
  - Coders and the reviewer are `pi` children the factory spawns itself (`src/runner.ts`), their prompts live in the factory
  - Scouts are pi-subagents agents (`scout.md`, markdown with frontmatter: tools, thinking, system prompt), a Pi-only format
  - pi-subagents can run a child on another CLI through its external-CLI profiles, but the definition stays in its format
- **Needed**
  - One definition format the factory owns, with an adapter per harness that turns it into that harness's launch (flags, system prompt, tool allowlist)
  - The gate, review and merge steps already do not care which harness wrote the code
- **Workaround until then**
  - The `parallelize-plan` skill gives scouts their report shape in the task text (MISSING FROM PLAN, DECISIONS NEEDED, KEY FACTS, MEMORY) and the supervisor reads each scout's saved output file in full
  - A user-defined Pi `scout` agent can pin that shape for Pi

## From the second autonomous run

Each is small and stands alone. Order: by what cost the run most.

- **`waves.retry` retries the wave's interrupted tasks** and reports once. Today each task needs its own `tasks.retry` and sends its own notice: a reboot with seven tasks was eleven calls and eleven notices
- **A wave waits for a wave of another repository**: `after` takes `{repo, tag}`. Today the order across repositories is the supervisor's memory; a task then guesses an interface that is not built yet (three review rounds on one small task)
- **The rebase goes on when git already resolved it**: a conflict that `rerere` staged, no markers left, is continued instead of blocking the wave `infra`
- **`waves.remove` is slow**: about six minutes per wave, a `git worktree remove` per task with its `node_modules`. Move the worktrees aside under the merge lock, delete them in the background
- **A handover between tasks is recorded**: a coder that leaves a point of its request to another task has a tool for it (the factory adds the point to that task's request and tells the supervisor). Today the point falls between two coders and only the review finds it
- **A stale review worktree and a notice per interruption** are covered (polish/2, review/1); **the service that killed the runners** is fixed in gigachad-bot's `run.sh`
