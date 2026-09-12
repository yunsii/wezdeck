# Delegate tickets (local)

Cross-repo work orders for coding agents. **Not git history.**

## Layout

| Path | Role |
| --- | --- |
| `_data/<id>/` | **Canonical** ticket body (`ticket.md`), `events.jsonl`, `meta.json` |
| `by-target/<repo>/{inbox,waiting-on-peer,in-progress,done}/` | **Derived** symlinks — “what belongs to this repo” |
| `by-source/<repo>/{open,closed}/` | **Derived** — “what I filed” |
| `archive/YYYY-MM/` | Close markers (body stays in `_data` for MVP) |
| `config.yml` | Target allowlist (`path` + `aliases`) |
| `index.json` | Regenerated summary (`delegate reindex`) |

Edit **`_data/<id>/ticket.md`** (or use CLI). Do not hand-move bucket symlinks — run `delegate reindex`.

## Status (authoritative)

`submitted` · `in_progress` · `waiting_initiator` · `waiting_target` · `shipped` · `closed` · `rejected` · `failed`

`owner`: `worker` | `initiator` | `human`

## CLI

```bash
"$TOOL/run.sh" init
"$TOOL/run.sh" create --to wezdeck --from avc --title "…" \
  --observed "…" --assumed "…"
"$TOOL/run.sh" inbox --to wezdeck   # or cwd inside wezdeck
"$TOOL/run.sh" claim --id req-…
"$TOOL/run.sh" board --to wezdeck
"$TOOL/run.sh" reply --id req-… --decision "…"
"$TOOL/run.sh" close --id req-… --doc docs/….md
```

`$TOOL` = `scripts/dev/cross-repo-delegate` (or `~/.agents/skills/cross-repo-delegate` after link). Short CLI: `delegate`.
