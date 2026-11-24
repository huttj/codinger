// Comments on an artifact page, from inside the page. The artifact server adds this file to
// each page that Codinger's preview pane shows (server/artifacts.ts), after Marginer's text
// anchoring (web/src/vendor/anchor.ts), as one script: so it uses nothing else from outside.
// The page runs on another origin than Codinger, so Codinger cannot read it: this script
// finds what you comment on and paints the highlights, and Codinger's page draws the cards
// over the frame (web/src/components/ArtifactNotes.tsx). They talk over postMessage.
//
// In comment mode (the pane's Comment button, or a tap on Option alone) a selection of text
// starts a comment, and a click starts one on what it hits, the nearest mark around it (a block
// of text such as a paragraph or a heading, or an element with data-pid, aria-label or
// data-label) first; the page does not get the click.
// Out of it the page gets its clicks and selections as usual, and an Option-click (Alt) or a
// selection made with Option held starts one comment. On a touch screen a long press on a
// mark starts one.

import type { ArtifactAnchor } from '../../../shared/types.ts'
import { occurrenceOf, resolveNthQuote } from '../vendor/anchor.ts'

declare const CODINGER_APP: string

type Mark = { id: string; kind: 'draft' | 'sent'; anchor: ArtifactAnchor }
type Box = { left: number; top: number; right: number; bottom: number; last: { left: number; right: number; bottom: number }; out?: boolean }

export function startNotes() {
  const send = (m: Record<string, unknown>) => parent.postMessage({ codinger: 'notes', ...m }, CODINGER_APP)
  // A card in Codinger takes the focus for a comment, but Chrome lets Codinger's page take it
  // from this frame only when the frame gives it back first.
  const handBack = () => { try { parent.focus() } catch { /* not allowed */ } }
  const UI = 'data-codinger-ui'
  const isOurs = (n: EventTarget | null) => n instanceof Element && !!n.closest(`[${UI}]`)
  const at = (n: Node) => (n.nodeType === 1 ? n as Element : n.parentElement)

  // ---- where a thing is ----

  const pidOf = (el: Element | null) => el?.closest<Element>('[data-pid]') ?? null
  const clip = (s: string, n: number) => (s = s.replace(/\s+/g, ' ').trim()).length > n ? s.slice(0, n - 1) + '…' : s
  // What an element says: its label, the <title> of an SVG shape, the heading of a card, else its text.
  const labelOf = (el: Element) => clip(
    el.getAttribute('aria-label') || el.getAttribute('data-label')
      || (el instanceof SVGElement ? el.querySelector(':scope > title')?.textContent : '')
      || el.querySelector('h1, h2, h3, h4, h5, h6')?.textContent
      || (el instanceof HTMLElement ? el.innerText : el.textContent) || el.getAttribute('alt') || '', 200)
  // A CSS path from root (left out) down to el.
  const pathOf = (el: Element, root: Element) => {
    const steps: string[] = []
    for (let e: Element | null = el; e && e !== root && e !== document.documentElement; e = e.parentElement) {
      if (e.id && document.querySelectorAll(`#${CSS.escape(e.id)}`).length === 1) { steps.unshift(`#${CSS.escape(e.id)}`); return steps.join(' > ') }
      const tag = e.localName
      const same = e.parentElement ? [...e.parentElement.children].filter((c) => c.localName === tag) : []
      steps.unshift(same.length > 1 ? `${CSS.escape(tag)}:nth-of-type(${same.indexOf(e) + 1})` : CSS.escape(tag))
    }
    return steps.join(' > ')
  }
  const elementAnchor = (el: Element): Omit<ArtifactAnchor, 'artifact'> => {
    const named = pidOf(el)
    const out: Omit<ArtifactAnchor, 'artifact'> = { tag: el instanceof SVGElement && el.localName !== 'svg' ? `svg ${el.localName}` : el.localName, label: labelOf(el) }
    if (named) out.pid = named.getAttribute('data-pid')!
    if (named !== el) out.path = pathOf(el, named ?? document.body)
    return out
  }
  const elementOf = (a: ArtifactAnchor): Element | null => {
    let root: Element | null = document.body
    try {
      // A path from an element with an id starts at that id.
      if (a.path?.startsWith('#')) return document.querySelector(a.path)
      if (a.pid) root = document.querySelector(`[data-pid="${CSS.escape(a.pid)}"]`)
      if (root && a.path) return root.querySelector(`:scope > ${a.path}`)
    } catch { return null }
    return root
  }
  const rangeOf = (a: ArtifactAnchor): Range | null => {
    const root = elementOf(a)
    return root && a.text ? resolveNthQuote(a.text.quote, a.text.nth, root) : null
  }

  // ---- starting a comment ----

  const MARK = '[data-pid], [aria-label], [data-label]'
  const SHAPE = 'rect, circle, ellipse, path, polygon, polyline, line, img, canvas, video'
  const CONTROL = 'a, button, input, select, textarea, label, summary, option, [contenteditable], [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="slider"]'
  // A block of text (a paragraph, a heading, an item, a cell) is a mark of its own, also inside a
  // larger mark: the pointer on a paragraph picks the paragraph, not the whole section around it.
  const TEXT = 'p, h1, h2, h3, h4, h5, h6, li, dt, dd, blockquote, pre, figcaption, caption, td, th'
  // An element with other marks or blocks of text in it (a section, a card) is not a mark: a box
  // over all of it only distracts. Its parts are marks.
  const INNER = `${MARK}, ${TEXT}`
  const markAt = (t: Element, any: boolean): Element | null => {
    if (isOurs(t) || (!any && t.closest(CONTROL))) return null
    let el = t.closest(INNER)
    if (el?.querySelector(INNER)) el = null
    el = el ?? (t.matches(SHAPE) ? t : null) ?? (any && !t.querySelector(INNER) ? t : null)
    return el && el !== document.body && el !== document.documentElement ? el : null
  }
  const boxOf = (rects: DOMRect[]): Box | null => {
    const rs = rects.filter((r) => r.width || r.height)
    if (!rs.length) return null
    const l = rs[rs.length - 1]
    return { left: Math.min(...rs.map((r) => r.left)), top: Math.min(...rs.map((r) => r.top)), right: Math.max(...rs.map((r) => r.right)), bottom: Math.max(...rs.map((r) => r.bottom)), last: { left: l.left, right: l.right, bottom: l.bottom } }
  }
  // The part of the window where an element shows: inside each element around it that clips
  // what overflows it (a table that scrolls in a box, for one). Null when none of it shows.
  type Clip = { left: number; top: number; right: number; bottom: number }
  // The sticky headers of a box that scrolls: its own children, and the head of a table in it.
  // Found once for each box, and again when the page changes.
  let sticky = new WeakMap<Element, Element[]>()
  const stickyIn = (p: Element) => {
    let list = sticky.get(p)
    if (!list) {
      list = [...p.children, ...p.querySelectorAll(':scope > table > thead, :scope > table > thead > tr > th')].filter((e) => getComputedStyle(e).position === 'sticky')
      sticky.set(p, list)
    }
    return list
  }
  const clipOf = (el: Element | null): Clip | null => {
    let c: Clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
    for (let p = el?.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const cs = getComputedStyle(p)
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue
      const r = p.getBoundingClientRect()
      const left = r.left + p.clientLeft, top = r.top + p.clientTop
      c = { left: Math.max(c.left, left), top: Math.max(c.top, top), right: Math.min(c.right, left + p.clientWidth), bottom: Math.min(c.bottom, top + p.clientHeight) }
      // A sticky header at the top of the box covers what scrolls under it.
      for (const h of stickyIn(p)) {
        const hr = h.getBoundingClientRect()
        if (h !== el && !h.contains(el) && hr.top <= c.top + 1 && hr.bottom > c.top) c.top = hr.bottom
      }
      if (cs.position === 'fixed') break
    }
    return c.right > c.left && c.bottom > c.top ? c : null
  }
  // Draw a box over rect r, cut to the part inside c; hidden when none of it is.
  const place = (b: HTMLElement, r: DOMRect, c: Clip | null) => {
    const x = r.left - 2, y = r.top - 2, w = r.width + 4, h = r.height + 4
    const cut = c && [Math.max(0, c.top - y), Math.max(0, x + w - c.right), Math.max(0, y + h - c.bottom), Math.max(0, c.left - x)]
    if (!cut || cut[0] + cut[2] >= h || cut[1] + cut[3] >= w) { b.style.display = 'none'; return }
    Object.assign(b.style, { display: 'block', left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`, clipPath: cut.some(Boolean) ? `inset(${cut.map((n) => `${n}px`).join(' ')})` : '' })
  }

  const startOn = (el: Element) => {
    handBack()
    send({ t: 'new', anchor: elementAnchor(el), quote: labelOf(el), box: boxOf([el.getBoundingClientRect()]) })
  }
  const textTarget = () => {
    const sel = getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount || !sel.toString().trim()) return null
    const r = sel.getRangeAt(0)
    const common = at(r.commonAncestorContainer)
    if (!common || isOurs(common) || common.closest('input, textarea, [contenteditable]')) return null
    return { sel, r, root: pidOf(common) ?? document.body }
  }
  const startOnRange = (r: Range) => {
    const root = pidOf(at(r.commonAncestorContainer)) ?? document.body
    const quote = clip(r.toString(), 1000)
    if (!quote) return
    const anchor = { ...(root === document.body ? {} : elementAnchor(root)), text: { quote, nth: occurrenceOf(r, root) } }
    delete anchor.label
    handBack()
    send({ t: 'new', anchor, quote, box: boxOf([...r.getClientRects()]) })
  }
  // A selection takes in the whole of each word it cuts at its ends.
  const WORD = /[\p{L}\p{N}_'’-]/u
  const wholeWords = (from: Range) => {
    const r = from.cloneRange(), s = r.startContainer, e = r.endContainer
    if (s.nodeType === Node.TEXT_NODE) {
      const t = s.textContent ?? ''
      let a = r.startOffset
      if (a < t.length && WORD.test(t[a])) while (a > 0 && WORD.test(t[a - 1])) a--
      r.setStart(s, a)
    }
    if (e.nodeType === Node.TEXT_NODE) {
      const t = e.textContent ?? ''
      let b = r.endOffset
      if (b > 0 && WORD.test(t[b - 1])) while (b < t.length && WORD.test(t[b])) b++
      r.setEnd(e, b)
    }
    return r
  }
  const startOnText = () => {
    const t = textTarget()
    if (!t) return false
    startOnRange(wholeWords(t.r))
    t.sel.removeAllRanges()
    return true
  }

  // Comment mode. Codinger keeps it (it shows on the pane's button) and says when it changes.
  let mode = false
  const commenting = (e: MouseEvent | KeyboardEvent) => mode || e.altKey
  // A click starts its comment at once: on the word under the pointer, else on the mark.
  let downAt = { x: 0, y: 0 }, altAt = 0
  addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; altAt = 0 }, true)
  addEventListener('mouseup', (e) => { const on = commenting(e); setTimeout(() => { if (on) startOnText() }, 0) }, true)
  addEventListener('click', (e) => {
    if (!e.isTrusted || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || (touched && !mode) || !commenting(e)) return
    if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return
    const el = markAt(e.target as Element, true)
    const hit = markHit(e.clientX, e.clientY, el)
    if (hit) { handBack(); send({ t: 'open', id: hit }); return }
    if (!el || textTarget()) return
    const w = wordAt(e.clientX, e.clientY, el)
    if (w) startOnRange(w); else startOn(el)
  }, true)
  // In it the page gets no presses or clicks: these listeners come after this script's own and before the page's.
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu'] as const) {
    addEventListener(t, (e) => { if (commenting(e) && !isOurs(e.target) && e.isTrusted) { e.stopImmediatePropagation(); if (t === 'click' || t === 'auxclick') e.preventDefault() } }, true)
  }

  // A tap on Option alone turns comment mode on or off; Escape turns it off.
  addEventListener('keydown', (e) => {
    if (e.key === 'Alt' && !e.repeat) { altAt = performance.now(); altHeld(true) }
    else altAt = 0
    if (e.key === 'Escape' && mode) send({ t: 'mode', on: false })
  }, true)
  // Option down shows the box under the pointer at once; Option up hides it, unless it was a tap.
  addEventListener('keyup', (e) => {
    const tap = e.key === 'Alt' && altAt && performance.now() - altAt < 400
    altAt = 0
    if (tap) send({ t: 'mode', on: !mode })
    else if (e.key === 'Alt') altHeld(false)
  }, true)

  // While you comment, the mark under the pointer has a light box with a thin border. The box
  // moves to the next mark and takes its size (CSS transitions); it fades in where it first shows.
  let pick: HTMLElement | null = null
  // The word under the pointer has a faint fill, and the box fades almost out: a click comments on the word.
  const wordAt = (x: number, y: number, el: Element) => {
    const d = document as Document & { caretRangeFromPoint?(x: number, y: number): Range | null }
    let c: Range | null = d.caretRangeFromPoint?.(x, y) ?? null
    if (!c) { const p = document.caretPositionFromPoint?.(x, y); if (p) { c = document.createRange(); c.setStart(p.offsetNode, p.offset) } }
    const n = c?.startContainer
    if (!n || n.nodeType !== Node.TEXT_NODE || !el.contains(n) || at(n)?.closest(CONTROL)) return null
    const t = n.textContent ?? ''
    let a = c!.startOffset, b = a
    while (a > 0 && WORD.test(t[a - 1])) a--
    while (b < t.length && WORD.test(t[b])) b++
    if (a === b) return null
    const r = document.createRange()
    r.setStart(n, a); r.setEnd(n, b)
    // The caret is the nearest one, also from the space beside a line: the pointer must be on the word.
    return [...r.getClientRects()].some((q) => x >= q.left && x <= q.right && y >= q.top && y <= q.bottom) ? r : null
  }
  let word: Range | null = null
  const showWord = (r: Range | null) => {
    if (!('highlights' in CSS) || (r === word || (r && word && r.startContainer === word.startContainer && r.startOffset === word.startOffset && r.endOffset === word.endOffset))) return
    word = r
    if (r) CSS.highlights.set('cd-word', new Highlight(r)); else CSS.highlights.delete('cd-word')
  }
  const showPick = (el: Element | null, x = 0, y = 0, down = false) => {
    showWord(el && !down ? wordAt(x, y, el) : null)
    if (!el) { pick?.classList.remove('on'); return }
    if (!pick?.isConnected) { pick = document.createElement('div'); pick.className = 'cd-pick'; ensureLayer().appendChild(pick) }
    pick.classList.toggle('word', !!word)
    const shown = pick.classList.contains('on')
    if (!shown) pick.classList.add('jump')
    place(pick, el.getBoundingClientRect(), clipOf(el))
    // A mark out of view: the box fades out where it is.
    if (pick.style.display === 'none') { pick.style.display = 'block'; pick.classList.remove('on', 'jump'); return }
    if (!shown) { void pick.offsetWidth; pick.classList.remove('jump') }
    pick.classList.add('on')
  }
  // Where the pointer is, so a change of mode or of Option shows the box without a move.
  let ptr: { x: number; y: number } | null = null
  const pickHere = () => {
    const t = ptr && document.elementFromPoint(ptr.x, ptr.y)
    showPick(t && !isOurs(t) ? markAt(t, true) : null, ptr?.x, ptr?.y)
  }
  addEventListener('mousemove', (e) => {
    ptr = { x: e.clientX, y: e.clientY }
    showPick(commenting(e) && !isOurs(e.target) ? markAt(e.target as Element, true) : null, e.clientX, e.clientY, e.buttons !== 0)
  }, { capture: true, passive: true })
  document.documentElement.addEventListener('mouseleave', () => { ptr = null; showPick(null) })
  // Option held, in this page or in Codinger's (which sends it here).
  const altHeld = (on: boolean) => { if (on) pickHere(); else if (!mode) showPick(null) }
  const setMode = (on: boolean) => {
    mode = on
    document.documentElement.toggleAttribute('data-codinger-commenting', on)
    if (on) pickHere(); else showPick(null)
  }

  // Touch: a long press on a mark starts a comment on it; a selection starts one when it stops changing.
  let touched = false, press = 0, from: { x: number; y: number } | null = null, settle = 0
  addEventListener('touchstart', (e) => {
    touched = true
    clearTimeout(press)
    if (e.touches.length !== 1) return
    const t = e.touches[0], el = mode ? null : markAt(e.target as Element, false)
    from = { x: t.clientX, y: t.clientY }
    if (el) press = window.setTimeout(() => { if (from && !textTarget()) { from = null; startOn(el) } }, 500)
  }, { passive: true })
  addEventListener('touchmove', (e) => { const t = e.touches[0]; if (from && Math.hypot(t.clientX - from.x, t.clientY - from.y) > 10) { clearTimeout(press); from = null } }, { passive: true })
  addEventListener('touchend', () => { clearTimeout(press); from = null; setTimeout(() => { touched = false }, 400) }, { passive: true })
  document.addEventListener('selectionchange', () => {
    clearTimeout(settle)
    if (touched && mode) settle = window.setTimeout(() => { if (!from) startOnText() }, 600)
  })

  // ---- highlights ----

  let marks: Mark[] = [], focus: string | null = null
  let layer: HTMLElement | null = null
  const ensureLayer = () => {
    if (layer?.isConnected) return layer
    layer = document.createElement('div')
    layer.setAttribute(UI, '')
    layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646'
    const css = document.createElement('style')
    css.textContent = `
      ::highlight(cd-draft){background-color:rgba(255,196,0,.19)} ::highlight(cd-sent){background-color:rgba(255,196,0,.12)} ::highlight(cd-focus){background-color:rgba(255,196,0,.38)} ::highlight(cd-word){background-color:rgba(255,190,0,.22)}
      [${UI}] .cd-box{position:fixed;border-radius:4px;background:rgba(255,196,0,.12)}
      [${UI}] .cd-box.sent{background:rgba(255,196,0,.08)}
      [${UI}] .cd-box.focus{background:rgba(255,196,0,.24);box-shadow:inset 0 0 0 2px rgba(240,180,0,.95)}
      [${UI}] .cd-pick{position:fixed;box-sizing:border-box;border-radius:5px;border:1.5px solid rgba(232,168,0,.9);background:rgba(255,200,0,.1);opacity:0;transition:left .14s cubic-bezier(.2,.8,.2,1),top .14s cubic-bezier(.2,.8,.2,1),width .14s cubic-bezier(.2,.8,.2,1),height .14s cubic-bezier(.2,.8,.2,1),opacity .12s}
      [${UI}] .cd-pick.on{opacity:1} [${UI}] .cd-pick.on.word{opacity:.1}
      [${UI}] .cd-pick.jump{transition:opacity .12s}`
    layer.appendChild(css)
    document.documentElement.appendChild(layer)
    return layer
  }
  // Each mark found again in the page now: its text, or its element.
  let found: { m: Mark; range: Range | null; el: Element | null }[] = []
  const resolve = () => { found = marks.map((m) => m.anchor.text ? { m, range: rangeOf(m.anchor), el: null } : { m, range: null, el: elementOf(m.anchor) }) }
  const rectsOf = (f: (typeof found)[number]) => f.range ? [...f.range.getClientRects()] : f.el ? [f.el.getBoundingClientRect()] : []
  // The comment a click opens: one on the mark clicked, or on the text under the pointer. A
  // comment on a card does not catch a click on a bar inside it: that starts a comment on the bar.
  const markHit = (x: number, y: number, el: Element | null) => {
    for (const f of found) {
      if (f.m.kind !== 'draft') continue
      if (f.el ? f.el === el : rectsOf(f).some((r) => x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2)) return f.m.id
    }
    return null
  }
  let raf = 0
  const paint = () => {
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => {
      const l = ensureLayer()
      for (const b of [...l.querySelectorAll('.cd-box')]) b.remove()
      const kind = (m: Mark) => m.id === focus ? 'focus' : m.kind
      if ('highlights' in CSS) for (const k of ['draft', 'sent', 'focus']) {
        const rs = found.filter((f) => f.range && kind(f.m) === k).map((f) => f.range!)
        if (rs.length) CSS.highlights.set(`cd-${k}`, new Highlight(...rs)); else CSS.highlights.delete(`cd-${k}`)
      }
      const boxes: Record<string, Box | null> = {}
      for (const f of found) {
        const rects = rectsOf(f)
        // Codinger hides the card of a mark that is out of view, as in a table scrolled away from it.
        const c = clipOf(f.el ?? (f.range ? at(f.range.commonAncestorContainer) : null))
        const box = boxOf(rects)
        boxes[f.m.id] = box && (!c || box.bottom < c.top || box.top > c.bottom || box.right < c.left || box.left > c.right) ? { ...box, out: true } : box
        if (!f.el || !rects.length) continue
        const b = document.createElement('div')
        b.className = `cd-box ${kind(f.m)}`
        l.appendChild(b)
        place(b, rects[0], c)
      }
      send({ t: 'boxes', boxes, h: innerHeight, w: innerWidth })
    })
  }
  // A scroll moves the marks: the outline goes until the pointer moves again.
  addEventListener('scroll', () => { paint(); showPick(null) }, { capture: true, passive: true })
  addEventListener('resize', paint)
  // The page draws again (new data, a filter): find each mark again.
  let redo = 0
  new MutationObserver((ms) => {
    if (ms.every((m) => isOurs(m.target))) return
    clearTimeout(redo)
    redo = window.setTimeout(() => { sticky = new WeakMap(); resolve(); paint() }, 100)
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-pid', 'aria-label', 'class', 'style', 'transform', 'd', 'x', 'y', 'width', 'height'] })

  // The pointer over a mark lights up its card in Codinger.
  let hovered: string | null = null, moveRaf = 0
  addEventListener('mousemove', (e) => {
    cancelAnimationFrame(moveRaf)
    moveRaf = requestAnimationFrame(() => {
      let id: string | null = null
      // The gap under a highlight, down to its card, counts as on it.
      for (const f of found) if (rectsOf(f).some((r) => e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom + 8)) { id = f.m.id; if (f.m.kind === 'draft') break }
      if (id !== hovered) { hovered = id; send({ t: 'hover', id }) }
    })
  }, { passive: true })
  document.documentElement.addEventListener('mouseleave', () => { if (hovered) { hovered = null; send({ t: 'hover', id: null }) } })

  addEventListener('message', (e) => {
    if (e.source !== parent || e.origin !== CODINGER_APP || e.data?.codinger !== 'notes') return
    const m = e.data
    if (m.t === 'marks') { marks = m.items ?? []; focus = m.focus ?? null; resolve(); paint() }
    else if (m.t === 'mode') setMode(!!m.on)
    else if (m.t === 'alt') altHeld(!!m.on)
    else if (m.t === 'reveal') {
      const f = found.find((x) => x.m.id === m.id)
      const el = f?.el ?? (f?.range ? at(f.range.startContainer) : null)
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  })
  send({ t: 'ready' })
}
