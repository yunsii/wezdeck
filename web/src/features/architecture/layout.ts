// Lane layout: one column per lane, cards on a row grid. A flow's card sits
// on the row of its order, so the story reads top to bottom and a link to
// another lane slants down; the overview places cards on explicit rows.
import type { Card, Diagram } from './model'

export const CARD_W = 232
export const CARD_H = 96
export const LANE_GAP = 40
// the gap between rows (ROW_H - CARD_H) carries link labels such as 命名管道
export const ROW_H = 152
export const HEAD_H = 52
const PAD = 14

export type Placed = { card: Card; index: number; x: number; y: number }
export type LaneBox = { key: string; x: number; w: number; h: number }

/**
 * Rows for every card. Explicit rows win (the overview). A flow reads as a
 * staircase: a step that moves to a lane further right stays on the row of
 * the step before it; one in the same lane or to the left starts a new row.
 * Nine steps over three lanes take six rows, not nine.
 */
export function rowsOf(diagram: Diagram): Array<number> {
  const laneIndex = new Map(diagram.lanes.map((lane, i) => [lane.key, i]))
  const out: Array<number> = []
  diagram.cards.forEach((card, index) => {
    if (card.row !== undefined) return out.push(card.row)
    if (!diagram.numbered || index === 0) return out.push(0)
    const prev = diagram.cards[index - 1]?.lane ?? card.lane
    const before = out[index - 1] ?? 0
    const right = (laneIndex.get(card.lane) ?? 0) > (laneIndex.get(prev) ?? 0)
    out.push(right ? before : before + 1)
  })
  return out
}

export function layout(diagram: Diagram) {
  const laneIndex = new Map(diagram.lanes.map((lane, i) => [lane.key, i]))
  const laneW = CARD_W + PAD * 2
  const row = rowsOf(diagram)
  const placed: Array<Placed> = diagram.cards.map((card, index) => {
    const col = laneIndex.get(card.lane) ?? 0
    return {
      card,
      index,
      x: col * (laneW + LANE_GAP) + PAD,
      y: HEAD_H + (row[index] ?? 0) * ROW_H,
    }
  })
  const rows = Math.max(0, ...placed.map((p) => (p.y - HEAD_H) / ROW_H)) + 1
  const h = HEAD_H + rows * ROW_H
  const lanes: Array<LaneBox> = diagram.lanes.map((lane, i) => ({
    key: lane.key,
    x: i * (laneW + LANE_GAP),
    w: laneW,
    h,
  }))
  return {
    placed,
    lanes,
    width: lanes.length * (laneW + LANE_GAP) - LANE_GAP,
    height: h,
  }
}

/** which sides a link leaves and enters by: across lanes left / right, within a lane down / up */
export function sides(from: Placed, to: Placed) {
  if (from.x === to.x)
    return to.y >= from.y ? (['b', 't'] as const) : (['t', 'b'] as const)
  return to.x > from.x ? (['r', 'l'] as const) : (['l', 'r'] as const)
}

/** every link names cards that exist, every card sits in a known lane */
export function problems(diagram: Diagram): Array<string> {
  const ids = new Set(diagram.cards.map((card) => card.id))
  const lanes = new Set(diagram.lanes.map((lane) => lane.key))
  const out: Array<string> = []
  for (const card of diagram.cards)
    if (!lanes.has(card.lane))
      out.push(`${diagram.id}: ${card.id} in unknown lane ${card.lane}`)
  for (const link of diagram.links)
    for (const end of [link.from, link.to])
      if (!ids.has(end)) out.push(`${diagram.id}: link to unknown card ${end}`)
  if (ids.size !== diagram.cards.length)
    out.push(`${diagram.id}: duplicate card ids`)
  return out
}
