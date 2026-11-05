// The Files tab of the panel beside a session (SidePanel.tsx): a search of its files, the files the
// agent wrote or edited, the files you attached (shared/files.ts), its folder as a tree, and the
// file you pick (FileView.tsx), beside the list when there is room and in its place when not. A path
// in a reply opens here too (AssistantMessage.tsx). The server decides which files the tab may open
// (server/files.ts).

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SessionMeta } from '../../../shared/types.ts'
import { filesIn } from '../../../shared/files.ts'
import { api, changed, LOCAL, localId, machineOf, media, panelOf, setPanel, state, useStore } from '../store.ts'
import { ChevronIcon, FolderIcon } from './Icons.tsx'
import { Splitter, useWidth } from './Splitter.tsx'
import { baseName, dirName, FileView, ltr, sepOf, type Edit, type ReviewOf } from './FileView.tsx'
import { groupOfFile, ReviewSection, useReview } from './Review.tsx'
import { setFileVerdict, uncommittedOf } from '../review.ts'

type Entry = { name: string; kind: 'dir' | 'file'; size: number; mtime: number; dim?: boolean; secret?: boolean }
type Node = { path: string; kind: 'dir'; entries: Entry[] } | { path: string; kind: 'file'; size: number; mtime: number }

// The files attached to its messages, newest first.
export function filesOf(sid: string): string[] {
  const names: string[] = []
  for (const e of state.events[sid] ?? []) if (e.t === 'user') for (const p of e.parts) names.push(...filesIn(p.text ?? ''))
  return [...new Set(names.reverse())]
}

// The edits the agent made, by file, the newest file first.
function editsOf(sid: string): Map<string, Edit[]> {
  const out = new Map<string, Edit[]>()
  for (const e of state.events[sid] ?? []) {
    if (e.t !== 'assistant') continue
    for (const b of e.blocks) {
      if (b.type !== 'tool_use' || !/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(b.name)) continue
      const p = b.input?.file_path ?? b.input?.notebook_path
      if (typeof p !== 'string') continue
      const list = out.get(p) ?? []
      out.delete(p)
      if (b.name === 'Write' && typeof b.input.content === 'string') list.push({ new: b.input.content })
      else if (b.name === 'Edit' && typeof b.input.new_string === 'string') list.push({ old: b.input.old_string ?? '', new: b.input.new_string })
      else if (b.name === 'MultiEdit' && Array.isArray(b.input.edits)) for (const x of b.input.edits) list.push({ old: x.old_string ?? '', new: x.new_string ?? '' })
      out.set(p, list)
    }
  }
  return new Map([...out].reverse())
}

// Opens the Files tab on a path (absolute, ~/, or under the session's directory), maybe with :line.
// changes: show what changed in it; group: the group for review it was opened from (Review.tsx);
// seq: the message that names it, when that is not the group's.
export function openFile(sid: string, p: string, changes = false, group?: string, seq = group ? parseInt(group) : undefined) {
  const m = /^(.*?)(?::(\d+))?(?::\d+)?$/.exec(p.trim())!
  setPanel(sid, { tab: 'files' })
  state.fileOpen = { ...state.fileOpen, [sid]: { path: m[1], line: m[2] ? Number(m[2]) : undefined, changes, group, seq, at: Date.now() } }
  changed()
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url)
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error ?? `${r.status} ${r.statusText}`)
  return j
}

// width: the panel's width, so the first view already has the right layout (no flash).
export function FileBrowser({ m, width }: { m: SessionMeta; width: number }) {
  const st = useStore()
  const machine = machineOf(m.id)
  const base = `/api/sessions/${localId(m.id)}`
  const q = (p: string) => `path=${encodeURIComponent(p)}`
  const fsUrl = (p: string) => media(`${base}/fs?${q(p)}`, machine)
  const fileUrl = (p: string, run = false) => media(`${base}/file?${q(p)}${run ? '&run=1' : ''}`, machine)
  const [root, setRoot] = useState<string | null>(null)
  const [roots, setRoots] = useState<string[]>([])     // folders outside the session's folder that a link opened
  const [dirs, setDirs] = useState<Record<string, Entry[] | string>>({})
  const [open, setOpen] = useState<Set<string>>(new Set())
  // named: its path in its group for review; path: where it is, which can differ (server/files.ts locate).
  const [file, setFile] = useState<{ path: string; named: string; size: number; line?: number; changes: boolean; group?: string; at: number } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [stamp, setStamp] = useState(0)                // a change makes the open file load again
  const [search, setSearch] = useState('')
  const [found, setFound] = useState<string[] | null>(null)
  const [treeW, setTreeW] = useWidth(`filetree.${m.id}`, 240)
  // Beside a file, the list can hide, so the file has the whole width (kept for each session).
  const listOn = panelOf(m.id).list !== false
  const toggleList = () => { setPanel(m.id, { list: !listOn }); changed() }
  const want = st.fileOpen[m.id]

  // Its own width: the list and the file side by side when there is room.
  const el = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(width)
  useLayoutEffect(() => {
    const ro = new ResizeObserver(() => setW(el.current?.clientWidth || width))
    if (el.current) { ro.observe(el.current); setW(el.current.clientWidth || width) }
    return () => ro.disconnect()
  }, [])
  const split = w >= 600

  const load = (dir: string) => getJson<Node>(fsUrl(dir))
    .then((n) => { if (n.kind === 'dir') setDirs((d) => ({ ...d, [dir]: n.entries })) })
    .catch((e: Error) => setDirs((d) => ({ ...d, [dir]: e.message })))

  useEffect(() => {
    void getJson<Node>(fsUrl('.')).then((n) => {
      setRoot(n.path)
      if (n.kind === 'dir') setDirs((d) => ({ ...d, [n.path]: n.entries }))
    }).catch((e: Error) => setErr(e.message))
  }, [m.id])

  // A path to show (a link in a reply, or a pick in the list): a folder opens in the tree, a file in the viewer.
  useEffect(() => {
    if (!want) { setFile(null); setErr(null); return }
    if (!root) return
    setErr(null)
    void getJson<Node>(fsUrl(want.path) + (want.seq ? `&seq=${want.seq}` : '')).then((n) => {
      const inRoot = n.path === root || n.path.startsWith(root + sepOf(n.path))
      if (!inRoot && n.kind === 'dir' && !roots.includes(n.path)) setRoots((r) => [...r, n.path])
      // Open the folders down to it.
      const chain: string[] = []
      for (let d = n.kind === 'dir' ? n.path : dirName(n.path); inRoot && d.length >= root.length; d = dirName(d)) { chain.push(d); if (d === root) break }
      if (n.kind === 'dir') { chain.push(n.path); setDirs((d) => ({ ...d, [n.path]: n.entries })) }
      setOpen((o) => new Set([...o, ...chain]))
      for (const d of chain) if (!dirs[d]) void load(d)
      setFile(n.kind === 'file' ? { path: n.path, named: want.group ? want.path : n.path, size: n.size, line: want.line, changes: !!want.changes, group: want.group, at: want.at } : null)
    }).catch((e: Error) => { setFile(null); setErr(`${want.path}: ${e.message}`) })
  }, [want?.at, root])

  // When the agent works, the folders and the file on view load again.
  const n = st.events[m.id]?.length ?? 0
  useEffect(() => {
    if (!n || !root) return
    const t = setTimeout(() => {
      for (const d of open) if (dirs[d]) void load(d)
      setStamp((s) => s + 1)
    }, 1500)
    return () => clearTimeout(t)
  }, [n])

  // A search of the file names, as you type.
  useEffect(() => {
    if (!search.trim()) { setFound(null); return }
    let gone = false
    const t = setTimeout(() => void getJson<string[]>(media(`${base}/find?q=${encodeURIComponent(search)}`, machine))
      .then((r) => { if (!gone) setFound(r) }).catch(() => { if (!gone) setFound([]) }), 120)
    return () => { gone = true; clearTimeout(t) }
  }, [search])

  // The tree's root is the folder's real path; the agent can name it by another (a link such as /tmp).
  const rel = (p: string) => {
    if (root && p.startsWith(root + sepOf(p))) return p.slice(root.length + 1)
    if (p.startsWith(m.cwd + sepOf(p))) return p.slice(m.cwd.length + 1)
    return st.home && p.startsWith(st.home) ? '~' + p.slice(st.home.length) : p
  }
  const pick = (p: string, changes = false) => openFile(m.id, p, changes)
  const toggle = (d: string) => setOpen((o) => {
    const x = new Set(o)
    if (x.has(d)) x.delete(d); else { x.add(d); if (!dirs[d]) void load(d) }
    return x
  })
  const isOn = (p: string) => !!file && (file.path === p || rel(file.path) === p || rel(file.path) === rel(p) || rel(file.named) === rel(p))

  const tree = (dir: string, depth: number): React.ReactNode => {
    const list = dirs[dir]
    const pad = { paddingLeft: 8 + depth * 14 }
    if (list === undefined) return <div className="fb-note muted" style={pad}>Loading…</div>
    if (typeof list === 'string') return <div className="fb-note muted" style={pad}>{list}</div>
    if (!list.length) return <div className="fb-note muted" style={pad}>Empty</div>
    const sep = sepOf(dir)
    return list.map((e) => {
      const p = dir + sep + e.name
      const isOpen = open.has(p)
      return (
        <div key={e.name}>
          <button className={`fb-row${e.dim ? ' dim' : ''}${isOn(p) ? ' on' : ''}`} style={{ paddingLeft: 4 + depth * 14 }}
            disabled={e.secret} onClick={() => e.kind === 'dir' ? toggle(p) : pick(p)}>
            {e.kind === 'dir' ? <span className={`fb-chev${isOpen ? ' open' : ''}`}><ChevronIcon size={10} /></span> : <span className="fb-chev" />}
            {e.kind === 'dir' ? <FolderIcon size={13} /> : <FileTypeIcon name={e.name} />}
            <span className="fb-name">{e.name}</span>
            {e.secret && <span className="fb-dir muted">can hold keys, not shown</span>}
          </button>
          {e.kind === 'dir' && isOpen && tree(p, depth + 1)}
        </div>
      )
    })
  }

  const edits = editsOf(m.id)
  const rv = useReview(m)
  const flat = (title: string | null, paths: string[], changes = false, action?: React.ReactNode) => paths.length > 0 && (
    <div className="fb-group">
      {title && <div className="attention-head">{title}{action && <><span className="grow" />{action}</>}</div>}
      {paths.map((p) => (
        <button key={p} className={`fb-row${isOn(p) ? ' on' : ''}`} onClick={() => pick(p, changes)}>
          <FileTypeIcon name={p} /><span className="fb-name">{baseName(p)}</span>
          <span className="fb-dir muted">{ltr(dirName(rel(p)))}</span>
        </button>
      ))}
    </div>
  )
  // Commit and push: asks the agent, which knows which changes are its own and writes the message
  // as the repository does. Shown while a file changed in this session has uncommitted changes.
  const git = uncommittedOf(m.id)
  const dirty = !!git && [...edits.keys()].some((p) => git.has(rel(p)) || git.has(p))
  const [asked, setAsked] = useState(false)
  const commit = dirty && <button className="link fb-commit" data-pid="commit-push" disabled={asked} onClick={() => {
    setAsked(true)
    void api(`/api/sessions/${m.id}/send`, 'POST', { parts: [{ kind: 'text', text: 'Commit and push the changes you made in this session. Leave out the changes of other sessions.' }] })
      .finally(() => setAsked(false))
  }}>Commit and push</button>
  const close = () => {
    setFile(null)
    setErr(null)
    const { [m.id]: _, ...rest } = state.fileOpen
    state.fileOpen = rest
    changed()
  }
  const list = (
    <div className="fb-side" style={split && file ? { width: treeW } : undefined}>
      <input className="fb-search" type="search" placeholder="Search files" value={search} data-pid="file-search"
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && found?.[0]) pick(found[0])
          else if (e.key === 'Escape' && search) { e.preventDefault(); setSearch('') }
        }} />
      <div className="fb-list">
        {found ? (found.length ? flat(null, found) : <div className="fb-note muted">No file has that in its name.</div>)
          : <>
            <ReviewSection m={m} rel={rel} isOn={isOn} onOpen={(p, g) => openFile(m.id, p, true, g)} />
            {flat('Changed in this session', [...edits.keys()].slice(0, 30), true, commit)}
            {flat('Attached', filesOf(m.id))}
            {root && <div className="fb-group">
              <div className="attention-head">{baseName(root)}</div>
              {tree(root, 0)}
            </div>}
            {roots.map((r) => <div key={r} className="fb-group"><div className="attention-head">{rel(r)}</div>{tree(r, 0)}</div>)}
          </>}
      </div>
    </div>
  )
  const fileEdits = file ? [...edits].find(([p]) => p === file.path || rel(p) === rel(file.path))?.[1] ?? [] : []
  // The open file's group for review, its verdict, and the next file of the groups that has none.
  let review: ReviewOf | undefined
  const g = file && groupOfFile(rv.shown, file.named, file.group, rel)
  const path = g && g.files.find((f) => rel(f) === rel(file!.named))   // as the agent named it
  if (g && path) {
    const v = rv.of(g.key, path)
    const order = rv.shown.flatMap((x) => x.files.map((f) => ({ g: x.key, f })))
    const here = order.findIndex((x) => x.g === g.key && x.f === path)
    const next = [...order.slice(here + 1), ...order.slice(0, here)].find((x) => !rv.of(x.g, x.f).verdict)
    review = {
      group: g.key, verdict: v.verdict, sent: v.sent,
      onVerdict: (x) => setFileVerdict(m.id, g, path, rel, x),
      next: next && { label: baseName(next.f), go: () => openFile(m.id, next.f, true, next.g) },
    }
  }
  return (
    <div ref={el} className={`file-browser${split ? ' split' : ''}`}>
      {err && !file && <div className="fb-note error-text">{err}</div>}
      <div className="fb-body">
        {(split ? !file || listOn : !file) && list}
        {split && file && listOn && <Splitter width={treeW} setWidth={setTreeW} min={160} max={Math.max(200, w - 280)} initial={240} />}
        {file && <FileView key={file.path} sid={m.id} review={review} path={file.path} size={file.size} line={file.line} at={file.at} stamp={stamp} rel={rel(file.path)}
          changes={file.changes} edits={fileEdits} url={fileUrl}
          tabUrl={media(`${base}/file/${encodeURIComponent(baseName(file.path))}?${q(file.path)}&run=1`, machine)}
          diffUrl={media(`${base}/diff?${q(file.path)}`, machine)}
          canBack={!split} onBack={close} reveal={machine === LOCAL && !st.web ? () => void api('/api/fs/reveal', 'POST', { path: file.path }) : undefined}
          onLink={(href) => pick(dirName(file.path) + sepOf(file.path) + href)} list={split ? { shown: listOn, toggle: toggleList } : undefined} />}
      </div>
    </div>
  )
}

// An icon for a file by its type: its colour says the language or kind, its mark the kind.
type Mark = 'code' | 'doc' | 'data' | 'image' | 'video' | 'audio' | 'pdf' | 'key' | 'plain'
const TYPES: [RegExp, Mark, string][] = [
  [/\.(tsx?|mts|cts)$/, 'code', '#3178c6'], [/\.(jsx?|mjs|cjs)$/, 'code', '#c9a227'], [/\.py$/, 'code', '#3b78b8'],
  [/\.go$/, 'code', '#00a7cf'], [/\.rs$/, 'code', '#c45f2b'], [/\.(sh|zsh|bash|ps1)$/, 'code', '#3f9c4b'],
  [/\.(css|scss|less)$/, 'code', '#8b5cf6'], [/\.(html?|xml|svelte|vue)$/, 'code', '#e0573e'], [/\.(c|h|cpp|hpp|java|kt|swift|rb|php|lua)$/, 'code', '#7c8ea3'],
  [/\.(md|markdown|mdx)$/, 'doc', '#4f8fd6'], [/\.(txt|log|rst)$/, 'doc', '#8a8a8a'],
  [/\.(json|jsonl|ya?ml|toml|ini|lock)$/, 'data', '#c98a2b'], [/\.(csv|tsv|xlsx?|sqlite|db|sql)$/, 'data', '#2e9b5b'],
  [/\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/, 'image', '#d1559c'], [/\.(mp4|m4v|webm|mov|ogv)$/, 'video', '#9a5bd0'],
  [/\.(mp3|wav|m4a|aac|ogg|oga|opus|flac)$/, 'audio', '#26a093'], [/\.pdf$/, 'pdf', '#d64a45'],
  [/(^|\/)\.env(\..+)?$|\.(pem|key)$/, 'key', '#a08a5a'],
]
const MARKS: Record<Mark, string> = {
  code: 'M7 8.5L5.5 10.25 7 12M9 8.5l1.5 1.75L9 12',
  doc: 'M5.5 8.5h5M5.5 10.5h5M5.5 12.5h3',
  data: 'M5.5 8.5h5v4h-5zM5.5 10.5h5M8 8.5v4',
  image: 'M5 12.5l2-2.5 1.5 1.5 1-1 1.5 2',
  video: 'M6.5 8.5v4l3.5-2z',
  audio: 'M7 12.5a1 1 0 11-.01 0M8 12.5V8.5l2.5-.5',
  pdf: 'M5.5 9h5M5.5 11h5M5.5 13h2',
  key: 'M7 11.25a1.25 1.25 0 11-.01 0M8.2 11.25h2.8M10 11.25v1.25',
  plain: '',
}
export function FileTypeIcon({ name }: { name: string }) {
  const t = TYPES.find(([re]) => re.test(name.toLowerCase()))
  const [mark, color] = t ? [t[1], t[2]] : ['plain' as Mark, 'currentColor']
  return (
    <svg className="fb-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 2h5l3 3v9H4z" opacity={t ? 0.9 : 0.6} /><path d="M9 2v3h3" opacity={t ? 0.9 : 0.6} />
      {MARKS[mark] && <path d={MARKS[mark]} />}
    </svg>
  )
}
