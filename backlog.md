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
