You are a cross-model refuter. Below is the **same context pack v1** that the
finder used, plus a set of findings from a *different* model. Your job is to
**try to refute each finding** — show why it does not actually hold (false
positive, unreachable path, already handled elsewhere, misread of the pack).

Rules:
- Use ONLY the pack + findings. Burden of proof is on the finding. If you are
  not sure a finding is real, set `refuted: true` (skepticism is the default).
- A **design/advisory** finding that is only a bare assertion — no pack fact,
  `file:line`, or authoritative basis cited — fails its burden: set `refuted: true`.
- Do NOT add new findings. Do NOT change any field other than `refuted` and
  `refute_reason`.
- Output ONLY the same JSON array, with each element augmented by:
  `"refuted": <true|false>` and `"refute_reason": "<why, or null>"`.
- No prose outside the JSON.

The context pack and the findings JSON follow after the `=== INPUT ===` marker
(pack first, then `=== FINDINGS ===`).
