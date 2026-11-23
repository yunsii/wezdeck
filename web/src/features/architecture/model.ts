// The architecture page's data model: lanes (where something runs), cards in
// them, and typed links between cards — the same idea as fe1's stage-lane
// flows (React Flow + a lane layout), written for this page. Text is
// bilingual inline ({zh, en}): it is long prose that lives with the diagram,
// not UI chrome, so it stays out of the message catalogs.

export type Text = { zh: string; en: string }
export type Lang = keyof Text

export const pick = (text: Text, lang: Lang) => text[lang]

export type Lane = { key: string; label: Text }

/**
 * Link semantics, drawn by line style:
 * - flow     the main path (solid)
 * - data     reads / supplies data (dashed)
 * - trigger  fires or notifies (dotted)
 * - fallback taken when the main path fails, or an alternative (dash-dot)
 */
export type LinkKind = 'flow' | 'data' | 'trigger' | 'fallback'

/** line color and dash per kind, shared by the canvas and the legend */
export const KIND_STYLE: Record<LinkKind, { color: string; dash?: string }> = {
  flow: { color: 'var(--brand-running)' },
  data: { color: 'var(--brand-done)', dash: '6 5' },
  trigger: { color: 'var(--brand-violet)', dash: '2 5' },
  fallback: { color: 'var(--brand-waiting)', dash: '10 4 2 4' },
}

export type Card = {
  id: string
  lane: string
  /** row in the lane grid; flows default to their order */
  row?: number
  title: Text
  /** one or two lines on the card */
  sub: Text
  /** the concept, in the detail panel */
  body: Text
  /** implementation notes, folded: files, endpoints, fields */
  impl?: Text
  /** marks a step that is planned, not built */
  planned?: boolean
}

export type Link = {
  from: string
  to: string
  kind?: LinkKind
  label?: Text
}

export type Diagram = {
  id: string
  title: Text
  summary: Text
  lanes: Array<Lane>
  cards: Array<Card>
  links: Array<Link>
  /** numbered steps (a flow) or not (the overview) */
  numbered?: boolean
}
