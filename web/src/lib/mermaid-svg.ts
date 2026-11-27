// Pure SVG normalization for Mermaid output so diagrams fit their container
// width cleanly without overflowing mobile or desktop reading columns.

export type NormalizedMermaidSvg = {
  svg: string
  viewBoxWidth: number | null
  viewBoxHeight: number | null
}

const DIM_STYLE_PROPS = new Set([
  'width',
  'min-width',
  'max-width',
  'height',
  'min-height',
  'max-height',
])

function parsePositiveNumber(raw?: string): number | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (trimmed.endsWith('%')) return null
  const match = /^(\d+(?:\.\d+)?)(?:px)?$/i.exec(trimmed)
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) && value > 0 ? value : null
}

function stripDimensionStyles(style: string): string {
  return style
    .split(';')
    .map((decl) => decl.trim())
    .filter((decl) => {
      if (!decl) return false
      const colon = decl.indexOf(':')
      if (colon === -1) return false
      const prop = decl.slice(0, colon).trim().toLowerCase()
      return !DIM_STYLE_PROPS.has(prop)
    })
    .join('; ')
}

/**
 * Strips fixed pixel width/height locks and inline `max-width` overrides from
 * the root `<svg>` tag emitted by Mermaid while preserving (or synthesizing)
 * `viewBox` so the diagram scales cleanly to 100% of its container width.
 */
export function normalizeMermaidSvg(rawSvg: string): NormalizedMermaidSvg {
  const openMatch = /^([\s\S]*?<svg\b)([^>]*)(>)/i.exec(rawSvg)
  if (!openMatch) {
    return { svg: rawSvg, viewBoxWidth: null, viewBoxHeight: null }
  }

  const [, prefix, rawAttrs, closeBracket] = openMatch
  const rest = rawSvg.slice(openMatch[0].length)

  const vbMatch = /\bviewBox\s*=\s*["']([^"']+)["']/i.exec(rawAttrs)
  let viewBoxWidth: number | null = null
  let viewBoxHeight: number | null = null
  if (vbMatch) {
    const parts = vbMatch[1]
      .trim()
      .split(/[\s,]+/)
      .map(Number)
    if (
      parts.length === 4 &&
      parts.every((n) => Number.isFinite(n)) &&
      parts[2] > 0 &&
      parts[3] > 0
    ) {
      viewBoxWidth = parts[2]
      viewBoxHeight = parts[3]
    }
  }

  const widthAttrMatch = /\bwidth\s*=\s*["']([^"']+)["']/i.exec(rawAttrs)
  const heightAttrMatch = /\bheight\s*=\s*["']([^"']+)["']/i.exec(rawAttrs)
  const attrWidth = parsePositiveNumber(widthAttrMatch?.[1])
  const attrHeight = parsePositiveNumber(heightAttrMatch?.[1])

  let attrs = rawAttrs
    .replace(/\s+\bwidth\s*=\s*(?:"[^"]*"|'[^']*')/gi, '')
    .replace(/\s+\bheight\s*=\s*(?:"[^"]*"|'[^']*')/gi, '')
    .replace(/\s+\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi, (_, dq, sq) => {
      const cleaned = stripDimensionStyles(String(dq ?? sq ?? ''))
      return cleaned ? ` style="${cleaned}"` : ''
    })

  if (!vbMatch && attrWidth && attrHeight) {
    viewBoxWidth = attrWidth
    viewBoxHeight = attrHeight
    attrs += ` viewBox="0 0 ${attrWidth} ${attrHeight}"`
  }

  if (!/\bpreserveAspectRatio\s*=/i.test(attrs)) {
    attrs += ' preserveAspectRatio="xMidYMid meet"'
  }

  attrs += ' width="100%"'

  return {
    svg: `${prefix}${attrs}${closeBracket}${rest}`,
    viewBoxWidth,
    viewBoxHeight,
  }
}
