// The lead's drafts for a session (SessionMeta.inbox), and the questions and
// items they can reply to. Both the server (auto-send, the lead's tools) and
// the browser (the reply tray) turn drafts into the parts of one message.

import { itemsOf, type Item } from './blocks.ts'
import type { Event, InboxItem, Part } from './types.ts'

export type OpenItem = Item & { key: string }

// A message from the user or the lead. Codinger's own notes (a task ended, the
// server stopped), autopilot's "go on" and messages from other sessions are
// not: the questions before them stay open, for the user to answer later.
export const fromUser = (e: Event): boolean => e.t === 'user' && e.from !== 'codinger' && e.from !== 'autopilot' && e.from !== 'mail'

// Questions and items in Claude's text since the user last spoke, keyed like
// the browser keys them ("<seq>.<block>:<id>").
export function openItemsOf(events: Event[]): OpenItem[] {
  const out: OpenItem[] = []
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (fromUser(e)) break
    if (e.t !== 'assistant' || e.synthetic) continue
    const here: OpenItem[] = []
    e.blocks.forEach((b, j) => { if (b.type === 'text') for (const it of itemsOf(b.text)) here.push({ ...it, key: `${e.seq}.${j}:${it.id}` }) })
    out.unshift(...here)
  }
  return out
}

// The parts of one message, in the order the browser sends your own replies:
// answers and replies, then done, then set aside, then plain text.
export function inboxParts(items: InboxItem[]): Part[] {
  const parts: Part[] = []
  for (const i of items) {
    if (i.kind === 'answer' && i.key) parts.push({ kind: 'answer', askKey: i.key, question: i.label ?? '', choices: i.choices ?? [], text: i.text, ...(i.draft ? { draft: i.draft } : {}) })
    // No anchor pieces: the reply is to the whole item, not to a passage in it.
    else if (i.kind === 'reply' && i.key) parts.push({ kind: 'note', quote: i.label ?? '', text: i.text, itemKey: i.key, whole: true, anchor: { msg: i.key.split(':')[0], pieces: [] } })
  }
  const done = items.filter((i) => i.kind === 'done' && i.key).map((i) => ({ key: i.key!, label: i.label ?? '', ...(i.text.trim() ? { text: i.text.trim() } : {}) }))
  if (done.length) parts.push({ kind: 'done', text: '', items: done })
  const dismissed = items.filter((i) => i.kind === 'dismiss' && i.key).map((i) => ({ key: i.key!, label: i.label ?? '' }))
  if (dismissed.length) parts.push({ kind: 'dismiss', text: '', items: dismissed })
  const text = items.filter((i) => !i.kind || i.kind === 'text').map((i) => i.text.trim()).filter(Boolean).join('\n\n')
  if (text) parts.push({ kind: 'text', text })
  return parts
}

// One line per draft, for the lead and for card labels.
export function inboxLabel(i: InboxItem): string {
  const on = i.label ? ` "${i.label.slice(0, 80)}"` : ''
  return i.kind === 'answer' ? `answer to${on}` : i.kind === 'reply' ? `reply to${on}` : i.kind === 'done' ? `done:${on}` : i.kind === 'dismiss' ? `set aside:${on}` : 'message'
}

// The open items marked critical that parts (a message the user sends) do not answer: an item
// needs a comment with text (not only a reaction) or Done, or an answer to a question inside it.
export function criticalUnanswered(events: Event[], parts: Part[]): OpenItem[] {
  const answered = new Set(parts.flatMap((p) =>
    p.kind === 'note' && p.itemKey && /[\p{L}\p{N}]/u.test(p.text) ? [p.itemKey]
    : p.kind === 'answer' && (p.choices?.length || p.text.trim() || p.images?.length) ? [p.askKey]
    : p.kind === 'done' ? p.items.map((i) => i.key) : []))
  const items = openItemsOf(events)
  // As in the browser (items.ts): a reply inside an item counts for the items around it, innermost first.
  for (const it of [...items].reverse()) {
    if (!it.parent || !answered.has(it.key)) continue
    const msg = it.key.slice(0, it.key.indexOf(':'))
    answered.add(`${msg}:${it.parent}`)
  }
  return items.filter((i) => i.kind === 'consider' && i.critical && !answered.has(i.key))
}
