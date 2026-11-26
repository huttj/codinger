// Live markdown for the text fields, the way Obsidian does it: the text stays
// markdown source, but it is drawn styled (bold bold, code in a box, headings
// big) and the markers (**, _, `, #…) show only while the caret is in that
// span or on that line. The field rebuilds its DOM from the text after each
// change and puts the caret back at the same character, so positions here are
// offsets into the text, where an image counts as its whole image link. A file
// (shared/files.ts) is one pill the same way: it cannot be edited, only removed or moved.
// So is a long paste (shared/pastes.ts); a click on it shows its text.

import { imageToken, splitImages } from '../../shared/images.ts'
import { fileToken, splitFiles } from '../../shared/files.ts'
import { pasteLabel, pasteToken, splitPastes } from '../../shared/pastes.ts'
import { media } from './store.ts'

// ---- text ↔ DOM ---------------------------------------------------------------

export function imgNode(src: string, url?: string): HTMLImageElement {
  const img = document.createElement('img')
  img.src = src
  img.className = 'ri-img'
  if (url) img.dataset.url = url
  else img.classList.add('loading')
  return img
}

const CLIP = '<svg class="icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 7.5l-5.3 5.3a3.2 3.2 0 01-4.5-4.5L8.6 2.9a2.1 2.1 0 013 3L6.3 11.2a1 1 0 01-1.5-1.5L9.5 5" /></svg>'

export function fileNode(name: string): HTMLElement {
  const s = document.createElement('span')
  s.className = 'ri-file'
  s.contentEditable = 'false'
  s.draggable = true
  s.dataset.file = name
  s.innerHTML = CLIP
  const t = document.createElement('span')
  t.className = 'ri-file-name'
  t.textContent = name
  const x = document.createElement('span')
  x.className = 'ri-file-x'
  x.setAttribute('role', 'button')
  x.setAttribute('aria-label', `Remove ${name}`)
  x.textContent = '\u00d7'
  s.append(t, x)
  return s
}

// A file on its way: a pill with a spinner and no text, until the upload is done (Inputs.tsx).
export function uploadNode(name: string): HTMLElement {
  const s = fileNode(name)
  delete s.dataset.file
  s.draggable = false
  s.classList.add('loading')
  s.dataset.uploading = name
  s.firstElementChild!.outerHTML = '<span class="ri-spin" aria-hidden="true"></span>'
  s.querySelector('.ri-file-x')!.setAttribute('aria-label', `Stop the upload of ${name}`)
  return s
}

const PASTE = '<svg class="icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2h5l3 3v9H4z" /><path d="M9 2v3h3M6 8.5h4M6 11h4" /></svg>'

// The text of each paste pill.
export const pasteText = new WeakMap<HTMLElement, string>()

export function pasteNode(text: string): HTMLElement {
  const s = fileNode(pasteLabel(text))
  delete s.dataset.file
  s.classList.add('ri-paste')
  s.dataset.paste = ''
  s.firstElementChild!.outerHTML = PASTE
  s.querySelector('.ri-file-x')!.setAttribute('aria-label', 'Remove the pasted text')
  pasteText.set(s, text)
  return s
}

// Chrome cannot put the caret before a pill at the start of a line: it puts it at
// the end of the line above, and typing goes after the pill. A zero-width space
// before the pill (a gap) gives the caret a place there. A gap is not text.
const ZW = '\u200b'
const gaps = new WeakSet<Node>()
function gapNode(): Text {
  const t = document.createTextNode(ZW)
  gaps.add(t)
  return t
}
// The text of a text node, up to a DOM offset.
function textIn(t: Node, end?: number): string {
  const s = (t.textContent ?? '').slice(0, end)
  return gaps.has(t) ? s.replaceAll(ZW, '') : s
}
// The DOM offset in a text node for k characters of its text: in a gap, after its zero-width space.
function domOffset(t: Node, k: number): number {
  if (!gaps.has(t)) return k
  const s = t.textContent ?? ''
  let i = 0
  for (let c = 0; i < s.length && (c < k || s[i] === ZW); i++) if (s[i] !== ZW) c++
  return i
}

// An image, a file pill, an upload pill or a paste pill: one unit of the text.
const isPill = (n: Node): n is HTMLElement => n instanceof HTMLElement && (n.dataset.file != null || n.dataset.paste != null || n.dataset.uploading != null)
const isAtom = (n: Node): n is HTMLElement => n instanceof HTMLImageElement || isPill(n)

// The text a pill stands for. An upload pill stands for no text yet.
export const pillText = (n: HTMLElement) => n.dataset.paste != null ? pasteToken(pasteText.get(n) ?? '') : n.dataset.file != null ? fileToken(n.dataset.file) : ''

// The text a node stands for.
function textOf(n: Node, last: boolean): string {
  if (n.nodeType === Node.TEXT_NODE) return textIn(n)
  if (n instanceof HTMLImageElement) return n.dataset.url ? imageToken(n.dataset.url) : ''
  if (isPill(n)) return pillText(n)
  // The browser keeps a <br> at the very end so a final newline shows; it is not text.
  if (n.nodeName === 'BR') return last ? '' : '\n'
  let out = ''
  const kids = [...n.childNodes]
  // A browser may wrap new lines in <div>s; each starts a line.
  kids.forEach((k, i) => {
    const t = textOf(k, last && i === kids.length - 1)
    out += (out && !out.endsWith('\n') && /^(DIV|P)$/.test(k.nodeName) ? '\n' : '') + t
  })
  return out
}
export const fromDom = (el: HTMLElement) => textOf(el, true)

const span = (cls: string, ...kids: (Node | string)[]) => {
  const s = document.createElement('span')
  s.className = cls
  for (const k of kids) s.append(k)
  return s
}
const mark = (t: string, block = false) => span(block ? 'md-mark md-bmark' : 'md-mark', t)

// Inline spans, left to right, not nested.
const INLINE: [RegExp, string, number, number][] = [
  // pattern, class, length of the opening marker, of the closing one (link: computed)
  [/`[^`\n]+`/y, 'md-code', 1, 1],
  [/\*\*[^*\n]+?\*\*/y, 'md-strong', 2, 2],
  [/__[^_\n]+?__/y, 'md-strong', 2, 2],
  [/~~[^~\n]+?~~/y, 'md-strike', 2, 2],
  [/==(?=\S)[^=\n]*?\S==(?!=)/y, 'md-hl', 2, 2],
  [/\*[^*\s][^*\n]*?\*(?!\*)/y, 'md-em', 1, 1],
  [/_[^_\s][^_\n]*?_(?![\w])/y, 'md-em', 1, 1],
  [/\[[^\]\n]+\]\([^)\s]*\)/y, 'md-link', 1, 0],
]

function inline(text: string): Node[] {
  const out: Node[] = []
  let plain = ''
  const flush = () => { if (plain) out.push(document.createTextNode(plain)); plain = '' }
  let i = 0
  while (i < text.length) {
    let hit: Node | null = null
    // Markers only open at a word edge (so snake_case stays plain).
    if (i === 0 || !/\w/.test(text[i - 1]) || text[i] === '`' || text[i] === '[') {
      for (const [re, cls, a, b] of INLINE) {
        re.lastIndex = i
        const m = re.exec(text)
        if (!m) continue
        const s = m[0]
        if (cls === 'md-link') {
          const close = s.indexOf('](')
          hit = span('md-x md-link', mark('['), s.slice(1, close), mark(s.slice(close)))
        } else hit = span(`md-x ${cls}`, mark(s.slice(0, a)), s.slice(a, s.length - b), mark(s.slice(s.length - b)))
        i += s.length
        break
      }
    }
    if (hit) { flush(); out.push(hit) } else plain += text[i++]
  }
  flush()
  return out
}

// In a list, each character of an indent or a marker takes the same width
// (--n of them, styles.css), so "- " and the two spaces that continue its item
// line up, and a long line wraps under its own text (a hanging indent).
const hang = (cls: string, lead: number, ...kids: Node[]) => {
  const s = span(`md-line md-hang ${cls}`, ...kids)
  s.style.setProperty('--n', String(lead))
  return s
}
const cols = (cls: string, t: string) => {
  const s = span(`md-cols ${cls}`, t)
  s.style.setProperty('--n', String(t.length))
  return s
}

// list: the line before was a list item, or continued one.
function line(text: string, list: boolean): { nodes: Node[]; list: boolean } {
  let m: RegExpExecArray | null
  if ((m = /^(#{1,6} )(.*)$/.exec(text))) return { nodes: [span(`md-x md-line md-h md-h${m[1].length - 1}`, mark(m[1], true), ...inline(m[2]))], list: false }
  // An unordered marker is drawn as a bullet off its line (styles.css).
  if ((m = /^(\s*)([-*+] )(.*)$/.exec(text)))
    return { nodes: [hang('md-x md-li', m[1].length + 2, ...(m[1] ? [cols('', m[1])] : []), cols('md-bullet md-ul', m[2]), ...inline(m[3]))], list: true }
  if ((m = /^(\s*)(\d+[.)] )(.*)$/.exec(text)))
    return { nodes: [hang('md-li', m[1].length + m[2].length, ...(m[1] ? [cols('', m[1])] : []), cols('md-bullet md-ol', m[2]), ...inline(m[3]))], list: true }
  if (list && (m = /^([ \t]+)(\S.*)$/.exec(text))) return { nodes: [hang('md-cont', m[1].length, cols('', m[1]), ...inline(m[2]))], list: true }
  if ((m = /^(> ?)(.*)$/.exec(text))) return { nodes: [span('md-x md-line md-quote', mark(m[1], true), ...inline(m[2]))], list: false }
  return { nodes: inline(text), list: false }
}

export function render(el: HTMLElement, value: string) {
  const nodes: Node[] = []
  const pill = (n: HTMLElement) => {
    const prev = nodes.at(-1)
    if (!prev || isAtom(prev) || (prev.nodeType === Node.TEXT_NODE && prev.textContent!.endsWith('\n'))) nodes.push(gapNode())
    nodes.push(n)
  }
  for (const c of splitPastes(value)) {
    if ('paste' in c) { pill(pasteNode(c.paste)); continue }
    for (const r of splitImages(c.text)) {
      if ('url' in r) { nodes.push(imgNode(media(r.url), r.url)); continue }
      for (const f of splitFiles(r.text)) {
        if ('file' in f) { pill(fileNode(f.file)); continue }
        let list = false
        f.text.split('\n').forEach((l, i) => {
          if (i) nodes.push(document.createTextNode('\n'))
          const out = line(l, list)
          nodes.push(...out.nodes)
          list = out.list
        })
      }
    }
  }
  // A final newline needs something after it to show as a line.
  if (value.endsWith('\n')) nodes.push(document.createElement('br'))
  el.replaceChildren(...nodes)
}

// ---- caret ↔ offsets ------------------------------------------------------------

// The text offset of a DOM position inside el.
function offsetOf(el: HTMLElement, node: Node, off: number): number {
  let n = 0
  let found = -1
  const walk = (p: Node): boolean => {
    if (p === node && p.nodeType !== Node.TEXT_NODE) {
      // A position between children: count the children before it.
      for (let i = 0; i < off && i < p.childNodes.length; i++) n += textOf(p.childNodes[i], false).length
      found = n
      return true
    }
    if (p.nodeType === Node.TEXT_NODE) {
      if (p === node) { found = n + textIn(p, off).length; return true }
      n += textIn(p).length
      return false
    }
    if (p !== el && (isAtom(p) || p.nodeName === 'BR')) { if (p.contains(node)) { found = n; return true } n += textOf(p, false).length; return false }
    for (const k of p.childNodes) if (walk(k)) return true
    return false
  }
  walk(el)
  return found < 0 ? n : found
}

// The text offset of a range's start (a drop point), or of a node (a pill).
export const rangeOffset = (el: HTMLElement, r: Range) => offsetOf(el, r.startContainer, r.startOffset)
export const nodeOffset = (el: HTMLElement, n: Node) => offsetOf(el, n.parentNode!, [...n.parentNode!.childNodes].indexOf(n as ChildNode))

export function selectionOffsets(el: HTMLElement): [number, number] | null {
  const s = getSelection()
  if (!s?.rangeCount || !el.contains(s.anchorNode)) return null
  const r = s.getRangeAt(0)
  return [offsetOf(el, r.startContainer, r.startOffset), offsetOf(el, r.endContainer, r.endOffset)]
}

// The DOM position at a text offset. At the edge of a styled span, the caret
// goes outside it (after it), so typing after **bold** is not bold.
function positionAt(el: HTMLElement, target: number): [Node, number] {
  let n = 0
  let best: [Node, number] | null = null
  const walk = (p: Node): boolean => {
    if (p.nodeType === Node.TEXT_NODE) {
      const len = textIn(p).length
      if (target >= n && target <= n + len) {
        best = [p, domOffset(p, target - n)]
        // Prefer the start of the next text over the end of this one, unless this is the last.
        if (target < n + len) return true
      }
      n += len
      return false
    }
    if (p !== el && (isAtom(p) || p.nodeName === 'BR')) {
      const len = textOf(p, false).length
      if (target <= n && !best) { best = [p.parentNode!, [...p.parentNode!.childNodes].indexOf(p as ChildNode)]; return true }
      n += len
      if (target === n) best = [p.parentNode!, [...p.parentNode!.childNodes].indexOf(p as ChildNode) + 1]
      return false
    }
    for (const k of p.childNodes) if (walk(k)) return true
    return false
  }
  walk(el)
  return best ?? [el, el.childNodes.length]
}

export function rangeAt(el: HTMLElement, start: number, end = start): Range {
  const r = document.createRange()
  const [a, ao] = positionAt(el, start)
  r.setStart(a, ao)
  const [b, bo] = positionAt(el, end)
  r.setEnd(b, bo)
  return r
}

export function select(el: HTMLElement, start: number, end = start) {
  const s = getSelection()
  if (!s) return
  s.removeAllRanges()
  s.addRange(rangeAt(el, start, end))
}

// The image just before or after a collapsed caret, and on which side of it the caret is.
function imageBesideCaret(el: HTMLElement): [HTMLImageElement, 'after' | 'before'] | null {
  const s = getSelection()
  if (!s?.rangeCount || !s.isCollapsed || !el.contains(s.anchorNode)) return null
  const n = s.anchorNode!, off = s.anchorOffset
  const text = n.nodeType === Node.TEXT_NODE
  const prev = text ? (off === 0 ? n.previousSibling : null) : n.childNodes[off - 1]
  const next = text ? (off === n.textContent?.length ? n.nextSibling : null) : n.childNodes[off]
  if (prev instanceof HTMLImageElement) return [prev, 'after']
  if (next instanceof HTMLImageElement) return [next, 'before']
  return null
}

const fontMetrics = new Map<string, { ascent: number; descent: number; x: number }>()
function metricsOf(font: string) {
  let m = fontMetrics.get(font)
  if (!m) {
    const ctx = document.createElement('canvas').getContext('2d')!
    ctx.font = font
    const t = ctx.measureText('x')
    m = { ascent: t.fontBoundingBoxAscent, descent: t.fontBoundingBoxDescent, x: t.actualBoundingBoxAscent }
    fontMetrics.set(font, m)
  }
  return m
}

// Beside an image the browser draws the caret as tall as the whole line. There,
// hide it (.ri-hide-caret) and show `fake` instead: the text's height, on the
// text's baseline, blinking the same way.
export function imageCaret(el: HTMLElement, fake: HTMLElement) {
  const at = document.activeElement === el ? imageBesideCaret(el) : null
  el.classList.toggle('ri-hide-caret', !!at)
  fake.hidden = !at
  if (!at) return
  const [img, side] = at
  const r = img.getBoundingClientRect(), st = getComputedStyle(img)
  const m = metricsOf(getComputedStyle(img.parentElement!).font)
  // vertical-align: middle puts the middle of the image's margin box half an x-height above the baseline.
  const baseline = (r.top - parseFloat(st.marginTop) + r.bottom + parseFloat(st.marginBottom)) / 2 + m.x / 2
  const box = fake.offsetParent!.getBoundingClientRect(), field = el.getBoundingClientRect()
  fake.hidden = baseline < field.top || baseline > field.bottom
  fake.style.left = `${(side === 'after' ? r.right : r.left - 1) - box.left}px`
  fake.style.top = `${baseline - m.ascent - box.top}px`
  fake.style.height = `${m.ascent + m.descent}px`
  // A caret that moves shows at once, then blinks.
  for (const a of fake.getAnimations()) a.currentTime = 0
}

// The caret, or the moving end of a selection (Shift with an arrow), before the
// zero-width space of a gap moves after it, so it does not stop there twice.
// The left arrow and Backspace in a gap act from before it, so they go past the
// zero-width space at once.
const inGap = (n: Node | null): n is Text => !!n && gaps.has(n) && n.textContent!.startsWith(ZW)
export function gapKey(e: KeyboardEvent) {
  const s = getSelection()
  if (!s || !inGap(s.focusNode) || s.focusOffset !== 1) return
  if (e.key === 'ArrowLeft' && e.shiftKey) s.extend(s.focusNode, 0)
  else if ((e.key === 'ArrowLeft' || e.key === 'Backspace') && s.isCollapsed) s.collapse(s.focusNode, 0)
}

// A caret at the end of a list marker (or its indent) is drawn inside that
// fixed-width box, short of the text: put it after the box.
export function snapCaret(el: HTMLElement) {
  const s = getSelection()
  if (!s?.rangeCount) return
  // Just before a gap (at the end of the text before it, or between nodes) is the same place too.
  const f = s.focusNode, o = s.focusOffset
  const gap = inGap(f) && o === 0 ? f
    : f?.nodeType === Node.TEXT_NODE && o === f.textContent!.length ? f.nextSibling
    : f && f.nodeType !== Node.TEXT_NODE ? f.childNodes[o] : null
  if (inGap(gap) && !(f === gap && o === 1)) {
    if (s.isCollapsed) s.collapse(gap, 1)
    else s.extend(gap, 1)
    return
  }
  if (!s.isCollapsed) return
  const n = s.anchorNode
  if (n?.nodeType !== Node.TEXT_NODE || s.anchorOffset !== n.textContent?.length) return
  const box = n.parentElement
  if (!box?.classList.contains('md-cols') || !el.contains(box)) return
  s.collapse(box.parentNode!, [...box.parentNode!.childNodes].indexOf(box) + 1)
}

// Show the markers of the spans and lines the selection touches.
export function activate(el: HTMLElement) {
  const s = getSelection()
  const on = new Set<Element>()
  if (s?.rangeCount && el.contains(s.anchorNode)) {
    const r = s.getRangeAt(0)
    for (const n of [r.startContainer, r.endContainer]) {
      for (let p: Node | null = n; p && p !== el; p = p.parentNode) if (p instanceof Element && p.classList.contains('md-x')) on.add(p)
    }
    // A caret just before or after a span counts as in it, and in the spans that end or start with it
    // (**b** at the end of a list item).
    if (r.collapsed && r.startContainer.nodeType === Node.TEXT_NODE) {
      const t = r.startContainer
      if (r.startOffset === 0) for (let p = t.previousSibling; p instanceof Element; p = p.lastChild) if (p.classList.contains('md-x')) on.add(p)
      if (r.startOffset === t.textContent?.length) for (let p = t.nextSibling; p instanceof Element; p = p.firstChild) if (p.classList.contains('md-x')) on.add(p)
    }
  }
  for (const x of el.querySelectorAll('.md-x')) x.classList.toggle('md-active', on.has(x))
  // A quote shows its "> " only while the caret is at it: in it, or just after it.
  const at = new Set<Element>()
  if (s?.rangeCount && el.contains(s.anchorNode)) {
    const r = s.getRangeAt(0)
    for (const [n, off] of [[r.startContainer, r.startOffset], [r.endContainer, r.endOffset]] as const) {
      const p = n.parentElement
      if (p?.classList.contains('md-mark') && p.parentElement?.classList.contains('md-quote')) at.add(p.parentElement)
      const prev = n.nodeType === Node.TEXT_NODE && off === 0 ? n.previousSibling : n instanceof Element && n.classList.contains('md-quote') && off <= 1 ? n.firstChild : null
      if (prev instanceof Element && prev.classList.contains('md-mark') && prev.parentElement?.classList.contains('md-quote')) at.add(prev.parentElement)
    }
  }
  for (const x of el.querySelectorAll('.md-quote')) x.classList.toggle('md-at-mark', at.has(x))
}

// ---- markdown keys ----------------------------------------------------------------

// Cmd+B, I, E and Shift+X wrap the selection, or unwrap it (markers inside
// or just outside it count); with nothing selected, the caret lands inside.
// Cmd+K is not here: it opens the palette (Palette.tsx).
const WRAP: Record<string, [string, string]> = { b: ['**', '**'], i: ['_', '_'], e: ['`', '`'], x: ['~~', '~~'] }
export function wrapKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }, value: string, s: number, t: number): { value: string; start: number; end: number } | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null
  const k = e.key.toLowerCase()
  if (!WRAP[k] || (k === 'x') !== e.shiftKey) return null
  const [a, b] = WRAP[k]
  if (value.slice(s - a.length, s) === a && value.slice(t, t + b.length) === b)
    return { value: value.slice(0, s - a.length) + value.slice(s, t) + value.slice(t + b.length), start: s - a.length, end: t - a.length }
  const sel = value.slice(s, t)
  if (sel.length >= a.length + b.length && sel.startsWith(a) && sel.endsWith(b))
    return { value: value.slice(0, s) + sel.slice(a.length, sel.length - b.length) + value.slice(t), start: s, end: t - a.length - b.length }
  const v = value.slice(0, s) + a + value.slice(s, t) + b + value.slice(t)
  return { value: v, start: s + a.length, end: t + a.length }
}

// Backspace and Delete with a caret, done here on the text: the browser deletes the
// hidden markers next to a character with it (Backspace on a space after a link took
// its "](url)" too). An image or a pill next to the caret is left to the browser, which
// removes the whole node; so is a field with an image that is still uploading.
const graphemes = new Intl.Segmenter()
// The length of the character (grapheme) before or after offset s; 0 at the edge.
function charAt(value: string, s: number, back: boolean): number {
  const segs = [...graphemes.segment(back ? value.slice(Math.max(0, s - 32), s) : value.slice(s, s + 32))]
  return (back ? segs.at(-1) : segs[0])?.segment.length ?? 0
}
// The text ranges of the images and pills.
const atomRanges = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('img, .ri-file')].filter(isAtom).map((a) => {
  const start = nodeOffset(el, a)
  return [start, start + textOf(a, false).length] as const
})
export function deleteKey(el: HTMLElement, value: string, s: number, t: number, back: boolean): { value: string; start: number; end: number } | null {
  if (s !== t || el.querySelector('img.loading')) return null
  const n = charAt(value, s, back)
  if (!n) return null
  const from = back ? s - n : s, to = from + n
  if (atomRanges(el).some(([a, b]) => from < b && to > a)) return null
  return { value: value.slice(0, from) + value.slice(to), start: from, end: from }
}

// The left and right arrows with a caret, done here on the text: one character at a
// time, hidden markers too. The browser steps over hidden markers, so it could not stop
// after a link's ")" or before its "[". The caret steps over an image or a pill as a whole.
// Returns the new offset of the caret.
export function arrowKey(el: HTMLElement, value: string, s: number, t: number, back: boolean): number | null {
  if (s !== t || el.querySelector('img.loading')) return null
  const n = charAt(value, s, back)
  if (!n) return null
  const p = back ? s - n : s + n
  const atom = atomRanges(el).find(([a, b]) => a < p && p < b)
  return atom ? (back ? atom[0] : atom[1]) : p
}

// Enter, done here so the browser adds no extra line: in a list item it starts
// the next item (numbered ones count up); on an empty item it ends the list.
export function enterKey(value: string, s: number, t: number): { value: string; start: number; end: number } {
  const lineStart = value.lastIndexOf('\n', s - 1) + 1
  const m = /^(\s*)([-*+]|(\d+)([.)]))( \[[ x]\])? (.*)$/.exec(value.slice(lineStart, s))
  let insert = '\n'
  if (m && s === t) {
    if (!m[6].trim() && value.slice(s, value.indexOf('\n', s) < 0 ? value.length : value.indexOf('\n', s)).trim() === '') {
      // An empty item: take its bullet off instead.
      return { value: value.slice(0, lineStart) + value.slice(s), start: lineStart, end: lineStart }
    }
    insert = `\n${m[1]}${m[3] ? `${Number(m[3]) + 1}${m[4]}` : m[2]}${m[5] ? ' [ ]' : ''} `
  }
  const v = value.slice(0, s) + insert + value.slice(t)
  return { value: v, start: s + insert.length, end: s + insert.length }
}
