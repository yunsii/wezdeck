// One diagram on React Flow (@xyflow/react): lanes as background nodes, cards
// on the lane grid (layout.ts), links styled by kind. Read-only: nothing
// drags or connects; the wheel scrolls the page (pinch or Ctrl+wheel zooms),
// dragging pans. Pointing at or selecting a card lights its links and dims
// the rest — the one "rich" effect, and the one that answers "what touches
// this?". Loaded lazily by the page, so the console never carries it.
import '@xyflow/react/dist/base.css'

import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
} from '@xyflow/react'
import type { Edge, Node, NodeProps } from '@xyflow/react'
import { createContext, memo, use, useMemo, useState } from 'react'

import { cn } from '#/lib/utils'
import { CARD_H, CARD_W, layout, sides } from './layout'
import type { Placed } from './layout'
import { KIND_STYLE, pick } from './model'
import type { Diagram, Lang } from './model'

type CardData = {
  placed: Placed
  lang: Lang
  numbered: boolean
  state: 'idle' | 'lit' | 'dim' | 'selected'
}
type LaneData = { label: string; w: number; h: number; tone: number }

const SIDES = {
  l: Position.Left,
  r: Position.Right,
  t: Position.Top,
  b: Position.Bottom,
}

/**
 * Hover goes through the card's own element, not React Flow's node mouse
 * callbacks: those fired leave / enter on every pointer move once the
 * highlight re-rendered the nodes, and the dimming flickered.
 */
const HoverContext = createContext<(id: string | null) => void>(() => {})

const CardNode = memo(function CardView({ data }: NodeProps<Node<CardData>>) {
  const setHover = use(HoverContext)
  const { placed, lang, numbered, state } = data
  const { card, index } = placed
  return (
    <div
      onPointerEnter={() => setHover(data.placed.card.id)}
      onPointerLeave={() => setHover(null)}
      style={{ width: CARD_W, height: CARD_H }}
      className={cn(
        'grid cursor-pointer content-start gap-1 rounded-xl border bg-brand-surface px-3.5 py-3 text-left shadow-[0_1px_0_var(--brand-border)] transition-[opacity,border-color,box-shadow] duration-[var(--motion-short)]',
        state === 'selected'
          ? 'border-brand-running shadow-[0_0_0_3px_color-mix(in_srgb,var(--brand-running)_22%,transparent)]'
          : state === 'lit'
            ? 'border-brand-running/60'
            : 'border-brand-border',
        state === 'dim' && 'opacity-35',
        card.planned && 'border-dashed',
      )}
    >
      {(['l', 'r', 't', 'b'] as const).flatMap((side) => [
        <Handle
          key={`s${side}`}
          id={`s-${side}`}
          type="source"
          position={SIDES[side]}
          className="!opacity-0"
          isConnectable={false}
        />,
        <Handle
          key={`t${side}`}
          id={`t-${side}`}
          type="target"
          position={SIDES[side]}
          className="!opacity-0"
          isConnectable={false}
        />,
      ])}
      <span className="flex min-w-0 items-baseline gap-2">
        {numbered ? (
          <span className="shrink-0 text-meta font-semibold text-brand-running tabular-nums">
            {index + 1}
          </span>
        ) : null}
        <span className="truncate text-body font-semibold text-brand-text">
          {pick(card.title, lang)}
        </span>
        {card.planned ? (
          <span className="ml-auto shrink-0 rounded-full border border-dashed border-brand-border px-1.5 text-meta text-brand-label">
            {lang === 'zh' ? '规划中' : 'planned'}
          </span>
        ) : null}
      </span>
      <span className="line-clamp-2 text-caption leading-snug text-brand-muted">
        {pick(card.sub, lang)}
      </span>
    </div>
  )
})

/** lanes alternate two quiet tints so the columns read without borders */
const LaneNode = memo(function LaneView({ data }: NodeProps<Node<LaneData>>) {
  return (
    <div
      style={{ width: data.w, height: data.h }}
      className={cn(
        'rounded-2xl border border-brand-border',
        data.tone % 2 ? 'bg-brand-soft' : 'bg-transparent',
      )}
    >
      <div className="px-4 pt-3.5 text-caption font-semibold text-brand-label">
        {data.label}
      </div>
    </div>
  )
})

const nodeTypes = { card: CardNode, lane: LaneNode }

export function FlowCanvas({
  diagram,
  lang,
  selected,
  onSelect,
}: {
  diagram: Diagram
  lang: Lang
  selected: string | null
  onSelect: (id: string | null) => void
}) {
  const [hover, setHover] = useState<string | null>(null)
  const geo = useMemo(() => layout(diagram), [diagram])
  const focus = hover ?? selected
  const near = useMemo(() => {
    if (!focus) return null
    const ids = new Set([focus])
    for (const link of diagram.links)
      if (link.from === focus) ids.add(link.to)
      else if (link.to === focus) ids.add(link.from)
    return ids
  }, [diagram, focus])

  const nodes = useMemo<Array<Node>>(() => {
    const lanes: Array<Node<LaneData>> = geo.lanes.map((box, i) => ({
      id: `lane:${box.key}`,
      type: 'lane',
      position: { x: box.x, y: 0 },
      data: {
        label: pick(diagram.lanes[i]?.label ?? { zh: '', en: '' }, lang),
        w: box.w,
        h: box.h,
        tone: i,
      },
      selectable: false,
      focusable: false,
      zIndex: -1,
      width: box.w,
      height: box.h,
    }))
    const cards: Array<Node<CardData>> = geo.placed.map((placed) => ({
      id: placed.card.id,
      type: 'card',
      position: { x: placed.x, y: placed.y },
      // known sizes: without them every rebuilt node counts as unmeasured
      // and is hidden for a frame, the pointer fell through to the pane,
      // hover left, and the highlight flickered on every move
      width: CARD_W,
      height: CARD_H,
      data: {
        placed,
        lang,
        numbered: Boolean(diagram.numbered),
        state:
          placed.card.id === selected
            ? 'selected'
            : !near
              ? 'idle'
              : near.has(placed.card.id)
                ? 'lit'
                : 'dim',
      },
      ariaLabel: pick(placed.card.title, lang),
      // not draggable, so React Flow leaves off `nopan`: d3-zoom then took
      // the pointer and the click never selected the card
      className: 'nopan',
    }))
    return [...lanes, ...cards]
  }, [geo, diagram, lang, selected, near])

  const edges = useMemo<Array<Edge>>(() => {
    const at = new Map(geo.placed.map((p) => [p.card.id, p]))
    return diagram.links.flatMap((link, i) => {
      const from = at.get(link.from)
      const to = at.get(link.to)
      if (!from || !to) return []
      const [out, into] = sides(from, to)
      const kind = link.kind ?? 'flow'
      const style = KIND_STYLE[kind]
      const touches = !focus || link.from === focus || link.to === focus
      return [
        {
          id: `e${i}`,
          source: link.from,
          target: link.to,
          sourceHandle: `s-${out}`,
          targetHandle: `t-${into}`,
          type: 'smoothstep',
          animated: kind === 'flow' && touches,
          label: link.label ? pick(link.label, lang) : undefined,
          labelStyle: { fill: 'var(--brand-muted)', fontSize: 11.5 },
          labelBgStyle: { fill: 'var(--brand-deck)' },
          labelBgPadding: [5, 2] as [number, number],
          labelBgBorderRadius: 6,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: style.color,
            width: 16,
            height: 16,
          },
          style: {
            stroke: style.color,
            strokeWidth: touches && focus ? 2.2 : 1.6,
            strokeDasharray: style.dash,
            opacity: touches ? 1 : 0.15,
            transition: 'opacity var(--motion-short)',
          },
          focusable: false,
        } satisfies Edge,
      ]
    })
  }, [geo, diagram, lang, focus])

  return (
    <HoverContext value={setHover}>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.06 }}
          minZoom={0.35}
          maxZoom={1.6}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          edgesFocusable={false}
          zoomOnScroll={false}
          zoomOnPinch
          panOnScroll={false}
          preventScrolling={false}
          zoomOnDoubleClick={false}
          onNodeClick={(_, node) =>
            node.type === 'card' &&
            onSelect(node.id === selected ? null : node.id)
          }
          onPaneClick={() => onSelect(null)}
          className="arch-flow"
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={22}
            size={1}
            color="var(--brand-border)"
          />
          <Controls showInteractive={false} position="bottom-left" />
        </ReactFlow>
      </ReactFlowProvider>
    </HoverContext>
  )
}

export default FlowCanvas
