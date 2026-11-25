// The session's questions and items to consider in one place: the open ones
// to answer or dismiss from here, and earlier ones for reference.

import { changed, dismissItem, markDone, setPanel, undismissItem } from '../store.ts'
import { revealItem, useItems, type TrackedItem } from '../items.ts'
import { AskCard } from './AssistantMessage.tsx'
import { useState } from 'react'
import { CheckIcon, ChevronIcon, CommentIcon, DashIcon, UndoIcon, XIcon } from './Icons.tsx'
import { renderInline } from '../util.ts'
import { withoutImages } from '../../../shared/images.ts'
import { withoutPastes } from '../../../shared/pastes.ts'
import type { Item } from '../../../shared/blocks.ts'

// pending: left open when you sent anyway, so it is still yours to answer.
const OPEN = new Set(['open', 'pending', 'drafted', 'dismissing', 'completing'])

export function AttentionPanel({ sid }: { sid: string }) {
  const [showDone, setShowDone] = useState(() => localStorage.getItem('codinger.panel.done') === '1')
  const toggleDone = () => { localStorage.setItem('codinger.panel.done', showDone ? '0' : '1'); setShowDone(!showDone) }
  const items = useItems(sid)
  const map = new Map(items.map((i) => [i.key, i]))
  // Critical items first.
  const open = items.filter((i) => OPEN.has(i.status)).sort((a, b) => +isCritical(b) - +isCritical(a))
  // Newest message first; within a message, reading order.
  const msgs = [...new Set(items.map((i) => i.msg))].reverse()
  const done = msgs.flatMap((m) => items.filter((i) => i.msg === m && !OPEN.has(i.status)))
  const waiting = open.filter((i) => i.status === 'open')
  return (
    <div className="attention">
      <div className="attention-top">
        <span className="attention-head">Open {waiting.length > 0 && <ItemCount items={waiting} />}</span>
      </div>
      {!open.length && <div className="attention-empty muted">Nothing open</div>}
      {open.map((i) => i.kind === 'ask'
        ? (
          <div key={i.key} className="panel-item" onClick={(e) => { if ((e.target as HTMLElement).closest('.ask-q')) revealItem(i.key) }}>
            <AskCard c={{ sid, msg: i.msg, items: map, live: false }} ask={i.ask} compact />
          </div>
        )
        : i.kind === 'review' ? <PanelReview key={i.key} sid={sid} item={i} />
        : <PanelConsider key={i.key} sid={sid} item={i} />)}
      {done.length > 0 && (
        <button className={`attention-head attention-done-head${showDone ? ' on' : ''}`} onClick={toggleDone}>
          <ChevronIcon size={11} className="chevron" /> Completed <span className="done-count">{done.length}</span>
        </button>
      )}
      {showDone && <div className="attention-done">{done.map((i) => <Done key={i.key} item={i} />)}</div>}
    </div>
  )
}

const isCritical = (i: Item) => i.kind === 'consider' && i.critical

// A review the agent asked for (<review>, Review.tsx): you decide in its card or in the Files tab.
function PanelReview({ sid, item }: { sid: string; item: TrackedItem }) {
  return (
    <div className={`panel-item consider rv-item st-${item.status}`}>
      <div className="consider-head">
        <button className="link panel-title" onClick={() => revealItem(item.key)} dangerouslySetInnerHTML={{ __html: renderInline(item.label) }} />
      </div>
      <div className="consider-foot"><button className="reply-btn" onClick={() => { setPanel(sid, { tab: 'files' }); changed() }}>Open in Files</button></div>
    </div>
  )
}

// The number of open items, on a pie of their kinds.
export function ItemCount({ items }: { items: Item[] }) {
  const critical = items.filter(isCritical).length, asks = items.filter((i) => i.kind === 'ask').length
  const reviews = items.filter((i) => i.kind === 'review').length
  return <span className="count pie" style={{ background: pieOf([['var(--bad)', critical], ['var(--blue)', asks], ['var(--hot)', reviews], ['var(--warn)', items.length - critical - asks - reviews]]) }}>{items.length}</span>
}

// A pie of the open items by kind, in their colours (critical items red, questions blue, other
// items yellow), with soft edges between the slices. oklab blends them through gray; oklch would go through green.
function pieOf(parts: [string, number][]): string {
  const shown = parts.filter(([, n]) => n > 0)
  const total = shown.reduce((t, [, n]) => t + n, 0)
  if (shown.length < 2) return shown[0]?.[0] ?? 'var(--blue)'
  // The gradient starts in the middle of the first slice, so each edge between slices blends.
  const sweeps = shown.map(([c, n]) => [c, (n / total) * 360] as const)
  const half = sweeps[0][1] / 2
  const blend = (s: number) => Math.min(30, s * 0.4)
  const stops = [`${sweeps[0][0]} 0deg`]
  let at = half
  sweeps.forEach(([c, s], i) => {
    const [next, ns] = sweeps[(i + 1) % sweeps.length]
    at = i === 0 ? half : at + s
    const b = Math.min(blend(s), blend(ns))
    stops.push(`${c} ${at - b}deg`, `${next} ${at + b}deg`)
  })
  stops.push(`${sweeps[0][0]} 360deg`)
  return `conic-gradient(from ${half}deg in oklab, ${stops.join(', ')})`
}

function PanelConsider({ sid, item }: { sid: string; item: TrackedItem }) {
  // Commenting happens on the item itself, so its margin card sits beside it.
  const comment = () => {
    revealItem(item.key)
    document.querySelector<HTMLButtonElement>(`[data-item="${CSS.escape(item.key)}"] > .consider-foot > .item-reply`)?.click()
  }
  return (
    <div className={`panel-item consider st-${item.status}${isCritical(item) ? ' critical' : ''}`}>
      <div className="consider-head">
        <button className="link panel-title" onClick={() => revealItem(item.key)} dangerouslySetInnerHTML={{ __html: renderInline(item.label) }} />
        <span className="item-actions">
          {item.status === 'open' && !isCritical(item) && <button className="icon-btn" title="Dismiss" onClick={() => dismissItem(sid, item.key, item.label)}><XIcon size={13} /></button>}
          {(item.status === 'dismissing' || item.status === 'completing') && <button className="icon-btn pop-in" title="Undo" onClick={() => undismissItem(sid, item.key)}><UndoIcon size={14} /></button>}
        </span>
      </div>
      {(item.status === 'open' || item.status === 'drafted') && (
        <div className="consider-foot">
          {item.kind === 'consider' && item.done && <button className="reply-btn" onClick={() => markDone(sid, item.key, item.label)}><CheckIcon size={13} /> Done</button>}
          <button className="reply-btn" onClick={comment}><CommentIcon size={13} /> Reply</button>
        </div>
      )}
      {item.status === 'completing' && <div className="consider-foot"><button className="done-mark pop-in" title="Undo" onClick={() => undismissItem(sid, item.key)}><CheckIcon size={12} /> Done</button></div>}
    </div>
  )
}

function Done({ item }: { item: TrackedItem }) {
  const r = item.reply
  const reply = withoutPastes(withoutImages(r?.kind === 'answer' ? [r.choices?.join('; '), r.text].filter(Boolean).join(' · ') : r?.kind === 'note' ? r.text : ''))
  const Icon = item.status === 'answered' || item.status === 'completed' ? CheckIcon : item.status === 'dismissed' ? XIcon : DashIcon
  return (
    <button className={`panel-done st-${item.status}`} onClick={() => revealItem(item.key)}>
      <span className="panel-done-icon"><Icon size={12} /></span>
      <span className="panel-done-main">
        <span className="panel-done-label" dangerouslySetInnerHTML={{ __html: renderInline(item.label) }} />
        {reply && <span className="panel-done-reply">{reply}</span>}
      </span>
    </button>
  )
}
