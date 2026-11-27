// covers: web/src/lib/mermaid-svg.ts
import { describe, expect, it } from 'vitest'

import { normalizeMermaidSvg } from '#/lib/mermaid-svg'

describe('normalizeMermaidSvg', () => {
  it('strips fixed pixel width/height and inline max-width while keeping viewBox', () => {
    const raw =
      '<svg id="m1" width="1480" height="620" style="max-width: 1480px; background-color: transparent;" viewBox="0 0 1480 620"><g /></svg>'
    const result = normalizeMermaidSvg(raw)

    expect(result.viewBoxWidth).toBe(1480)
    expect(result.viewBoxHeight).toBe(620)
    expect(result.svg).toContain('width="100%"')
    expect(result.svg).toContain('preserveAspectRatio="xMidYMid meet"')
    expect(result.svg).toContain('style="background-color: transparent"')
    expect(result.svg).not.toMatch(/\bheight="/)
    expect(result.svg).not.toContain('max-width')
    expect(result.svg).not.toContain('width="1480"')
  })

  it('synthesizes viewBox from numeric width/height attributes when absent', () => {
    const raw =
      '<svg id="m2" width="960px" height="480px" style="max-width: 960px;"><rect /></svg>'
    const result = normalizeMermaidSvg(raw)

    expect(result.viewBoxWidth).toBe(960)
    expect(result.viewBoxHeight).toBe(480)
    expect(result.svg).toContain('viewBox="0 0 960 480"')
    expect(result.svg).toContain('width="100%"')
    expect(result.svg).not.toContain('style=')
  })

  it('handles percentage width with existing viewBox and preserves inner markup', () => {
    const raw =
      '<svg width="100%" viewBox="-50 -10 1120 740" style="max-width: 1120px;"><text>Hello</text></svg>'
    const result = normalizeMermaidSvg(raw)

    expect(result.viewBoxWidth).toBe(1120)
    expect(result.viewBoxHeight).toBe(740)
    expect(result.svg).toContain('<text>Hello</text>')
    expect(result.svg).toContain('width="100%"')
    expect(result.svg).not.toContain('max-width')
  })
})
