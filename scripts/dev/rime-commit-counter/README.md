# Rime commit counter (WezDeck PoC)

Count **上屏** characters from 小狼毫 / Rime and join them with
`host.foreground` process changes (same privacy posture as foreground
sampling: **no text, no window titles**).

## Install

```bash
scripts/dev/rime-commit-counter/install.sh
```

Install copies the lua module, patches `*.custom.yaml`, **patches
`build/*.schema.yaml`**, and **restarts `WeaselServer`**. It does **not** run
full `WeaselDeployer /deploy` (雾凇全量部署很慢且常挂起 / 返回 -1)。

Path lookup uses Uninstall registry `DisplayIcon` (seconds), not a disk walk.

Log file (Windows):

`%LOCALAPPDATA%\wezterm-runtime\state\rime-commits.jsonl`

Each line: `{"ts":"…Z","chars":N,"source":"rime_commit"}`.

## Report (optional plugin)

Registered as `habit_report/plugins/rime.py`. Default `--plugins auto`:
detects install/log and runs only then; `--plugins off` disables;
`--plugins rime` forces.

`habit-report` / `habit-weekly` expose `plugins.rime` (and alias `rime_commits`):

| Bucket | Meaning |
| --- | --- |
| `wezterm` | OS foreground was `wezterm-gui` |
| `code` | VS Code |
| `chrome` | Chromium family |
| `other` / `unknown` | everything else / no FG edge yet |

**Not in PoC:** whether the focused WezTerm pane is `claude`/`codex`/`grok`
(agent foreground). That needs a WezTerm-side sample at commit time.

## Compare with habit `typed_chars`

- **Rime chars** ≈ Chinese (and other) commits through the IME.
- **typed_chars** ≈ session user feed minus protocol injection and \`\`\` fences.
- Paste / English ASCII / non-Rime input explain most gaps.
