// Questions (<ask>) and items to consider (<consider>) across a session, and
// where each one stands: still open, drafted, set aside, answered.

import { useMemo } from 'react'
import type { Event, Part } from '../../shared/types.ts'
import { itemsOf, type Item } from '../../shared/blocks.ts'
import { fromUser } from '../../shared/inbox.ts'
import { draftsOf, hasContent, inboxOf, useStore } from './store.ts'
import { reviewDone } from './review.ts'

export type ItemStatus =
  | 'open'        // in Claude's latest turn, nothing done yet
  | 'drafted'     // a reply is queued
  | 'dismissing'  // set aside, not sent yet
  | 'answered'    // a reply was sent
  | 'dismissed'   // set aside and sent
  | 'completing'  // marked done, not sent yet
  | 'completed'   // marked done and sent
  | 'pending'     // left open when you sent anyway: you can still reply
  | 'raised'      // the agent raised it again in a later message
  | 'skipped'     // an earlier turn moved on without it

export type TrackedItem = Item & { key: string; msg: string; status: ItemStatus; reply?: Part }

export type ItemFold = { replies: Map<string, Part>; dismissed: Set<string>; pending: Set<string>; done: Set<string> }

export function foldItems(events: Event[]): ItemFold {
  const f: ItemFold = { replies: new Map(), dismissed: new Set(), pending: new Set(), done: new Set() }
  for (const e of events) {
    if (e.t !== 'user') continue
    for (const p of e.parts) {
      if (p.kind === 'answer') f.replies.set(p.askKey, p)
      else if (p.kind === 'note' && p.itemKey) f.replies.set(p.itemKey, p)
      else if (p.kind === 'dismiss') for (const i of p.items) f.dismissed.add(i.key)
      else if (p.kind === 'pending') for (const i of p.items) f.pending.add(i.key)
      else if (p.kind === 'done') for (const i of p.items) f.done.add(i.key)
      // A review the agent asked for (<review>): your verdicts on it are the reply. A note with no
      // verdict leaves it open.
      else if (p.kind === 'review') for (const v of p.files) if (/:r\d+$/.test(v.group)) {
        if (v.verdict) f.replies.set(v.group, p)
        else if (!p.files.some((x) => x.group === v.group && x.verdict)) f.pending.add(v.group)
      }
    }
  }
  return f
}

// critical: only a comment with text counts as a reply to the item, not a reaction.
export function draftStatus(sid: string, key: string, critical = false): ItemStatus | null {
  // Set aside or done wins over a reply, which can come first (a reaction in the item).
  for (const d of draftsOf(sid)) {
    if (d.kind === 'dismiss' && d.key === key) return 'dismissing'
    if (d.kind === 'done' && d.key === key) return 'completing'
  }
  for (const d of draftsOf(sid)) {
    // A review is drafted when you decided on it or on each of its files (review.ts).
    // A note on it with no decision is a reply too: the review stays open after it.
    if (d.kind === 'verdict' && d.group === key && (reviewDone(sid, key) || (!d.path && !!d.text?.trim()))) return 'drafted'
    if (d.kind === 'answer' && d.askKey === key && hasContent(d)) return 'drafted'
    if (d.kind === 'note' && d.itemKey === key && hasContent(d) && (!critical || (!d.reaction && /[\p{L}\p{N}]/u.test(d.text)))) return 'drafted'
  }
  // A draft of the lead's counts as one of yours.
  const i = inboxOf(sid).find((x) => x.key === key)
  return !i ? null : i.kind === 'dismiss' ? 'dismissing' : i.kind === 'done' ? 'completing' : 'drafted'
}

export function trackItems(sid: string, events: Event[], fold: ItemFold): TrackedItem[] {
  const lastUser = events.findLastIndex(fromUser)
  const out: TrackedItem[] = []
  // Items the agent raised again later (<raise>, shared/blocks.ts raiseItems).
  const raised = new Set<string>()
  for (const e of events) if (e.t === 'assistant' && !e.synthetic) for (const b of e.blocks) if (b.type === 'text' && b.text.includes('again=')) for (const it of itemsOf(b.text)) if (it.again) raised.add(it.again)
  events.forEach((e, idx) => {
    if (e.t !== 'assistant' || e.synthetic) return
    e.blocks.forEach((b, i) => {
      if (b.type !== 'text') return
      const msg = `${e.seq}.${i}`
      for (const it of itemsOf(b.text)) {
        const key = `${msg}:${it.id}`
        const reply = fold.replies.get(key)
        const critical = it.kind === 'consider' && it.critical
        const status: ItemStatus = fold.done.has(key) ? 'completed'
          : reply ? 'answered'
          // A reply drafted after the dismissal went shows as one.
          : raised.has(key) || (it.parent && raised.has(`${msg}:${it.parent}`)) ? 'raised'
          : fold.dismissed.has(key) ? draftStatus(sid, key, critical) ?? 'dismissed'
          : fold.pending.has(key) ? draftStatus(sid, key, critical) ?? 'pending'
          : idx < lastUser ? 'skipped'
          : draftStatus(sid, key, critical) ?? 'open'
        out.push({ ...it, key, msg, status, reply })
      }
    })
  })
  // An answer to a question inside an item to consider is a reply to the item too.
  // Innermost first, so it goes up through every level.
  for (const it of [...out].reverse()) {
    if (!it.parent) continue
    const up = out.find((p) => p.msg === it.msg && p.id === it.parent)
    if (!up) continue
    if (it.status === 'answered' && (up.status === 'open' || up.status === 'pending' || up.status === 'dismissing' || up.status === 'dismissed')) Object.assign(up, { status: 'answered', reply: up.reply ?? it.reply })
    else if (it.status === 'drafted' && (up.status === 'open' || up.status === 'pending')) up.status = 'drafted'
  }
  return out
}

export function useItems(sid: string): TrackedItem[] {
  const st = useStore()
  const events = st.events[sid]
  const fold = useMemo(() => foldItems(events ?? []), [events])
  return trackItems(sid, events ?? [], fold)
}

// Bring an item into view in the transcript (opening any section around it).
export function revealItem(key: string) {
  const el = document.querySelector<HTMLElement>(`[data-item="${CSS.escape(key)}"]`)
  if (!el) return
  for (let d = el.closest('details'); d; d = d.parentElement?.closest('details') ?? null) d.open = true
  if (el.matches('.folded')) el.querySelector<HTMLButtonElement>('.fold-btn')?.click()
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash')
}
