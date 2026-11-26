// A text field that grows with its text and takes pasted or dropped images,
// which sit in the text where they were put (as image links, shared/images.ts).
// Other files go into the session's directory, and the text names them (shared/files.ts).
// A long paste goes in as one pill (shared/pastes.ts).
// The text is markdown, drawn live (mdlive.ts): the field rebuilds itself from
// the text after each change, so it keeps its own undo history.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ImageRef } from '../../../shared/types.ts'
import { htmlToMarkdown } from '../htmlmd.ts'
import { activate, deleteKey, enterKey, fromDom, gapKey, imageCaret, imgNode, nodeOffset, pasteText, pillText, rangeAt, rangeOffset, render, select, selectionOffsets, snapCaret, uploadNode, wrapKey } from '../mdlive.ts'
import { imagesFrom, uploadImage } from '../util.ts'
import { media, uploadFile } from '../store.ts'
import { fileToken } from '../../../shared/files.ts'
import { isFilePaste, isLongPaste, pasteToken } from '../../../shared/pastes.ts'
import { ClipIcon, ImageIcon, XIcon } from './Icons.tsx'
import { PasteDialog } from './Paste.tsx'

type Props = {
  machine?: string   // the machine its images go to; the current one by default
  value: string
  onChange(v: string): void
  // Images attached the older way, beside the text rather than in it.
  images: ImageRef[]
  onImages(imgs: ImageRef[]): void
  // Where attached files go: the session's directory. Without it, the field takes images only;
  // with '', it asks for a directory first.
  uploadDir?: string
  // Set to a function that attaches files, for drops elsewhere (the whole chat is a drop zone).
  attachRef?: React.RefObject<((files: File[]) => void) | null>
  placeholder?: string
  autoFocus?: boolean
  onSubmit?(): void
  onEscape?(): void
  minRows?: number
  // Gets first look at keys; return true to swallow one (the slash menu does).
  onKey?(e: React.KeyboardEvent<HTMLElement>): boolean
}

function caretAt(x: number, y: number): Range | null {
  const d = document as Document & { caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null }
  if (d.caretPositionFromPoint) {
    const p = d.caretPositionFromPoint(x, y)
    if (!p) return null
    const r = document.createRange()
    r.setStart(p.offsetNode, p.offset)
    return r
  }
  return document.caretRangeFromPoint?.(x, y) ?? null
}

type Snap = { v: string; s: number; e: number; t: number }

// Draw the text again, and keep the pills of files still on their way where they were.
function draw(el: HTMLElement, v: string) {
  const keep = [...el.querySelectorAll<HTMLElement>('[data-uploading]')].map((p) => [p, nodeOffset(el, p)] as const)
  render(el, v)
  for (const [p, at] of keep) rangeAt(el, Math.min(at, v.length)).insertNode(p)
}

// Cmd+Left and Cmd+Right go to the start and the end of the line as drawn. With a pill in the
// field, Chrome goes to the start or the end of the whole field. Returns true when it moved.
function lineKey(el: HTMLElement, e: React.KeyboardEvent): boolean {
  if (!e.metaKey || e.ctrlKey || e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return false
  const s = getSelection()
  if (!s?.rangeCount || !el.contains(s.focusNode) || !el.querySelector('[contenteditable="false"], img')) return false
  const n = s.focusNode!, o = s.focusOffset
  const r = document.createRange()
  r.setStart(n, o)
  let box: DOMRect | undefined = r.getClientRects()[0]
  if (!box?.height) {
    const side = n.nodeType === Node.TEXT_NODE ? (o ? null : n.previousSibling) ?? n.nextSibling : n.childNodes[o - 1] ?? n.childNodes[o]
    box = side instanceof Element ? side.getBoundingClientRect() : undefined
  }
  if (!box?.height) return false
  const f = el.getBoundingClientRect(), cs = getComputedStyle(el)
  const left = f.left + el.clientLeft + parseFloat(cs.paddingLeft)
  const right = f.left + el.clientLeft + el.clientWidth - parseFloat(cs.paddingRight) - 1
  const at = caretAt(e.key === 'ArrowLeft' ? left : right, box.top + box.height / 2)
  if (!at || !el.contains(at.startContainer)) return false
  let node: Node = at.startContainer, off = at.startOffset
  // A point on a pill is before or after it.
  const pill = (node instanceof Element ? node : node.parentElement)?.closest('[contenteditable="false"]')
  if (pill && el.contains(pill)) { node = pill.parentNode!; off = [...node.childNodes].indexOf(pill) + (e.key === 'ArrowLeft' ? 0 : 1) }
  if (e.shiftKey) s.extend(node, off)
  else s.collapse(node, off)
  return true
}

// Give a field the focus with the caret at its end, so that on iOS it takes the typing (a
// contenteditable with the focus but no caret there takes none). What worked there, step by step:
// - focus without a scroll of the page (iOS scrolled the passage away), the caret at the end;
// - the caret set again a moment later (60 and 300 ms);
// - the focus tried again (150 ms) if it missed, while nothing or the hidden field that holds
//   the keyboard (holdKeyboard) has it;
// - for a second, a selection outside the field moves back into it: iOS finishes a selection in
//   the message after the touch that ends it, and puts it over the caret.
// Returns what stops the rest.
function takeFocus(el: HTMLElement): () => void {
  const end = () => select(el, fromDom(el).length)
  const go = () => { el.focus({ preventScroll: true }); end() }
  go()
  const timers = [60, 300].map((ms) => setTimeout(() => { if (document.activeElement === el) end() }, ms))
  timers.push(setTimeout(() => { if (!document.activeElement || document.activeElement === document.body || document.activeElement.matches('[data-hold-keyboard]')) go() }, 150))
  const back = () => {
    const s = getSelection()
    if (document.activeElement === el && s?.rangeCount && !el.contains(s.anchorNode)) end()
  }
  document.addEventListener('selectionchange', back)
  timers.push(setTimeout(() => document.removeEventListener('selectionchange', back), 1000))
  return () => { timers.forEach(clearTimeout); document.removeEventListener('selectionchange', back) }
}
// Focus a field from outside (a tap on a reaction, a highlight).
export function focusField(el: HTMLElement | null | undefined) {
  if (el) takeFocus(el)
}

export function RichInput({ value, onChange, images, onImages, placeholder, autoFocus, onSubmit, onEscape, minRows = 2, onKey, machine, uploadDir, attachRef }: Props) {
  const ed = useRef<HTMLDivElement>(null)
  const fake = useRef<HTMLSpanElement>(null)       // the caret beside an image (mdlive.ts imageCaret)
  const last = useRef<string | null>(null)        // what this field last reported
  const caret = useRef<[number, number] | null>(null) // where the caret last was, as text offsets
  const composing = useRef(false)                  // an IME is mid-word: leave the DOM alone
  const past = useRef<Snap[]>([])                  // undo history, latest last
  const future = useRef<Snap[]>([])
  const change = useRef(onChange)
  change.current = onChange
  const [noDir, setNoDir] = useState(false)
  const [shown, setShown] = useState<HTMLElement | null>(null)  // the paste pill whose text shows

  const emit = (v: string) => {
    const el = ed.current!
    el.toggleAttribute('data-empty', !v && !el.querySelector('img'))
    if (v === last.current) return
    last.current = v
    change.current(v)
  }
  // Typing within a moment of the last change is one step to undo, up to a space or line break.
  const record = (v: string, sel: [number, number] | null) => {
    const now = Date.now(), top = past.current.at(-1)
    const snap = { v, s: sel?.[0] ?? v.length, e: sel?.[1] ?? v.length, t: now }
    const breaks = /\s/.test(v[snap.s - 1] ?? '')
    if (top && top.v !== v && now - top.t < 600 && past.current.length > 1 && !breaks) past.current[past.current.length - 1] = snap
    else if (!top || top.v !== v) past.current.push(snap)
    if (past.current.length > 200) past.current.shift()
    future.current = []
  }
  const apply = (snap: Snap) => {
    const el = ed.current!
    draw(el, snap.v)
    select(el, snap.s, snap.e)
    activate(el)
    reveal(el, snap.e === snap.v.length)
    emit(snap.v)
  }
  const undo = () => { if (past.current.length > 1) { future.current.push(past.current.pop()!); apply(past.current.at(-1)!) } }
  const redo = () => { const s = future.current.pop(); if (s) { past.current.push(s); apply(s) } }

  // After the browser changes the DOM: read the text, draw it again, put the caret back.
  const sync = () => {
    const el = ed.current!
    const sel = selectionOffsets(el)
    const v = fromDom(el)
    // An image still uploading is not in the text yet; drawing again would drop it.
    if (!composing.current && !el.querySelector('img.loading')) {
      draw(el, v)
      if (sel && document.activeElement === el) select(el, sel[0], sel[1])
    }
    activate(el)
    if (sel) reveal(el, sel[1] === v.length)
    if (v !== last.current) record(v, sel)
    emit(v)
  }

  useLayoutEffect(() => {
    const el = ed.current!
    if (value === last.current) return
    last.current = value
    draw(el, value)
    el.toggleAttribute('data-empty', !value)
    past.current = [{ v: value, s: value.length, e: value.length, t: 0 }]
    future.current = []
    if (document.activeElement === el) select(el, value.length)
  }, [value])

  useEffect(() => {
    const el = ed.current!
    if (!autoFocus) return
    return takeFocus(el)
  }, [autoFocus])

  useEffect(() => {
    const save = () => {
      const el = ed.current
      if (!el) return
      const sel = selectionOffsets(el)
      if (sel) caret.current = sel
      if (document.activeElement === el) snapCaret(el)
      activate(el)
      imageCaret(el, fake.current!)
    }
    // An image that loads changes size, and so moves the caret.
    const loaded = () => { if (ed.current) imageCaret(ed.current, fake.current!) }
    const el = ed.current!
    document.addEventListener('selectionchange', save)
    el.addEventListener('load', loaded, true)
    return () => { document.removeEventListener('selectionchange', save); el.removeEventListener('load', loaded, true) }
  }, [])

  // Each image shows at once and fills in when its upload is done.
  async function add(files: File[], at: Range | null) {
    const el = ed.current!
    for (const f of files) {
      const img = imgNode(URL.createObjectURL(f))
      const r = at && el.contains(at.startContainer) ? at : caret.current ? rangeAt(el, caret.current[0], caret.current[1]) : endOf(el)
      r.deleteContents()
      r.insertNode(img)
      r.setStartAfter(img)
      r.collapse(true)
      if (document.activeElement === el) { const s = getSelection()!; s.removeAllRanges(); s.addRange(r) }
      at = r
      el.removeAttribute('data-empty')
      try {
        const ref = await uploadImage(f, machine)
        img.src = media(ref.url, machine)
        img.dataset.url = ref.url
        img.classList.remove('loading')
      } catch { img.remove() /* the store shows the error */ }
      sync()
      at = caret.current ? rangeAt(el, caret.current[1]) : null
    }
  }

  // Images go in the text as images; other files into uploadDir, or into its folder `sub`. Each file
  // shows at once as a pill with a spinner where it was dropped, and goes in the text there once it is uploaded.
  function attach(files: File[], at: Range | null, sub?: string) {
    const imgs = files.filter((f) => f.type.startsWith('image/'))
    const rest = uploadDir == null ? [] : files.filter((f) => !f.type.startsWith('image/'))
    if (imgs.length) void add(imgs, at)
    if (!rest.length) return
    if (!uploadDir?.trim()) { setNoDir(true); return }
    setNoDir(false)
    const el = ed.current!
    const r = at && el.contains(at.startContainer) ? at : rangeAt(el, caret.current?.[1] ?? fromDom(el).length)
    r.collapse(true)
    const pills = rest.map((f) => {
      const p = uploadNode(f.name)
      r.insertNode(p)
      r.setStartAfter(p)
      return p
    })
    el.removeAttribute('data-empty')
    void (async () => {
      for (const [i, f] of rest.entries()) {
        const pill = pills[i]
        try {
          const name = await uploadFile(f, sub ? `${uploadDir.replace(/[\\/]+$/, '')}/${sub}` : uploadDir, machine)
          if (!name) throw new Error('no upload')
          // Its × stops it: the file is in the directory, but the text does not name it.
          if (!el.contains(pill)) continue
          const pos = nodeOffset(el, pill)
          const sel = selectionOffsets(el)
          pill.remove()
          const v = fromDom(el)
          const t = (pos && !/\s/.test(v[pos - 1]) ? ' ' : '') + fileToken(sub ? `${sub}/${name}` : name) + (/^\S/.test(v.slice(pos)) ? ' ' : '')
          // The caret stays where it was in the text around the new name.
          const move = (o: number) => o >= pos ? o + t.length : o
          edit(v.slice(0, pos) + t + v.slice(pos), sel ? move(sel[0]) : pos + t.length, sel ? move(sel[1]) : pos + t.length)
        } catch { pill.remove() /* the store shows the error */ }
      }
    })()
  }

  if (attachRef) attachRef.current = (files) => attach(files, null)

  // A file pill moves where it is dropped; its × removes it.
  const dragged = useRef<HTMLElement | null>(null)
  const PILL = 'application/x-codinger-file'
  const movePill = (e: React.DragEvent) => {
    const el = ed.current!, pill = dragged.current, at = caretAt(e.clientX, e.clientY)
    dragged.current = null
    if (!pill || !el.contains(pill) || !at || !el.contains(at.startContainer)) return
    const v = fromDom(el), from = nodeOffset(el, pill), len = pillText(pill).length
    let to = rangeOffset(el, at)
    if (to >= from && to <= from + len) return
    if (to > from) to -= len
    const rest = v.slice(0, from) + v.slice(from + len)
    edit(rest.slice(0, to) + v.slice(from, from + len) + rest.slice(to), to + len)
  }
  const removePill = (pill: HTMLElement) => {
    const el = ed.current!, v = fromDom(el), from = nodeOffset(el, pill)
    edit(v.slice(0, from) + v.slice(from + pillText(pill).length), from)
  }
  // "Put it in the text": the pill becomes the text it stands for.
  const unfold = (pill: HTMLElement) => {
    const el = ed.current!
    if (!el.contains(pill)) return
    const v = fromDom(el), from = nodeOffset(el, pill), t = pasteText.get(pill) ?? ''
    edit(v.slice(0, from) + t + v.slice(from + pillText(pill).length), from + t.length)
  }

  // Markdown keys and Enter change the text here, not in the DOM.
  const keyEdit = (e: React.KeyboardEvent) => {
    const el = ed.current!
    const sel = selectionOffsets(el)
    if (!sel || composing.current) return false
    const plainEnter = e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey
    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const d = deleteKey(el, fromDom(el), sel[0], sel[1], e.key === 'Backspace')
      if (!d) return false
      // Like typing: deletes within a moment of each other are one step to undo.
      draw(el, d.value)
      select(el, d.start)
      activate(el)
      reveal(el, d.start === d.value.length)
      record(d.value, [d.start, d.start])
      emit(d.value)
      return true
    }
    const r = plainEnter ? enterKey(fromDom(el), sel[0], sel[1]) : wrapKey(e, fromDom(el), sel[0], sel[1])
    if (!r) return false
    edit(r.value, r.start, r.end)
    return true
  }
  const edit = (v: string, s: number, e = s) => {
    const snap = { v, s, e, t: 0 }
    past.current.push(snap)
    future.current = []
    apply(snap)
  }

  // Copy gives the markdown as it is; the styled DOM would copy as odd indents.
  const copy = (e: React.ClipboardEvent, cut: boolean) => {
    const el = ed.current!
    const sel = selectionOffsets(el)
    if (!sel || sel[0] === sel[1]) return
    const v = fromDom(el)
    e.preventDefault()
    e.clipboardData.setData('text/plain', v.slice(sel[0], sel[1]))
    if (cut) edit(v.slice(0, sel[0]) + v.slice(sel[1]), sel[0])
  }
  // Paste keeps the formatting of rich text, as markdown. A long text goes in as one pill.
  const paste = (e: React.ClipboardEvent) => {
    const f = uploadDir == null ? imagesFrom(e.clipboardData) : [...e.clipboardData.files]
    if (f.length) { e.preventDefault(); attach(f, null); return }
    const el = ed.current!
    const sel = selectionOffsets(el)
    const html = e.clipboardData.getData('text/html')
    let t = ((html && htmlToMarkdown(html)) || e.clipboardData.getData('text/plain')).replace(/\r\n?/g, '\n')
    if (!sel || !t || composing.current) return
    e.preventDefault()
    // A very long text goes in as a file (shared/pastes.ts). With no folder to put it in, it stays a pill.
    if (isFilePaste(t) && uploadDir?.trim()) {
      const stamp = new Date().toISOString().slice(0, 19).replace('T', '-').replace(/:/g, '')
      attach([new File([t], `paste-${stamp}.txt`, { type: 'text/plain' })], rangeAt(el, sel[0]), '.codinger/pastes')
      return
    }
    const v = fromDom(el)
    // The pill goes in at the caret, in the line, as an image does.
    if (isLongPaste(t)) t = pasteToken(t)
    edit(v.slice(0, sel[0]) + t + v.slice(sel[1]), sel[0] + t.length)
  }

  return (
    <div
      className="rich-input"
      onDragOver={(e) => { if (imagesFrom(e.dataTransfer).length || e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes(PILL)) e.preventDefault() }}
      onDrop={(e) => {
        if (e.dataTransfer.types.includes(PILL)) { e.preventDefault(); movePill(e); return }
        const f = uploadDir == null ? imagesFrom(e.dataTransfer) : [...e.dataTransfer.files]
        if (f.length) { e.preventDefault(); attach(f, caretAt(e.clientX, e.clientY)) }
      }}
    >
      {images.length > 0 && (
        <div className="thumbs">
          {images.map((im, i) => (
            <span className="thumb" key={im.url + i}>
              <img src={media(im.url, machine)} alt="" />
              <button type="button" title="Remove image" onClick={() => onImages(images.filter((_, j) => j !== i))}><XIcon size={10} /></button>
            </span>
          ))}
        </div>
      )}
      <div className="ri-field">
        <div
          ref={ed}
          className="ri-edit"
          contentEditable="plaintext-only"
          suppressContentEditableWarning
          role="textbox"
          aria-multiline
          data-placeholder={placeholder}
          style={{ minHeight: `${minRows * 20 + 12}px` }}
          onInput={sync}
          onCompositionStart={() => { composing.current = true }}
          onCompositionEnd={() => { composing.current = false; sync() }}
          onBeforeInput={(e) => {
            const t = (e.nativeEvent as InputEvent).inputType
            if (t === 'historyUndo') { e.preventDefault(); undo() }
            if (t === 'historyRedo') { e.preventDefault(); redo() }
          }}
          onScroll={() => imageCaret(ed.current!, fake.current!)}
          onMouseDown={(e) => {
            const x = (e.target as Element).closest('.ri-file-x')
            const pill = x?.closest<HTMLElement>('.ri-file')
            if (!pill) return
            e.preventDefault()
            if (pill.dataset.uploading != null) pill.remove()
            else removePill(pill)
          }}
          onClick={(e) => {
            const p = (e.target as Element).closest<HTMLElement>('.ri-paste')
            if (p && !(e.target as Element).closest('.ri-file-x')) setShown(p)
          }}
          onDragStart={(e) => {
            const pill = (e.target as Element).closest?.<HTMLElement>('.ri-file')
            if (!pill) return
            dragged.current = pill
            e.dataTransfer.setData(PILL, pill.dataset.file ?? '')
            e.dataTransfer.effectAllowed = 'move'
          }}
          onDragEnd={() => { dragged.current = null }}
          onBlur={() => imageCaret(ed.current!, fake.current!)}
          onPaste={paste}
          onCopy={(e) => copy(e, false)}
          onCut={(e) => copy(e, true)}
          onKeyDown={(e) => {
            if (onKey?.(e)) { e.preventDefault(); return }
            if (lineKey(ed.current!, e)) { e.preventDefault(); return }
            gapKey(e.nativeEvent)
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return }
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return }
            if (keyEdit(e)) { e.preventDefault(); return }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && onSubmit) { e.preventDefault(); onSubmit() }
            if (e.key === 'Escape' && onEscape) { e.preventDefault(); onEscape() }
          }}
        />
        <span ref={fake} className="ri-caret" hidden />
        <label className="attach" title={uploadDir == null ? 'Attach images' : 'Attach images or files'} onMouseDown={(e) => e.preventDefault()}>
          <input type="file" accept={uploadDir == null ? 'image/*' : undefined} multiple hidden onChange={(e) => { attach([...(e.target.files ?? [])], null); e.target.value = '' }} />
          {uploadDir == null ? <ImageIcon /> : <ClipIcon />}
        </label>
      </div>
      {shown && <PasteDialog text={pasteText.get(shown) ?? ''} onClose={() => setShown(null)} onUnfold={() => { unfold(shown); setShown(null) }} />}
      {noDir && <div className="ri-uploads muted">Choose a directory first: attached files go there.</div>}
    </div>
  )
}

// Keep the caret in view, in the field and in whatever scrolls around it. Drawing
// the text again loses the browser's own scrolling, and a new empty last line
// gives the caret no box: at the end, the caret is at the bottom of the field.
function reveal(el: HTMLElement, atEnd: boolean) {
  const s = getSelection()
  if (!s?.rangeCount || !el.contains(s.focusNode) || document.activeElement !== el) return
  const caret = () => {
    const r = s.getRangeAt(0).cloneRange()
    r.collapse(false)
    const box = r.getClientRects()[0]
    if (box?.height) return box
    const e = el.getBoundingClientRect()
    return atEnd ? new DOMRect(e.left, e.bottom - 25, 0, 20) : null
  }
  const PAD = 6
  if (atEnd) el.scrollTop = el.scrollHeight
  else {
    const b = caret(), e = el.getBoundingClientRect()
    if (b && b.bottom > e.bottom - PAD) el.scrollTop += b.bottom - e.bottom + PAD
    else if (b && b.top < e.top + PAD) el.scrollTop -= e.top + PAD - b.top
  }
  const b = caret()
  if (!b) return
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p.scrollHeight <= p.clientHeight || !/auto|scroll/.test(getComputedStyle(p).overflowY)) continue
    const pb = p.getBoundingClientRect()
    if (b.bottom > pb.bottom - PAD) p.scrollTop += b.bottom - pb.bottom + PAD
    break
  }
}

function endOf(el: HTMLElement): Range {
  const r = document.createRange()
  r.selectNodeContents(el)
  r.collapse(false)
  return r
}

export function Thumbs({ images }: { images?: ImageRef[] }) {
  if (!images?.length) return null
  return <div className="thumbs sent">{images.map((im, i) => <a key={i} href={media(im.url)} target="_blank" rel="noreferrer"><img src={media(im.url)} alt="" /></a>)}</div>
}
