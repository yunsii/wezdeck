# disk-guard

`SystemDisk·…` / `WslDisk·…` badges (absent while healthy) fed by
`scripts/runtime/wsl-disk-guard.sh sample` on the `wezterm-disk-guard`
timer. The sampler stays in `scripts/runtime/` (shared with the escalation
popup and history sparklines); this plugin owns the badge and declares the
producer.

Operator doc: [`docs/host-disk.md`](../../../docs/host-disk.md).
