# Brand Assets

Brand SVGs share a single visual language: dark deck plate with a diagonal `#2e3a4d → #080c14` gradient, three diagonal status colors `#22d3ee` (running) / `#f59e0b` (waiting) / `#34d399` (done), and lucide-aligned glyph proportions.

| File | Size | Purpose |
|---|---|---|
| [`icon.svg`](icon.svg) | 512×512 | Primary app icon — full 3×3 deck grid with three lit slots showing `running` / `waiting` / `done` glyphs |
| [`favicon.svg`](favicon.svg) | 32×32 | Simplified version of `icon.svg` — keeps only deck plate + three diagonal status dots |
| [`banner.svg`](banner.svg) | 1280×320 | README banner — embeds the deck icon plus wordmark, tagline, and live status counter |

## Geometric construction

`favicon.svg` is geometrically derived from `icon.svg` at 1/16 scale: edge padding 7.8% / inner padding 10.9% / corner radius 14.8% (outer) and 12.5% (inner) all match. The three status dots sit on icon's lit-slot centers (29.7% / 50% / 70.3%) with radius matching the icon slot rect's inscribed circle (`r = 2.25` in 32-vp = `r = 36` in 512-vp). When `icon.svg` and `favicon.svg` are overlaid at the same render size the dots land inside the icon's lit-slot rectangles.

Keep these proportions in sync if either is edited.
