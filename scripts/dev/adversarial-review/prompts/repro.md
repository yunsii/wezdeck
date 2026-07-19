Below is a single CONFIRMED code-defect finding **and** its related unified-diff
hunk (when available). Produce a **minimal reproduction script** that objectively
verifies whether the defect is real.

Input JSON shape after `=== INPUT ===`:
```json
{ "finding": { ... }, "related_diff": "<unified diff hunk or empty>" }
```

Contract (the orchestrator depends on it exactly):
- Output ONLY a bash script, inside a single ```bash fenced block.
- The script runs from a **detached sandbox worktree at HEAD** (not the dirty
  primary tree). Treat the tree as disposable.
- Prefer **read-only** checks: inspect files, run pure functions, `bash -n`,
  unit-style assertions. Avoid network, sudo, and mutating system state.
- If the defect reproduces, exit with a **non-zero** code and print one line to
  stderr explaining what went wrong.
- If the code behaves correctly (defect NOT reproduced), exit 0.
- If the defect cannot be reproduced without external services or multi-step
  product bootstrapping, output a script whose only effect is `exit 99`.

Keep it minimal and deterministic. No `sleep`-based races.
