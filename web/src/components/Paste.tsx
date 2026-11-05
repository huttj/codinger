// A long paste (shared/pastes.ts) shows as one pill in its line; a click shows its whole text
// in a dialog. Long comments in the margin open in the same kind of dialog. The
// dialog goes in document.body: a margin card is moved with a transform, which
// would put a fixed box inside it relative to the card.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEscape } from '../escape.ts'
import { pasteLabel, splitPastes } from '../../../shared/pastes.ts'
import { splitFiles } from '../../../shared/files.ts'
import { FileTypeIcon, openFile } from './FileBrowser.tsx'
import { FileIcon, XIcon } from './Icons.tsx'

export function TextDialog({ title, onClose, children, actions }: { title: string; onClose(): void; children: React.ReactNode; actions?: React.ReactNode }) {
  useEscape(onClose)
  // Only the body scrolls: a swipe or a wheel anywhere else in the dialog or on the
  // backdrop does nothing, so the page under the dialog does not move. React's touch
  // and wheel handlers are passive and cannot stop the scroll, so these are added here.
  const back = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = back.current!
    const stop = (e: Event) => { if (!(e.target as Element).closest('.text-modal-body')) e.preventDefault() }
    el.addEventListener('touchmove', stop, { passive: false })
    el.addEventListener('wheel', stop, { passive: false })
    return () => { el.removeEventListener('touchmove', stop); el.removeEventListener('wheel', stop) }
  }, [])
  return createPortal(
    <div ref={back} className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }} onClick={(e) => e.stopPropagation()}>
      <div className="modal wide text-modal">
        <div className="files-head">
          <h2>{title}</h2>
          <button className="icon-btn" title="Close" onClick={onClose}><XIcon size={14} /></button>
        </div>
        <div className="text-modal-body">{children}</div>
        {actions && <div className="modal-actions">{actions}</div>}
      </div>
    </div>,
    document.body,
  )
}

// `onUnfold`: in a field, put the text in its place instead of the pill.
export function PasteDialog({ text, onClose, onUnfold }: { text: string; onClose(): void; onUnfold?(): void }) {
  const [copied, setCopied] = useState(false)
  const copy = () => { void navigator.clipboard.writeText(text).then(() => setCopied(true)) }
  return (
    <TextDialog title={pasteLabel(text)} onClose={onClose} actions={<>
      {onUnfold && <button onClick={onUnfold}>Put in the message as text</button>}
      <button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
    </>}>
      <pre className="paste-text">{text}</pre>
    </TextDialog>
  )
}

export function PasteChip({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return <>
    <button className="ri-file ri-paste paste-chip" onClick={(e) => { e.stopPropagation(); setOpen(true) }}>
      <FileIcon size={12} /><span className="ri-file-name">{pasteLabel(text)}</span>
    </button>
    {open && <PasteDialog text={text} onClose={() => setOpen(false)} />}
  </>
}

// A file attached to a message (shared/files.ts), as a pill with its type; a click opens it in the Files tab.
export function FileChip({ sid, name }: { sid?: string; name: string }) {
  return (
    <button className="ri-file paste-chip file-chip" disabled={!sid} onClick={(e) => { e.stopPropagation(); if (sid) openFile(sid, name) }}>
      <FileTypeIcon name={name} /><span className="ri-file-name">{name}</span>
    </button>
  )
}

// Markdown with its pastes and attached files as pills, in the line where each was put. Each
// becomes a mark in the markdown, then a slot in the HTML that gets its pill.
export function WithPastes({ text, render, sid, className = 'md' }: { text: string; render(md: string): string; sid?: string; className?: string }) {
  const { html, chips } = useMemo(() => {
    const chips: ({ paste: string } | { file: string })[] = []
    const mark = (c: { paste: string } | { file: string }) => `\uE000${chips.push(c) - 1}\uE001`
    const md = splitPastes(text).map((c) => 'paste' in c ? mark(c) : splitFiles(c.text).map((f) => 'file' in f ? mark(f) : f.text).join('')).join('')
    return { html: render(md).replace(/\uE000(\d+)\uE001/g, '<span class="paste-slot" data-i="$1"></span>'), chips }
  }, [text, render])
  const ref = useRef<HTMLDivElement>(null)
  const [slots, setSlots] = useState<HTMLElement[]>([])
  useLayoutEffect(() => { setSlots([...ref.current!.querySelectorAll<HTMLElement>('.paste-slot')]) }, [html])
  return <>
    <div ref={ref} className={className} dangerouslySetInnerHTML={{ __html: html }} />
    {slots.map((el, i) => {
      const c = chips[Number(el.dataset.i)]
      return c && createPortal('paste' in c ? <PasteChip text={c.paste} /> : <FileChip sid={sid} name={c.file} />, el, i)
    })}
  </>
}
