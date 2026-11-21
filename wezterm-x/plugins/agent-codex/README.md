# agent-codex

OpenAI Codex CLI (codex) provider for WezDeck reporting and review:

- `review_provider` — `codex__available / __family / __model / __invoke` for
  adversarial-review, brainstorm and agent-fanout
  ([`docs/adversarial-review.md`](../../../docs/adversarial-review.md)).
- `habit_provider` — `collect()` for the habit weekly report
  ([`skills/habit-weekly/SKILL.md`](../../../skills/habit-weekly/SKILL.md)).

Disable it on a machine without this CLI via `wezterm-x/local/plugins.json`
(`"disabled": ["agent-codex"]`). Launching the CLI is not part of this plugin:
every launch terminates at `scripts/runtime/agent-launcher.sh <profile>`.
