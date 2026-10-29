// One block of Claude's text, rendered markdown block by markdown block: each
// block is an anchoring root for comments (whose cards live in the margin, see
// Margin.tsx). The sections Claude marks (shared/blocks.ts) get their own
// treatment: <answer> stands out, <details> folds, <consider> items and <ask>
// questions each want a reply or a dismissal. With `live` (a reply still
// streaming) everything renders read-only and an unfinished section shows what
// has arrived.

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import type { Token, Tokens } from 'marked'
import DOMPurify from 'dompurify'
import { parseAskBody, type Ask } from '../../../shared/asks.ts'
import { askOf, commandOf, draftOf, isCritical, isTask, reviewFilesOf, reviewTextOf, segmentsOf, type Segment } from '../../../shared/blocks.ts'
import type { Anchor } from '../../../shared/types.ts'
import { holdKeyboard, marked, renderInline, renderText, served } from '../util.ts'
import { anchorFromRange, mediaIn, passageQuote, rangesFor, setHighlights } from '../anchoring.ts'
import { render as renderLive } from '../mdlive.ts'
import { addDraft, api, changed, LOCAL, machineOf, dismissItem, draftsOf, markDone, removeDraft, reviveItem, setDoneText, state, uid, undismissItem, updateDraft, useStore, type AnswerDraft, type DoneDraft, type NoteDraft } from '../store.ts'
import type { TrackedItem } from '../items.ts'
import { focusField, RichInput, Thumbs } from './Inputs.tsx'
import { CheckIcon, ChevronIcon, CommentIcon, PlusIcon, TerminalIcon, UndoIcon, XIcon } from './Icons.tsx'
import { EmojiPicker } from './EmojiPicker.tsx'
import { openFile } from './FileBrowser.tsx'
import { ReviewCard } from './Review.tsx'
import { ArtifactFrame } from './Artifacts.tsx'
import { focusPassage, onPassage } from './Margin.tsx'
import { lastEmoji, topEmoji, usedEmoji } from '../emoji.ts'
import { highlight } from '../highlight.ts'

// The mark on a completed question or item.
const Done = ({ status }: { status: string }) =>
  status === 'answered' ? <span className="item-done ok" title="Answered"><CheckIcon size={13} /></span>
  : status === 'completed' ? <span className="item-done ok" title="Done"><CheckIcon size={13} /></span>
  // A word, not an X, which would read as the Dismiss button.
  : status === 'dismissed' ? <span className="item-aside muted">Dismissed</span>
  : null

// A set-aside item folds to its title. Opened (the chevron, or a click on the
// title), it works as an open one, and using it takes the dismissal back.
function useFold(status: string, compact?: boolean) {
  const aside = status === 'dismissing' || status === 'dismissed'
  const [unfolded, setUnfolded] = useState(false)
  const folded = aside && !unfolded
  const toggle = () => setUnfolded(!unfolded)
  return {
    aside, folded,
    // In the side panel it stays as it is, without a chevron.
    cls: aside && !compact ? (folded ? ' folded' : ' unfolded') : '',
    chevron: aside && <button className={`icon-btn fold-btn${folded ? '' : ' on'}`} title={folded ? 'Show' : 'Hide'} onClick={toggle}><ChevronIcon size={12} className="chevron" /></button>,
    // Not at the end of a selection, which opens a comment.
    onTitle: () => { if (aside && getSelection()?.isCollapsed !== false) toggle() },
  }
}

// The mark on a set-aside item: Undo until it is sent.
const AsideMark = ({ sid, itemKey, status }: { sid: string; itemKey: string; status: string }) =>
  status === 'dismissing' ? <button className="icon-btn pop-in" title="Undo" onClick={() => undismissItem(sid, itemKey)}><UndoIcon size={14} /></button> : <Done status={status} />

type SectionPiece = { kind: 'answer' | 'details' | 'consider'; title: string; id: string; pieces: Piece[]; block: number; closed: boolean; task: boolean; critical: boolean }
type Piece =
  | { kind: 'html'; html: string; block: number }
  | { kind: 'artifact'; name: string; v?: number; block: number }
  | { kind: 'ask'; ask: Ask; block: number }
  | { kind: 'run'; title: string; command: string; block: number; closed: boolean }
  | { kind: 'review'; title: string; files: string[]; n: number; block: number; pieces: Piece[] }
  | SectionPiece

function piecesOf(text: string): Piece[] {
  // Block numbers run through the whole message; without sections they are the token indices.
  let base = 0, asks = 0, considers = 0, drafts = 0, reviews = 0
  const walk = (segs: Segment[]): Piece[] => segs.flatMap((s): Piece[] => {
    if (!('text' in s)) {
      if (s.kind === 'ask') return [{ kind: 'ask', block: base++, ask: askOf(s, asks++) }]
      if (s.kind === 'draft') return [{ kind: 'ask', block: base++, ask: draftOf(s, drafts++) }]
      if (s.kind === 'run') return [{ kind: 'run', block: base++, title: s.title, command: commandOf(s), closed: s.closed }]
      if (s.kind === 'review') return [{ kind: 'review', block: base++, title: s.title, files: reviewFilesOf(s), n: ++reviews, pieces: walk([{ text: reviewTextOf(s) }]) }]
      const id = s.kind === 'consider' ? `c${++considers}` : ''
      return [{ kind: s.kind, title: s.title, id, block: base++, closed: s.closed, task: s.kind === 'consider' && isTask(s), critical: s.kind === 'consider' && isCritical(s), pieces: walk(s.body) }]
    }
    const tokens = marked.lexer(s.text)
    // marked.parse would run the extensions' token pass (code highlighting); lexer + parser don't.
    if (marked.defaults.walkTokens) void marked.walkTokens(tokens, marked.defaults.walkTokens)
    const out: Piece[] = []
    tokens.forEach((t: Token, i) => {
      if (t.type === 'space') return
      if (t.type === 'code' && /^ask\b/.test((t as Tokens.Code).lang ?? '')) {
        const c = t as Tokens.Code
        out.push({ kind: 'ask', block: base + i, ask: parseAskBody(c.lang ?? '', c.text, asks++) })
        return
      }
      // A paragraph of only ![caption](artifact:<name>@<n>): the artifact at that version, as the pane shows it.
      const img = t.type === 'paragraph' && (t as Tokens.Paragraph).tokens.length === 1 ? (t as Tokens.Paragraph).tokens[0] : undefined
      const art = img?.type === 'image' && /^artifact:([\w.-]+)(?:@(\d+))?$/.exec((img as Tokens.Image).href)
      if (art) {
        out.push({ kind: 'artifact', block: base + i, name: art[1], v: art[2] ? Number(art[2]) : undefined })
        return
      }
      const list = Object.assign([t], { links: tokens.links })
      out.push({ kind: 'html', block: base + i, html: served(DOMPurify.sanitize(marked.parser(list) as string)) })
    })
    base += tokens.length
    return out
  })
  return walk(segmentsOf(text))
}

// While streaming, a tag that is only half there yet stays hidden.
const trimPartialTag = (text: string) => text.replace(/\n\s*<\/?[a-z]*(\s[^>\n]*)?$/i, '')

export type Reaction = { anchor: Anchor; emoji: string; whole: boolean; quote: string }
type Props = { sid: string; msg: string; text: string; items?: Map<string, TrackedItem>; sent?: Anchor[]; reacts?: Reaction[]; live?: boolean }
// within: the item to consider that the content sits in.
type Ctx = { sid: string; msg: string; items: Map<string, TrackedItem>; live: boolean; within?: { key: string; label: string; status: string } }
const NO_ITEMS = new Map<string, TrackedItem>()

const NO_REACTS: Reaction[] = []
export const AssistantMessage = memo(function AssistantMessage({ sid, msg, text, items = NO_ITEMS, sent = [], reacts = NO_REACTS, live = false }: Props) {
  useStore()
  const pieces = useMemo(() => piecesOf(live ? trimPartialTag(text) : text), [text, live])
  const root = useRef<HTMLDivElement>(null)
  // Comments and reactions to a selection are highlighted; reactions to a whole paragraph are not.
  const notes = live ? [] : draftsOf(sid).filter((d): d is NoteDraft => d.kind === 'note' && d.anchor.msg === msg && !(d.whole && d.reaction))
  const drafted = live ? [] : draftsOf(sid).filter((d): d is NoteDraft => d.kind === 'note' && d.anchor.msg === msg && !!d.reaction)
  const noteKey = notes.map((n) => n.id + JSON.stringify(n.anchor.pieces)).join('|')
  const sentAll = [...sent, ...reacts.filter((r) => !r.whole).map((r) => r.anchor)]
  const sentKey = JSON.stringify(sentAll)

  useLayoutEffect(() => {
    const el = root.current
    if (!el || live) return
    setHighlights(`d:${sid}:${msg}`, 'draft', notes.flatMap((n) => rangesFor(n.anchor, el)))
    setHighlights(`s:${sid}:${msg}`, 'sent', sentAll.flatMap((a) => rangesFor(a, el)))
    return () => { setHighlights(`d:${sid}:${msg}`, 'draft', []); setHighlights(`s:${sid}:${msg}`, 'sent', []) }
  }, [noteKey, sentKey, pieces, sid, msg, live])
  useCodeCopy(root, live)
  useBlockCopy(root, pieces, live)
  useReveal(root, sid, pieces, live)

  return (
    <div className={`assistant-text md${live ? ' streaming' : ''}`} ref={root} {...(live ? {} : { 'data-msg': msg, 'data-sid': sid })}>
      <Pieces c={{ sid, msg, items, live }} pieces={pieces} />
      {!live && !state.share && <LeftRail sid={sid} root={root} reacts={reacts} drafted={drafted} />}
    </div>
  )
})

// The middle of an element's first line of text, from the top of the message:
// reactions and the reaction button sit centred on it. On an image or a video,
// level with its top, where a first line would be.
function lineMid(r: Range | null, root: HTMLElement): number | null {
  const box = r?.getClientRects()[0]
  const h = box && (mediaIn(r!) ? Math.min(box.height, 24) : box.height)
  return box ? Math.round(box.top + h! / 2 - root.getBoundingClientRect().top) : null
}
const contentsOf = (el: HTMLElement) => { const r = document.createRange(); r.selectNodeContents(el); return r }
// The outermost closed <details> that hides a passage, if any (its summary shows).
function closedAround(anchor: Anchor, root: HTMLElement): HTMLDetailsElement | null {
  const n = rangesFor(anchor, root)[0]?.startContainer
  const at = n?.nodeType === 1 ? n as Element : n?.parentElement
  let out: HTMLDetailsElement | null = null
  for (let d = at?.closest('details'); d && root.contains(d); d = d.parentElement?.closest('details'))
    if (!d.open && !d.querySelector(':scope > summary')?.contains(at!)) out = d
  return out
}

// Reactions sit at the left of their passage, one mark per passage; marks on
// one line form a row, the line's own (whole-paragraph) reaction nearest the
// text. The reaction button for the paragraph or list item level with the
// pointer sits on that mark, or left of the row if there is none, so nothing
// moves. Hovering a mark shows its passage; clicking one (or a selection's
// highlight) opens the comment card for that passage, where its reactions can
// be added to or taken off. A reaction inside an item to consider counts as a
// reply to it. Marks for passages in a closed <details> clump into one mark on
// its summary; a click on it opens the details.
type RailItem = { key: string; anchor: Anchor; quote: string; whole: boolean; emoji: string[]; drafts: NoteDraft[]; folded?: boolean }
const keyOf = (a: Anchor) => JSON.stringify(a)
// A passage to react to: a whole paragraph or list item, or a selection. A held
// press (or a drag up) on its button or mark opens its row of emoji.
type Pick = { id: string; anchor: Anchor; quote: string; whole: boolean }
const pickOf = (anchor: Anchor, quote: string, whole: boolean): Pick => ({ id: `${whole ? 'w' : 's'}${keyOf(anchor)}`, anchor, quote, whole })

function LeftRail({ sid, root, reacts, drafted }: { sid: string; root: React.RefObject<HTMLDivElement | null>; reacts: Reaction[]; drafted: NoteDraft[] }) {
  const [rows, setRows] = useState<{ top: number; items: RailItem[] }[]>([])
  const [target, setTarget] = useState<{ el: HTMLElement; key: string; anchor: Anchor; top: number } | null>(null)
  // The passage (Pick.id) whose row of emoji, or emoji search, is open.
  const [row, setRow] = useState<string | null>(null)
  const [search, setSearch] = useState<string | null>(null)
  const busy = useRef(false)
  // From the press on, so a drag up to the row doesn't pass the target to the line above.
  const pressing = useRef(false)
  busy.current = !!row || !!search || pressing.current
  const targetRef = useRef(target)
  targetRef.current = target

  // ---- the marks
  const items = (() => {
    const by = new Map<string, RailItem>()
    const add = (anchor: Anchor, emoji: string, whole: boolean, quote: string, draft?: NoteDraft) => {
      // A passage's whole-line reactions and its selection reactions are two marks.
      const k = keyOf(anchor), id = pickOf(anchor, quote, whole).id
      const it = by.get(id) ?? { key: k, anchor, quote, whole, emoji: [], drafts: [] }
      if (!it.emoji.includes(emoji)) it.emoji.push(emoji)
      if (draft) it.drafts.push(draft)
      by.set(id, it)
    }
    for (const r of reacts) add(r.anchor, r.emoji, r.whole, r.quote)
    for (const d of drafted) add(d.anchor, d.text.trim(), !!d.whole, d.quote, d)
    return [...by.values()]
  })()
  const place = () => {
    const el = root.current
    if (!el) return
    const at = new Map<number, RailItem[]>()
    for (const it of items) {
      const shut = closedAround(it.anchor, el)
      const top = lineMid(shut ? contentsOf(shut.querySelector('summary')!) : rangesFor(it.anchor, el)[0] ?? null, el)
      if (top != null) at.set(top, [...(at.get(top) ?? []), shut ? { ...it, folded: true } : it])
    }
    const next = [...at].map(([top, its]) => ({ top, items: its.sort((a, b) => Number(b.whole) - Number(a.whole)) }))
    setRows((prev) => JSON.stringify(prev) === JSON.stringify(next) ? prev : next)
  }
  const placeRef = useRef(place)
  placeRef.current = place
  useLayoutEffect(place)

  // Without room left of the text, a row's emoji pile up (overlap), just enough to stay clear of the sidebar.
  // Hovering a pile fans it out: its emoji step up across a few levels (--y), so that neighbours no longer cover each other,
  // and its box grows (--fan levels up and down) to hold them.
  const pile = () => {
    const el = root.current, pane = el?.closest('.transcript')
    if (!el || !pane) return
    const min = pane.getBoundingClientRect().left + 4
    // Rows on lines closer together than a row is high (an item's title and the line under it) would overlap:
    // each such row moves down (--nudge) until it is 2px below the row above it.
    let below = -Infinity
    for (const r of [...el.querySelectorAll<HTMLElement>(':scope > .rail-row')].sort((a, b) => a.offsetTop - b.offsetTop)) {
      r.style.removeProperty('--nudge')
      const top = r.offsetTop - r.offsetHeight / 2
      if (top < below) r.style.setProperty('--nudge', `${below - top}px`)
      below = Math.max(top, below) + r.offsetHeight + 2
    }
    for (const r of el.querySelectorAll<HTMLElement>(':scope > .rail-row')) {
      r.style.removeProperty('--pile')
      for (const e of r.querySelectorAll<HTMLElement>('.em, .react-mark, .ack-btn')) { e.style.removeProperty('--y'); e.style.removeProperty('--fan') }
      const over = min - r.getBoundingClientRect().left
      const ems = r.querySelectorAll<HTMLElement>('.em + .em')
      if (over <= 0 || !ems.length) continue
      // At least a third of each emoji stays in view.
      const w = ems[0].offsetWidth, pile = Math.min(over / ems.length, w * 2 / 3)
      r.style.setProperty('--pile', `${-pile}px`)
      // As many levels as it takes for an emoji to clear the one on the same level before it.
      const k = Math.min(3, Math.ceil(w / (w - pile)))
      if (k > 1) for (const m of r.querySelectorAll<HTMLElement>('.react-mark, .ack-btn')) {
        const ems = m.querySelectorAll<HTMLElement>('.em'), n = Math.min(k, ems.length)
        if (n < 2) continue
        ems.forEach((e, i) => e.style.setProperty('--y', `${(n - 1) / 2 - i % n}`))
        m.style.setProperty('--fan', `${(n - 1) / 2}`)
      }
    }
  }
  const pileRef = useRef(pile)
  pileRef.current = pile
  useLayoutEffect(pile)
  useEffect(() => {
    const el = root.current
    const again = () => { placeRef.current(); pileRef.current() }
    const ro = new ResizeObserver(again)
    if (el) ro.observe(el)
    // <details> fire toggle on themselves only, so listen in the capture phase.
    el?.addEventListener('toggle', again, true)
    return () => { ro.disconnect(); el?.removeEventListener('toggle', again, true) }
  }, [root])

  // ---- which paragraph or list item the pointer is level with
  useEffect(() => {
    const el = root.current
    const zone = el?.closest('.transcript-inner')
    if (!el || !zone) return
    let raf = 0
    const level = (x: number, y: number, at: EventTarget | null) => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        if (busy.current || (at as Element | null)?.closest?.('.rail-row')) return
        const r = el.getBoundingClientRect()
        if (y < r.top || y > r.bottom || x < r.left - 72 || x > r.right) { if (targetRef.current) setTarget(null); return }
        // The innermost one level with the pointer; between two, keep the last.
        let best: HTMLElement | null = null, h = Infinity
        for (const c of el.querySelectorAll<HTMLElement>('li, [data-block]')) {
          // A passage in a closed <details> is laid out on top of what follows it.
          if (c.closest('details:not([open])') || (c.closest('.ask-card') && !c.closest('.ask-q'))) continue
          const b = c.getBoundingClientRect()
          if (y >= b.top - 2 && y <= b.bottom + 2 && b.height < h) { best = c; h = b.height }
        }
        if (!best || best === targetRef.current?.el) return
        const anchor = anchorFromRange(contentsOf(best), el)
        const top = anchor && lineMid(rangesFor(anchor, el)[0] ?? null, el)
        if (anchor && top != null) setTarget({ el: best, key: keyOf(anchor), anchor, top })
      })
    }
    const move = (e: MouseEvent) => level(e.clientX, e.clientY, e.target)
    // On a touch screen the button shows as the finger goes down, so a passage you scroll into view has it already.
    const touch = (e: TouchEvent) => { if (e.touches.length === 1) level(e.touches[0].clientX, e.touches[0].clientY, e.target) }
    const leave = () => { if (!busy.current) setTarget(null) }
    zone.addEventListener('mousemove', move as EventListener)
    zone.addEventListener('touchstart', touch as EventListener, { passive: true })
    zone.addEventListener('mouseleave', leave)
    return () => { cancelAnimationFrame(raf); zone.removeEventListener('mousemove', move as EventListener); zone.removeEventListener('touchstart', touch as EventListener); zone.removeEventListener('mouseleave', leave) }
  }, [root])

  // Clicking the highlight of a reaction to a selection opens a comment on it.
  useEffect(() => {
    const el = root.current
    if (!el) return
    const click = (e: MouseEvent) => {
      if (!getSelection()?.isCollapsed) return
      const hit = itemsRef.current.find((it) => !it.whole && onPassage(rangesFor(it.anchor, el), e.clientX, e.clientY))
      if (hit) commentOn(hit.anchor, hit.quote, false)
    }
    el.addEventListener('click', click)
    return () => el.removeEventListener('click', click)
  }, [root])
  const itemsRef = useRef(items)
  itemsRef.current = items

  useEffect(() => {
    if (!row) return
    const down = (e: MouseEvent) => { if (!(e.target as Element).closest('.rail-row, .ack-pop')) setRow(null) }
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [row])

  // The item to consider a passage sits in, if any.
  const itemOf = (anchor: Anchor) => {
    const n = root.current && rangesFor(anchor, root.current)[0]?.startContainer
    return (n?.nodeType === 1 ? n as Element : n?.parentElement)?.closest<HTMLElement>('[data-item]')?.dataset.item
  }
  // As a selection does (Transcript.tsx), which works on iOS: a hidden field takes the focus in the
  // touch (holdKeyboard), and the card's field takes it over once the card shows.
  const commentOn = (anchor: Anchor, quote: string, whole: boolean) => {
    focusPassage(sid, null)
    holdKeyboard()
    const k = keyOf(anchor)
    const open = draftsOf(sid).find((d): d is NoteDraft => d.kind === 'note' && !d.reaction && keyOf(d.anchor) === k)
    // Without a gutter the card shows only after the render that state.focus causes, so focus it on the next frame.
    if (open) { state.focus = open.id; changed(); requestAnimationFrame(() => focusField(document.querySelector<HTMLElement>(`.note-card[data-id="${open.id}"] .ri-edit`))); return }
    const itemKey = itemOf(anchor)
    addDraft(sid, { id: uid(), kind: 'note', anchor, quote, text: '', images: [], createdAt: Date.now(), ...(whole ? { whole } : {}), ...(itemKey ? { itemKey } : {}) })
  }
  // A passage's own reactions not sent yet, and toggling one.
  const mine = (p: Pick) => draftsOf(sid).filter((d): d is NoteDraft => d.kind === 'note' && !!d.reaction && !!d.whole === p.whole && keyOf(d.anchor) === keyOf(p.anchor))
  // Only reactions that draw something: a stray variation selector or skin tone would show as an empty ring.
  const onOf = (p: Pick) => new Set(mine(p).map((d) => d.text.trim()).filter((e) => /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(e)))
  const toggle = (emoji: string, p: Pick) => {
    setRow(null); setSearch(null)
    if (emoji === '+') return setSearch(p.id)
    if (emoji === 'comment') return commentOn(p.anchor, p.quote, p.whole)
    if (emoji === 'remove') { for (const d of mine(p)) removeDraft(sid, d.id); return }
    const cur = mine(p).find((d) => d.text.trim() === emoji)
    if (cur) return removeDraft(sid, cur.id)
    usedEmoji(emoji)
    const itemKey = itemOf(p.anchor)
    addDraft(sid, { id: uid(), kind: 'note', anchor: p.anchor, quote: p.quote, text: emoji, images: [], createdAt: Date.now(), reaction: true, ...(p.whole ? { whole: true } : {}), ...(itemKey ? { itemKey } : {}) })
    state.focus = null
  }
  // A click does `click`; a held press, or a drag up, opens the passage's row.
  const press = (p: Pick, click: () => void) => (e: React.PointerEvent) => {
    e.preventDefault()
    pressing.current = busy.current = true
    let held = false
    const y0 = e.clientY
    const open = () => { if (!held) { held = true; setRow(p.id) } }
    const timer = setTimeout(open, 200)
    const move = (m: PointerEvent) => { if (y0 - m.clientY > 4) open() }
    const up = (u: PointerEvent) => {
      document.removeEventListener('pointerup', up)
      document.removeEventListener('pointermove', move)
      clearTimeout(timer)
      pressing.current = false
      // A held press opened the row, which keeps it busy; a click did not.
      if (!held) busy.current = false
      // iOS brings up the keyboard (for a comment card) only from a touchend, not a pointerup.
      if (!held && u.pointerType === 'touch') {
        let done = false
        const go = () => { if (!done) { done = true; document.removeEventListener('touchend', go); click() } }
        document.addEventListener('touchend', go)
        setTimeout(go, 300)
        return
      }
      if (!held) return click()
      // The press and the release are on different elements, so the browser sends the click to an
      // element around both, at the point of release. Without this, a highlight under that point
      // took the click and opened a comment on its own passage.
      const eat = (c: MouseEvent) => { c.stopPropagation(); c.preventDefault() }
      window.addEventListener('click', eat, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', eat, true), 300)
      const over = (document.elementFromPoint(u.clientX, u.clientY) as Element | null)?.closest<HTMLElement>('[data-emoji]')
      if (over) toggle(over.dataset.emoji!, p)
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
  }

  // On a touch screen the button shows only once a finger is on the passage. So a press where it
  // will be (a box the button's size, level with the first line of a paragraph or list item)
  // shows it and works as a press on it at once: a tap adds your last emoji, a hold or a drag up
  // opens the row. Not within 20px of the screen's left edge, where a swipe opens the sessions.
  const pressAt = useRef<(t: NonNullable<typeof target>, e: PointerEvent) => void>(() => {})
  pressAt.current = (t, e) => {
    const own = itemsRef.current.find((it) => it.whole && it.key === t.key)
    const tp = pickOf(t.anchor, passageQuote(t.el), true)
    press(tp, () => own ? commentOn(own.anchor, own.quote, true) : toggle(lastEmoji(), tp))(e as unknown as React.PointerEvent)
  }
  useEffect(() => {
    const el = root.current
    const zone = el?.closest('.transcript-inner')
    if (!el || !zone) return
    const skip = (at: EventTarget | null) => !!(at as Element | null)?.closest?.('.rail-row, .ack-pop, button, a, input, textarea, .note-card')
    const hit = (x: number, y: number) => {
      const r = el.getBoundingClientRect()
      if (x < Math.max(20, r.left - 40) || x > r.left - 4 || y < r.top - 14 || y > r.bottom) return null
      let best: { el: HTMLElement; key: string; anchor: Anchor; top: number } | null = null, h = Infinity
      for (const c of el.querySelectorAll<HTMLElement>('li, [data-block]')) {
        if (c.closest('details:not([open])') || (c.closest('.ask-card') && !c.closest('.ask-q'))) continue
        const b = c.getBoundingClientRect()
        if (y < b.top - 14 || y > b.top + 40 || b.height >= h) continue
        const anchor = anchorFromRange(contentsOf(c), el)
        const top = anchor && lineMid(rangesFor(anchor, el)[0] ?? null, el)
        if (anchor && top != null && Math.abs(y - r.top - top) <= 14) { best = { el: c, key: keyOf(anchor), anchor, top }; h = b.height }
      }
      return best
    }
    const down = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || busy.current || skip(e.target)) return
      const t = hit(e.clientX, e.clientY)
      if (!t) return
      flushSync(() => setTarget(t))
      pressAt.current(t, e)
    }
    // No scroll from there, as from the button itself.
    const hold = (e: TouchEvent) => { if (e.touches.length === 1 && !skip(e.target) && hit(e.touches[0].clientX, e.touches[0].clientY)) e.preventDefault() }
    zone.addEventListener('pointerdown', down as EventListener)
    zone.addEventListener('touchstart', hold as EventListener, { passive: false })
    return () => { zone.removeEventListener('pointerdown', down as EventListener); zone.removeEventListener('touchstart', hold as EventListener) }
  }, [root])

  const all = target && !rows.some((r) => r.top === target.top) ? [...rows, { top: target.top, items: [] }] : rows
  // The row opens above its button, over the session's header, so the body of the page holds it
  // (the transcript's scroll would clip it). It opens below only when the top of the screen leaves
  // no room. The row and the remove button to its left stay inside the transcript's left and right
  // edges, clear of the sidebar. A scroll or a resize places it again.
  const pop = useRef<HTMLDivElement>(null), spot = useRef<HTMLSpanElement>(null)
  const placePop = () => {
    const el = pop.current, at = spot.current?.parentElement, pane = at?.closest('.transcript')
    if (!el || !at || !pane) return
    el.style.setProperty('--fs', getComputedStyle(at).getPropertyValue('--fs'))
    el.style.left = el.style.top = '0px'
    const a = at.getBoundingClientRect(), box = pane.getBoundingClientRect(), own = el.getBoundingClientRect()
    const kids = [...el.children].map((c) => c.getBoundingClientRect())
    const left = Math.min(...kids.map((r) => r.left)), right = Math.max(...kids.map((r) => r.right))
    const min = box.left + 8, max = box.right - 8
    let x = a.left - 6
    if (x + left < min) x = min - left
    else if (x + right > max) x = Math.max(max - right, min - left)
    const top = (parseFloat(getComputedStyle(el).scrollMarginTop) || 0) + 4
    const y = a.top - 4 - own.height < top ? a.bottom + 4 : a.top - 4 - own.height
    el.style.left = `${x}px`
    el.style.top = `${y}px`
  }
  useLayoutEffect(placePop)
  useEffect(() => {
    if (!row) return
    const again = () => placePop()
    document.addEventListener('scroll', again, true)
    addEventListener('resize', again)
    return () => { document.removeEventListener('scroll', again, true); removeEventListener('resize', again) }
  }, [row])
  // A passage's row of emoji and its emoji search, when open.
  const popFor = (p: Pick) => {
    const on = onOf(p)
    return <>
      {row === p.id && <span ref={spot} hidden />}
      {row === p.id && createPortal(
        <div className="ack-pop" ref={pop}>
        {/* Takes your reactions off this passage: outside the row, so it can't be mistaken for an emoji. */}
        {on.size > 0 && <button className="ack-clear" data-emoji="remove" onClick={() => toggle('remove', p)}><XIcon size={14} /></button>}
        <div className="ack-row">
          {[...new Set([...on, ...topEmoji(8)])].slice(0, Math.max(8, on.size)).map((e) => <button key={e} data-emoji={e} className={on.has(e) ? 'on' : ''} onClick={() => toggle(e, p)}><span>{e}</span></button>)}
          <button className="more-emoji" data-emoji="+" onClick={() => toggle('+', p)}><span><PlusIcon size={17} /></span></button>
          <button className="more-emoji" data-emoji="comment" onClick={() => toggle('comment', p)}><span><CommentIcon size={17} /></span></button>
        </div>
        </div>, document.body,
      )}
      {search === p.id && <EmojiPicker onPick={(e) => toggle(e, p)} onClose={() => setSearch(null)} />}
    </>
  }
  return <>{all.map((r) => {
    const here = target?.top === r.top
    const own = here ? r.items.find((it) => it.whole && it.key === target!.key) : undefined
    const tp = here ? pickOf(target!.anchor, passageQuote(target!.el), true) : null
    const ack = tp && (
      <div key="ack" className="rail-ack">
        <button className={`ack-btn${onOf(tp).size ? ' on' : ''}${own ? ' over' : ''}`} aria-label={own ? 'Comment or change reactions' : 'React with last emoji'}
          // On a line with reactions, a click opens its comment card; on a bare line it adds your last emoji.
          onPointerDown={press(tp, () => own ? commentOn(own.anchor, own.quote, true) : toggle(lastEmoji(), tp))}
          onMouseEnter={() => focusPassage(sid, own ? { anchor: own.anchor } : null)} onMouseLeave={() => focusPassage(sid, null)}>
          <span>{own ? own.emoji.map((e) => <span key={e} className="em">{e}</span>) : lastEmoji()}</span>
        </button>
        {popFor(tp)}
      </div>
    )
    const folded = r.items.filter((it) => it.folded)
    return (
      <div key={r.top} className="rail-row" style={{ top: r.top }}>
        {folded.length > 0 && (
          <div key="folded" className="rail-ack">
            <button className={`react-mark${folded.some((it) => it.drafts.length) ? ' draft' : ''}`} aria-label="Open the details to show these reactions"
              onClick={() => { const d = root.current && closedAround(folded[0].anchor, root.current); if (d) d.open = true }}
            >{[...new Set(folded.flatMap((it) => it.emoji))].map((e) => <span key={e} className="em">{e}</span>)}</button>
          </div>
        )}
        {r.items.filter((it) => !it.folded).map((it) => {
          if (it === own) return ack
          const p = pickOf(it.anchor, it.quote, it.whole)
          return (
            <div key={it.key + it.whole} className="rail-ack">
              <button
                className={`react-mark${it.drafts.length ? ' draft' : ''}`}
                onMouseEnter={() => focusPassage(sid, { anchor: it.anchor })} onMouseLeave={() => focusPassage(sid, null)}
                onPointerDown={press(p, () => commentOn(it.anchor, it.quote, it.whole))}
              >{it.emoji.map((e) => <span key={e} className="em">{e}</span>)}</button>
              {popFor(p)}
            </div>
          )
        })}
        {here && !own && ack}
      </div>
    )
  })}</>
}

// A selection here starts a comment, so inline code (a URL, a password, an id) is
// hard to copy by hand: a click copies it. Its cursor says so (styles.css).
function useCodeCopy(root: React.RefObject<HTMLDivElement | null>, live: boolean) {
  useEffect(() => {
    const el = root.current
    if (!el || live) return
    const click = (e: MouseEvent) => {
      const code = (e.target as Element).closest<HTMLElement>('code')
      // Not code blocks, not code in a link, and not the end of a drag that selected some of it.
      // A path is a link to the Files pane instead (useReveal).
      if (!code || code.closest('pre, a') || code.classList.contains('file-link') || !el.contains(code) || !getSelection()?.isCollapsed) return
      void navigator.clipboard.writeText(code.textContent ?? '').then(() => {
        // A flash of the accent colour that fades.
        code.classList.add('copied')
        setTimeout(() => code.classList.remove('copied'), 150)
      })
    }
    el.addEventListener('click', click)
    return () => el.removeEventListener('click', click)
  }, [root, live])
}

// Each code block gets a copy button at its top right. The button holds only an
// icon, so the text of the message (which anchors comments) stays the same.
const COPY = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-.5a1 1 0 00-1-1h-6a1 1 0 00-1 1v6a1 1 0 001 1h.5"/></svg>'
const COPIED = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3 3 7-7"/></svg>'

function useBlockCopy(root: React.RefObject<HTMLDivElement | null>, pieces: Piece[], live: boolean) {
  useEffect(() => {
    const el = root.current
    if (!el || live) return
    // Not the command of a <run> card: it has its own Copy button.
    for (const pre of el.querySelectorAll<HTMLElement>('pre')) {
      if (pre.closest('.run-card') || pre.parentElement?.classList.contains('code-wrap')) continue
      const wrap = document.createElement('div')
      wrap.className = 'code-wrap'
      pre.replaceWith(wrap)
      wrap.append(pre)
      const b = document.createElement('button')
      b.className = 'code-copy'
      b.innerHTML = COPY
      let t = 0
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        void navigator.clipboard.writeText(pre.textContent ?? '').then(() => {
          b.innerHTML = COPIED
          b.classList.add('on')
          clearTimeout(t)
          t = window.setTimeout(() => { b.innerHTML = COPY; b.classList.remove('on') }, 1200)
        })
      })
      wrap.append(b)
    }
  }, [root, pieces, live])
}

// Inline code that names a file or folder on the session's machine opens it in the Files pane
// (FileBrowser.tsx), and on this machine it gets a folder button after it too: a click shows it
// in Finder. Only paths that are there get them. A link to a path opens it in the pane too.
const PATH = /^(?:(?:~|\.{0,2})\/[^\n<>"|*?]*|[\w.@+-]+\/[^\s<>"|*?]*|[\w@+-][\w.@+-]*\.\w{1,8}(?::\d+){0,2})$/
const LOCAL_HREF = /^(?![a-z][a-z0-9+.-]*:|\/\/|#|\/api\/)/i
const found = new Map<string, string | null>()   // machine + cwd + path → the full path, or null
const FOLDER = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M2 4.5V12a1 1 0 001 1h10a1 1 0 001-1V6a1 1 0 00-1-1H8L6.5 3.5H3A1 1 0 002 4.5z"/></svg>'

function useReveal(root: React.RefObject<HTMLDivElement | null>, sid: string, pieces: Piece[], live: boolean) {
  useEffect(() => {
    const el = root.current
    if (!el || live || state.share) return
    for (const a of el.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      const href = a.getAttribute('href')!
      if (!LOCAL_HREF.test(href) || a.dataset.file) continue
      a.dataset.file = '1'
      a.addEventListener('click', (e) => { e.preventDefault(); openFile(sid, decodeURI(href.split('#')[0])) })
    }
    const machine = machineOf(sid)
    const cwd = state.sessions.find((s) => s.id === sid)?.cwd ?? '~'
    const key = (t: string) => `${machine}\n${cwd}\n${t}`
    const codes = [...el.querySelectorAll<HTMLElement>('code')].filter((c) => {
      const t = c.textContent?.trim() ?? ''
      return !c.closest('pre, a') && !c.classList.contains('file-link') && t.length < 400 && !t.includes('://') && PATH.test(t)
    })
    if (!codes.length) return
    let gone = false
    const add = () => {
      for (const c of codes) {
        const t = c.textContent!.trim()
        const abs = found.get(key(t))
        if (!abs || !c.isConnected || c.classList.contains('file-link')) continue
        c.classList.add('file-link')
        c.addEventListener('click', () => { if (getSelection()?.isCollapsed) openFile(sid, t) })
        if (machine !== LOCAL || state.web) continue
        const b = document.createElement('button')
        b.className = 'reveal'
        b.title = state.platform === 'darwin' ? 'Show in Finder' : 'Show in its folder'
        b.innerHTML = FOLDER
        b.addEventListener('click', (e) => { e.stopPropagation(); void api('/api/fs/reveal', 'POST', { path: abs }) })
        c.after(b)
      }
    }
    const ask = [...new Set(codes.map((c) => c.textContent!.trim()))].filter((t) => !found.has(key(t)))
    if (!ask.length) add()
    else void api<Record<string, string | null>>('/api/fs/exists', 'POST', { cwd, paths: ask }, machine).then((r) => {
      for (const t of ask) found.set(key(t), r[t] ?? null)
      if (!gone) add()
    }).catch(() => {})
    return () => { gone = true }
  }, [root, sid, pieces, live])
}

// The <details> you opened, so that one stays open when its message renders anew.
const opened = new Set<string>()

function Pieces({ c, pieces }: { c: Ctx; pieces: Piece[] }) {
  return <>{pieces.map((p) => {
    switch (p.kind) {
      case 'html': return <div key={p.block} data-block={p.block} className="md-block" dangerouslySetInnerHTML={{ __html: p.html }} />
      case 'ask': return <AskCard key={p.block} c={c} ask={p.ask} block={p.block} />
      case 'artifact': return <div key={p.block} data-block={p.block} className="md-block"><ArtifactFrame target={{ artifact: p.name, v: p.v }} inline /></div>
      case 'answer': return <div key={p.block} className="answer-block"><Pieces c={c} pieces={p.pieces} /></div>
      case 'details': return (
        <details key={p.block} className="more" open={opened.has(`${c.sid}:${c.msg}:${p.block}`)}
          onToggle={(e) => { const k = `${c.sid}:${c.msg}:${p.block}`; if (e.currentTarget.open) opened.add(k); else opened.delete(k) }}>
          <summary dangerouslySetInnerHTML={{ __html: renderInline(p.title || 'More details') }} />
          <div className="more-body"><Pieces c={c} pieces={p.pieces} /></div>
        </details>
      )
      case 'consider': return <ConsiderCard key={p.block} c={c} p={p} />
      case 'review': return <ReviewCard key={p.block} sid={c.sid} group={`${c.msg}:r${p.n}`} title={p.title} block={p.block} files={p.files} live={c.live}><Pieces c={c} pieces={p.pieces} /></ReviewCard>
      case 'run': return <RunCard key={p.block} c={c} card={`${c.msg}:${p.block}`} block={p.block} title={p.title} command={p.command} ready={p.closed && !c.live} />
    }
  })}</>
}

function ConsiderCard({ c, p }: { c: Ctx; p: SectionPiece }) {
  const key = `${c.msg}:${p.id}`
  const item = c.items.get(key)
  const status = c.live ? 'live' : item?.status ?? 'open'
  const title = p.title || 'Item'
  const fold = useFold(status)
  const ro = !!state.share

  // Comment on the item: a margin card on its title, tied to the item.
  const comment = (e: React.MouseEvent) => {
    // A reply takes back a dismissal that has not gone yet.
    if (status === 'dismissing') undismissItem(c.sid, key)
    holdKeyboard()
    // A reaction in the item has no card to go to.
    const existing = draftsOf(c.sid).find((d): d is NoteDraft => d.kind === 'note' && d.itemKey === key && !d.reaction)
    if (existing) { focusField(document.querySelector<HTMLElement>(`.note-card[data-id="${existing.id}"] .ri-edit`)); return }
    const card = (e.currentTarget as HTMLElement).closest('.consider')!
    const head = card.querySelector<HTMLElement>('.consider-title')!
    const msgEl = card.closest<HTMLElement>('[data-msg]')!
    const r = document.createRange()
    r.selectNodeContents(head)
    const anchor = anchorFromRange(r, msgEl)
    if (!anchor) return
    for (const d of draftsOf(c.sid)) if (d.kind === 'note' && !d.text.trim() && !d.images.length) removeDraft(c.sid, d.id)
    addDraft(c.sid, { id: uid(), kind: 'note', anchor, quote: head.textContent ?? title, text: '', images: [], createdAt: Date.now(), itemKey: key })
  }

  return (
    <div className={`consider st-${status}${p.critical ? ' critical' : ''}${fold.cls}`} data-item={key}>
      <div className="consider-head">
        {fold.chevron}
        <div data-block={p.block} className="md-block consider-title" onClick={fold.onTitle} dangerouslySetInnerHTML={{ __html: renderInline(title) }} />
        {status === 'open' && !ro && !p.critical && <span className="item-actions"><button className="icon-btn" title="Dismiss" onClick={() => dismissItem(c.sid, key, title)}><XIcon size={13} /></button></span>}
        {(status === 'dismissing' || status === 'completing') && <span className="item-actions"><button className="icon-btn pop-in" title="Undo" onClick={() => undismissItem(c.sid, key)}><UndoIcon size={14} /></button></span>}
        <Done status={status} />
      </div>
      <div className="consider-body"><Pieces c={{ ...c, within: { key, label: title, status } }} pieces={p.pieces} /></div>
      {(status === 'open' || status === 'drafted' || (fold.aside && !fold.folded)) && !ro && (
        <div className="consider-foot">
          {p.task && <button className="reply-btn" onClick={() => markDone(c.sid, key, title)}><CheckIcon size={13} /> Done</button>}
          <button className="reply-btn item-reply" onMouseDown={(e) => e.preventDefault()} onClick={comment}><CommentIcon size={13} /> Reply</button>
        </div>
      )}
      {status === 'completing' && <DoneProblem sid={c.sid} itemKey={key} />}
    </div>
  )
}

// Marked done: room to say what went wrong, if anything.
function DoneProblem({ sid, itemKey }: { sid: string; itemKey: string }) {
  const d = draftsOf(sid).find((x): x is DoneDraft => x.kind === 'done' && x.key === itemKey)
  if (!d) return null
  return (
    <div className="done-problem">
      <button className="done-mark pop-in" title="Undo" onClick={() => undismissItem(sid, itemKey)}><CheckIcon size={12} /> Done</button>
      <input placeholder="Any problem?" value={d.text} onChange={(e) => setDoneText(sid, itemKey, e.target.value)} />
    </div>
  )
}

// A command Claude wants you to run: open it in a new Terminal window in the
// session's directory, or copy it.
function RunCard({ c, card, block, title, command, ready }: { c: Ctx; card: string; block: number; title: string; command: string; ready: boolean }) {
  const st = useStore()
  const [done, setDone] = useState('')
  const flash = (s: string) => { setDone(s); setTimeout(() => setDone(''), 2000) }
  const run = Object.values(st.runs).findLast((r) => r.sid === c.sid && r.card === card)
  // One run at a time: off while it starts and runs, and after it succeeds; a failure offers it again.
  const [starting, setStarting] = useState(false)
  const failed = run?.code != null && run.code !== 0
  const off = starting || (!!run && !failed)
  const start = () => {
    setStarting(true)
    api<{ token: string }>(`/api/sessions/${c.sid}/run`, 'POST', { command }).then(({ token }) => {
      state.runs[token] = { sid: c.sid, card, command, ...(c.within ? { item: { key: c.within.key, label: c.within.label } } : {}) }
      changed()
    }).finally(() => setStarting(false))
  }
  return (
    <div className="run-card">
      {/* Its title and command are one passage, to comment on or react to like a paragraph. */}
      <div data-block={block}>
        {title && <div className="run-title" dangerouslySetInnerHTML={{ __html: renderInline(title) }} />}
        <pre className="hljs" dangerouslySetInnerHTML={{ __html: highlight(command, st.platform === 'win32' ? 'powershell' : 'bash') }} />
      </div>
      {ready && command && (
        <div className="run-actions" onMouseUp={(e) => e.stopPropagation()}>
          {(st.platform === 'darwin' || st.platform === 'win32') && (
            <button className="primary" disabled={off} onClick={start}>
              <TerminalIcon size={13} /> {failed ? 'Run again' : 'Run in Terminal'}
            </button>
          )}
          <button onClick={() => navigator.clipboard.writeText(command).then(() => flash('Copied'))}>Copy</button>
          {done && <span className="muted">{done}</span>}
          {run && !done && (run.code == null ? <span className="muted">Running in Terminal…</span>
            : <span className={run.code === 0 ? 'run-ok' : 'run-bad'}>{run.code === 0 ? <CheckIcon size={12} /> : <XIcon size={12} />} Exit code {run.code}</span>)}
        </div>
      )}
      {run?.tail && <details className="run-out" onMouseUp={(e) => e.stopPropagation()}><summary>Output</summary><pre>{run.tail}</pre></details>}
    </div>
  )
}

// Text Claude drafted for you (a commit message, an email). Untouched, it stays
// open: Approve sends it back as it is (and greys it out), or edit it, and your
// edits go back. Edited, it offers only Restore (two clicks), which returns it
// to untouched, and a grey "Edited" that shows the original over the field
// while the pointer is on it.
function DraftCard({ c, ask, compact, block }: { c: Ctx; ask: Ask & { draft: string }; compact?: boolean; block?: number }) {
  const askKey = `${c.msg}:${ask.id}`
  const item = c.items.get(askKey)
  const status = c.live ? 'live' : item?.status ?? 'open'
  const draft = draftsOf(c.sid).find((d): d is AnswerDraft => d.kind === 'answer' && d.askKey === askKey)
  const answer = item?.reply?.kind === 'answer' ? item.reply : undefined
  const attrs = compact ? {} : { 'data-item': askKey }
  const [confirm, setConfirm] = useState(false)
  const [peek, setPeek] = useState(false)
  const fold = useFold(status, compact)
  useEffect(() => { if (!confirm) return; const t = setTimeout(() => setConfirm(false), 4000); return () => clearTimeout(t) }, [confirm])
  const title = compact ? {} : { 'data-block': block, onClick: fold.onTitle }
  const head = (mark: React.ReactNode) => (
    <div className="ask-row">
      {!compact && fold.chevron}
      <div className="ask-q draft-title" {...title} dangerouslySetInnerHTML={{ __html: renderInline(ask.question) }} />
      {mark}
    </div>
  )

  if (answer || state.share || (status !== 'open' && status !== 'drafted' && (!fold.aside || fold.folded || compact))) {
    const text = answer?.text ?? ask.draft
    return (
      <div className={`ask-card draft-card ${answer ? 'answered' : `st-${status}`}${fold.cls}`} {...attrs}>
        {head(<>
          {answer && <span className="muted draft-how">{answer.draft === 'edited' ? 'Edited' : 'Approved'}</span>}
          {status === 'dismissing' && <button className="icon-btn pop-in" title="Undo" onClick={() => undismissItem(c.sid, askKey)}><UndoIcon size={14} /></button>}
          <Done status={answer ? 'answered' : status} />
        </>)}
        {!compact && !fold.aside && <div className="draft-text md" dangerouslySetInnerHTML={{ __html: renderText(text) }} />}
      </div>
    )
  }

  const patch = (p: Partial<AnswerDraft>) => {
    reviveItem(c.sid, askKey)
    if (draft) updateDraft(c.sid, draft.id, p)
    else { state.drafts[c.sid] = [...draftsOf(c.sid), { id: uid(), kind: 'answer', askKey, question: ask.question, choices: [], text: ask.draft, images: [], createdAt: Date.now(), original: ask.draft, ...p }]; changed() }
  }
  const text = draft?.text ?? ask.draft
  const edited = text.trim() !== ask.draft.trim()
  const approved = !edited && !!draft?.approved
  return (
    <div className={`ask-card draft-card${approved || edited ? ' queued' : ''}${approved ? ' approved' : ''}${fold.cls}`} {...attrs}>
      {head(status === 'open' ? <button className="icon-btn" title="Dismiss" onClick={() => dismissItem(c.sid, askKey, ask.question)}><XIcon size={13} /></button> : fold.aside && <AsideMark sid={c.sid} itemKey={askKey} status={status} />)}
      {/* An edit ends an approval: the edits are what goes back. */}
      <div className="draft-field">
        <RichInput value={text} onChange={(t) => patch({ text: t, approved: false })} images={[]} onImages={() => {}} placeholder="Draft" minRows={2} />
        {edited && peek && <Original text={ask.draft} />}
      </div>
      <div className="draft-actions">
        {!edited && (
          <button className={`reply-btn draft-approve${approved ? ' on' : ''}`} title={approved ? 'Sends as is with your next message. Click to undo' : 'Send as is with your next message'} onClick={() => patch({ approved: !approved })}>
            <CheckIcon size={13} /> {approved ? 'Approved' : 'Approve'}
          </button>
        )}
        {edited && (
          <button className={`reply-btn${confirm ? ' draft-confirm' : ''}`} title="Restore Claude's original text" onClick={() => {
            if (!confirm) return setConfirm(true)
            setConfirm(false)
            if (draft) removeDraft(c.sid, draft.id)
          }}><UndoIcon size={13} /> {confirm ? 'Restore the original?' : 'Restore'}</button>
        )}
        {edited && <span className="muted draft-edited" onMouseEnter={() => setPeek(true)} onMouseLeave={() => setPeek(false)}>Edited</span>}
      </div>
    </div>
  )
}

// The original draft, drawn the way the field draws it, laid over the field.
function Original({ text }: { text: string }) {
  const el = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { renderLive(el.current!, text) }, [text])
  return <div ref={el} className="ri-edit draft-orig" />
}

export function AskCard({ c, ask, compact, block }: { c: Ctx; ask: Ask; compact?: boolean; block?: number }) {
  return ask.draft != null ? <DraftCard c={c} ask={ask as Ask & { draft: string }} compact={compact} block={block} /> : <QuestionCard c={c} ask={ask} compact={compact} block={block} />
}

function QuestionCard({ c, ask, compact, block }: { c: Ctx; ask: Ask; compact?: boolean; block?: number }) {
  const askKey = `${c.msg}:${ask.id}`
  const item = c.items.get(askKey)
  const status = c.live ? 'live' : item?.status ?? 'open'
  const draft = draftsOf(c.sid).find((d): d is AnswerDraft => d.kind === 'answer' && d.askKey === askKey)
  const question = useMemo(() => DOMPurify.sanitize(marked.parse(ask.question, { async: false }) as string), [ask.question])
  const answer = item?.reply?.kind === 'answer' ? item.reply : undefined
  const label = ask.question.split('\n')[0]
  const attrs = compact ? {} : { 'data-item': askKey }
  const fold = useFold(status, compact)
  // Its own block, so a passage in it takes comments and reactions.
  const title = compact ? {} : { 'data-block': block, onClick: fold.onTitle }

  if (answer) {
    return (
      <div className="ask-card answered" {...attrs}>
        <div className="ask-row">
          <div className="ask-q" {...title} dangerouslySetInnerHTML={{ __html: question }} />
          <Done status="answered" />
        </div>
        <div className="ask-answer">
          <span className="muted ask-who">{state.share ? 'Answer:' : 'You:'}</span>{' '}
          {answer.choices?.length ? <b>{answer.choices.join('; ')}</b> : null} {answer.text}
          <Thumbs images={answer.images} />
        </div>
      </div>
    )
  }
  if (state.share || (status !== 'open' && status !== 'drafted' && (!fold.aside || fold.folded || compact))) {
    return (
      <div className={`ask-card st-${status}${fold.cls}`} {...attrs}>
        <div className="ask-row">
          {!compact && fold.chevron}
          <div className="ask-q" {...title} dangerouslySetInnerHTML={{ __html: question }} />
          <AsideMark sid={c.sid} itemKey={askKey} status={status} />
        </div>
        {(status === 'live' || (state.share && !fold.folded)) && ask.options.length > 0 && <div className="ask-options">{ask.options.map((o) => <span key={o} className="chip static">{o}</span>)}</div>}
      </div>
    )
  }

  const choices = draft?.choices ?? []
  function patch(p: Partial<AnswerDraft>) {
    reviveItem(c.sid, askKey)
    const list = draftsOf(c.sid)
    if (draft) updateDraft(c.sid, draft.id, p)
    else {
      state.drafts[c.sid] = [...list, { id: uid(), kind: 'answer', askKey, question: ask.question, choices: [], text: '', images: [], createdAt: Date.now(), ...p }]
      changed()
    }
  }
  const toggle = (o: string) => patch({ choices: choices.includes(o) ? choices.filter((x) => x !== o) : [...choices, o] })

  return (
    <div className={`ask-card${status === 'drafted' ? ' queued' : ''}${fold.cls}`} {...attrs}>
      <div className="ask-row">
        {!compact && fold.chevron}
        <div className="ask-q" {...title} dangerouslySetInnerHTML={{ __html: question }} />
        {fold.aside && <AsideMark sid={c.sid} itemKey={askKey} status={status} />}
        {status === 'open' && <button className="icon-btn" title="Dismiss" onClick={() => { if (draft) removeDraft(c.sid, draft.id); dismissItem(c.sid, askKey, label) }}><XIcon size={13} /></button>}
      </div>
      {ask.options.length > 0 && (
        <div className="ask-options">
          {ask.options.map((o) => <button key={o} className={`chip${choices.includes(o) ? ' on' : ''}`} onClick={() => toggle(o)}>{o}</button>)}
        </div>
      )}
      <RichInput
        value={draft?.text ?? ''}
        onChange={(text) => patch({ text })}
        images={draft?.images ?? []}
        onImages={(images) => patch({ images })}
        placeholder="Answer"
        minRows={1}
      />
    </div>
  )
}
