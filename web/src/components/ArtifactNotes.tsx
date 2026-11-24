// Comments on an artifact in the preview pane. The page runs on another origin, so a script
// in it (web/src/frame/notes.ts) finds what you select or click, paints the highlights, and
// says where each one is; this layer over the frame draws the cards, as the margin does for
// comments on messages when there is no gutter: a card shows under its highlight while you
// write in it, after you click the highlight, or while the pointer is on the highlight. The
// comments go with your next message, as comments on messages do (store.ts queuedParts).
// Sent comments keep a faint highlight, and their card shows while the pointer is on it,
// until the artifact changes. Comment mode (the pane's Comment button, or a tap on Option)
// makes a click in the page start a comment instead of doing what the page does with it.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { addDraft, draftsOf, removeDraft, state, uid, useStore, type ArtDraft } from '../store.ts'
import type { ArtifactAnchor, ImageRef } from '../../../shared/types.ts'
import { isReaction } from '../emoji.ts'
import { focusField } from './Inputs.tsx'
import { CARD_W, NoteCard, SentCard } from './Margin.tsx'

// out: the mark is out of view in the page (in a box scrolled away from it, or under a sticky header).
type Box = { left: number; top: number; right: number; bottom: number; last: { left: number; right: number; bottom: number }; out?: boolean }
type FromFrame =
  | { t: 'ready' }
  | { t: 'new'; anchor: Omit<ArtDraft['anchor'], 'artifact'>; quote: string; box: Box | null }
  | { t: 'boxes'; boxes: Record<string, Box | null> }
  | { t: 'hover'; id: string | null }
  | { t: 'open'; id: string }
  | { t: 'mode'; on: boolean }

const isEmpty = (d: { text: string; images: unknown[] }) => !d.text.trim() && !d.images.length

// A click on a sent comment in the conversation shows its place in the page (Transcript.tsx).
const REVEAL = 'codinger:reveal-artifact-note'
export const revealArtifactNote = (sid: string, id: string) => dispatchEvent(new CustomEvent(REVEAL, { detail: { sid, id } }))

type Sent = { id: string; anchor: ArtifactAnchor; text: string; images?: ImageRef[] }

// mtime: when the artifact last changed (none for an old version, which does not change).
// mode: comment mode, which the pane's button shows.
export function ArtifactNotes({ sid, artifact, v, mtime, frame, mode, setMode }: { sid: string; artifact: string; v?: number; mtime?: number; frame: React.RefObject<HTMLIFrameElement | null>; mode: boolean; setMode(on: boolean): void }) {
  const st = useStore()
  const here = (a: ArtifactAnchor) => a.artifact === artifact && a.v === v
  const all = draftsOf(sid).filter((d): d is ArtDraft => d.kind === 'artifact' && here(d.anchor))
  const cards = all.filter((d) => !d.reaction)
  // Sent comments on the page as it is now: on this version, or made since the artifact last changed.
  const sent: Sent[] = []
  for (const e of st.events[sid] ?? []) if (e.t === 'user') e.parts.forEach((p, i) => {
    if (p.kind === 'artifact' && here(p.anchor) && (v != null || p.anchor.at === mtime)) sent.push({ id: `s${e.seq}.${i}`, anchor: p.anchor, text: p.text, images: p.images })
  })
  const sentCards = sent.filter((n) => !isReaction(n.text) || n.images?.length)
  const layer = useRef<HTMLDivElement>(null)
  const [boxes, setBoxes] = useState<Record<string, Box | null>>({})
  // The card showing (after a click on its highlight, or while you write in it), and the one under the pointer.
  const [open, setOpen] = useState<string | null>(null)
  const [peek, setPeek] = useState<string | null>(null)
  // The comment whose highlight darkens: the card under the pointer, else the one with the focus.
  const [lit, setLit] = useState<string | null>(null)
  const [focused, setFocused] = useState<string | null>(null)

  const post = (m: Record<string, unknown>) => {
    const f = frame.current
    if (!f?.contentWindow || !f.src) return
    f.contentWindow.postMessage({ codinger: 'notes', ...m }, new URL(f.src).origin)
  }
  const marks = JSON.stringify([...sent.map((n) => ({ id: n.id, kind: 'sent', anchor: n.anchor })), ...all.map((d) => ({ id: d.id, kind: 'draft', anchor: d.anchor }))])
  const focus = lit ?? focused
  const sendMarks = () => post({ t: 'marks', items: JSON.parse(marks), focus })
  const sendRef = useRef(sendMarks)
  sendRef.current = sendMarks
  useEffect(sendMarks, [marks, focus])
  const modeRef = useRef(mode)
  modeRef.current = mode
  useEffect(() => post({ t: 'mode', on: mode }), [mode])
  // A tap on Option alone, here as in the page, turns comment mode on or off.
  useEffect(() => {
    let at = 0
    // Option held here shows the box under the pointer in the page at once, as Option held there.
    const down = (e: KeyboardEvent) => { at = e.key === 'Alt' && !e.repeat ? performance.now() : 0; if (at) post({ t: 'alt', on: true }) }
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Alt' && at && performance.now() - at < 400) setMode(!modeRef.current)
      else if (e.key === 'Alt') post({ t: 'alt', on: false })
      at = 0
    }
    const press = () => { at = 0 }
    addEventListener('keydown', down, true); addEventListener('keyup', up, true); addEventListener('pointerdown', press, true)
    return () => { removeEventListener('keydown', down, true); removeEventListener('keyup', up, true); removeEventListener('pointerdown', press, true) }
  }, [])
  // A place to show once the page is ready.
  const reveal = useRef<string | null>(null)
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ sid: string; id: string }>).detail
      if (d.sid !== sid) return
      reveal.current = d.id
      post({ t: 'reveal', id: d.id })
      setPeek(d.id)
    }
    addEventListener(REVEAL, on)
    return () => removeEventListener(REVEAL, on)
  }, [sid])

  const openCard = (id: string) => {
    setOpen(id)
    requestAnimationFrame(() => focusField(layer.current?.querySelector<HTMLElement>(`.note-card[data-id="${id}"] .ri-edit`)))
  }
  const peekTimer = useRef(0)
  const hoverCard = (id: string, on: boolean) => {
    clearTimeout(peekTimer.current)
    setPeek(on ? id : null)
    setLit(on ? id : null)
  }
  useEffect(() => {
    const on = (e: MessageEvent) => {
      const f = frame.current
      if (!f || e.source !== f.contentWindow || e.data?.codinger !== 'notes') return
      const m = e.data as FromFrame
      if (m.t === 'ready') {
        sendRef.current()
        post({ t: 'mode', on: modeRef.current })
        if (reveal.current) post({ t: 'reveal', id: reveal.current })
      }
      else if (m.t === 'mode') setMode(m.on)
      else if (m.t === 'boxes') setBoxes(m.boxes)
      else if (m.t === 'hover') {
        clearTimeout(peekTimer.current)
        // It goes one frame after the pointer leaves the highlight.
        // The pointer went from the highlight onto its card: the card keeps itself open.
        if (layer.current?.querySelector('.note-card:hover')) return
        if (m.id) setPeek(m.id); else peekTimer.current = window.setTimeout(() => setPeek(null), 16)
        setLit(m.id)
      } else if (m.t === 'open') openCard(m.id)
      else if (m.t === 'new') {
        // One empty comment at a time: a new one drops the untouched last one.
        for (const d of draftsOf(sid)) if ((d.kind === 'note' || d.kind === 'artifact') && !d.reaction && isEmpty(d)) removeDraft(sid, d.id)
        const id = uid()
        const anchor = { ...m.anchor, artifact, ...(v != null ? { v } : { at: mtime }) }
        if (m.box) setBoxes((b) => ({ ...b, [id]: m.box }))
        addDraft(sid, { id, kind: 'artifact', anchor, quote: String(m.quote ?? '').slice(0, 1000), text: '', images: [], createdAt: Date.now() })
        setOpen(id)
      }
    }
    addEventListener('message', on)
    return () => removeEventListener('message', on)
  }, [sid, artifact, v, mtime])

  // Place each card under the last line of its highlight, centred on it, inside the pane.
  // A highlight out of view hides its card, unless you write in it.
  useLayoutEffect(() => {
    const el = layer.current
    if (!el) return
    const w = el.clientWidth, h = el.clientHeight
    for (const c of el.querySelectorAll<HTMLElement>('.note-card, .react-badge')) {
      const id = c.dataset.id!, b = boxes[id]
      // One card is open at a time (the one you write in, or opened last), and one more while the
      // pointer is on its highlight, except while you write: then no card shows over the one you write in.
      const writing = c.contains(document.activeElement)
      const shown = c.classList.contains('react-badge') || [open, state.focus].includes(id) || (id === peek && !focused)
      if (!b || !shown || (!writing && (b.out || b.bottom < 0 || b.top > h))) { c.style.display = 'none'; continue }
      c.style.display = ''
      if (c.classList.contains('react-badge')) {
        c.style.left = `${Math.min(b.right + 2, w - c.offsetWidth - 2)}px`
        c.style.top = `${Math.max(2, b.top - c.offsetHeight / 2)}px`
        continue
      }
      const cw = Math.min(CARD_W, w - 8)
      c.style.width = `${cw}px`
      const mid = (b.last.left + b.last.right) / 2
      c.style.left = `${Math.max(4, Math.min(mid - cw / 2, w - cw - 4))}px`
      c.style.top = `${Math.max(4, Math.min(b.last.bottom + 6, h - c.offsetHeight - 4))}px`
    }
  })

  // Reactions show as one badge for each place, at the right of its highlight; a click takes one off.
  // Sent reactions show too, in a badge of their own.
  const group = <T extends { id: string; anchor: ArtifactAnchor; text: string }>(list: T[]) => {
    const m = new Map<string, T[]>()
    for (const d of list) { const k = JSON.stringify({ ...d.anchor, at: 0 }); m.set(k, [...(m.get(k) ?? []), d]) }
    return [...m.values()]
  }
  const badges = group(all.filter((d) => d.reaction && isReaction(d.text)))
  const sentBadges = group(sent.filter((n) => isReaction(n.text) && !n.images?.length))
  // A badge is placed by the first comment on its place that the page reported.
  const boxFor = (ds: { id: string }[]) => ds.find((d) => boxes[d.id])?.id ?? ds[0].id

  return (
    <div className="artifact-notes" ref={layer}>
      {cards.map((d) => (
        <NoteCard
          key={d.id} sid={sid} note={d} onOpen={() => setOpen(d.id)}
          onHover={(on) => hoverCard(d.id, on)}
          onFocus={() => { if (state.focus === d.id) state.focus = null; setFocused(d.id); setOpen(d.id) }}
          onBlur={() => {
            setFocused((f) => f === d.id ? null : f)
            setTimeout(() => { if (!layer.current?.querySelector(`.note-card[data-id="${d.id}"]`)?.contains(document.activeElement)) setOpen((o) => o === d.id ? null : o) }, 250)
          }}
        />
      ))}
      {sentCards.map((n) => <SentCard key={n.id} sid={sid} n={n} onHover={(on) => hoverCard(n.id, on)} />)}
      {sentBadges.map((ds) => (
        <span key={ds[0].id} data-id={boxFor(ds)} className="react-badge" onMouseEnter={() => setLit(boxFor(ds))} onMouseLeave={() => setLit(null)}>{ds.map((d) => d.text.trim()).join('')}</span>
      ))}
      {badges.map((ds) => (
        <button key={ds[0].id} data-id={boxFor(ds)} className="react-badge draft" onMouseEnter={() => setLit(boxFor(ds))} onMouseLeave={() => setLit(null)}
          onClick={() => { setLit(null); removeDraft(sid, ds[ds.length - 1].id) }}>{ds.map((d) => d.text.trim()).join('')}</button>
      ))}
    </div>
  )
}
