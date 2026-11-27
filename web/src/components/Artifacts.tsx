// Artifacts (server/artifacts.ts) in the browser: the preview pane beside a session,
// the line each show_artifact call leaves in the conversation, the page that lists them
// all with the sessions that made them, and publishing to Prolifica. Artifacts run from
// a server on another port, so their scripts never share Codinger's origin.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Artifact, ArtifactTouch, PreviewTarget, Visibility } from '../../../shared/artifacts.ts'
import type { Block, Event } from '../../../shared/types.ts'
import { api, artifactsBase, changed, revealEvent, setPanel, state, useStore } from '../store.ts'
import { timeAgo } from '../util.ts'
import { BackIcon, ChevronIcon, CommentIcon, MoreIcon, OpenIcon, XIcon } from './Icons.tsx'
import { Splitter, useWidth } from './Splitter.tsx'
import { ArtifactNotes } from './ArtifactNotes.tsx'

const Svg = ({ size = 14, children }: { size?: number; children: React.ReactNode }) => (
  <svg className="icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>
)
export const ArtifactIcon = ({ size }: { size?: number }) => <Svg size={size}><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M2 5.5h12M5 11V9M8 11V7.5M11 11V8.5" /></Svg>
const RefreshIcon = ({ size }: { size?: number }) => <Svg size={size}><path d="M13 8a5 5 0 11-1.5-3.6" /><path d="M13 2.5v3h-3" /></Svg>
export const WideIcon = ({ size }: { size?: number }) => <Svg size={size}><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5L9 7M2.5 13.5L7 9" /></Svg>
const HistoryIcon = ({ size }: { size?: number }) => <Svg size={size}><path d="M2.5 8a5.5 5.5 0 101.6-3.9" /><path d="M2.5 2.5V5H5" /><path d="M8 5v3l2 1.5" /></Svg>
export const NarrowIcon = ({ size }: { size?: number }) => <Svg size={size}><path d="M13 6.5H9.5V3M3 9.5h3.5V13M9.5 6.5L14 2M6.5 9.5L2 14" /></Svg>

export const SHOW_ARTIFACT = 'mcp__codinger__show_artifact'
const SANDBOX = 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms allow-downloads allow-modals'

function srcOf(target: PreviewTarget, a: Artifact | undefined, port: number, at: number): string | null {
  if ('url' in target) return target.url
  const base = artifactsBase(port)
  if (!base) return null
  const v = target.v != null && target.v !== a?.latest ? `@${target.v}` : ''
  // The page tells the bridge which window holds it; t: a change to its files (or a show) loads it again.
  return `${base}/${encodeURIComponent(target.artifact)}${v}/?app=${encodeURIComponent(location.origin)}&t=${v ? 0 : a?.mtime ?? 0}-${at}`
}

const showIn = (sid: string, target: PreviewTarget) => { state.preview = { ...state.preview, [sid]: { target, at: Date.now() } }; changed() }

// Show an artifact in a session's preview pane (a click on a comment on it); one already on view stays as it is.
export function showArtifactIn(sid: string, artifact: string, v?: number) {
  const cur = state.preview[sid]?.target
  if (!cur || !('artifact' in cur) || cur.artifact !== artifact || cur.v !== v) showIn(sid, { artifact, v })
  setPanel(sid, { tab: 'preview' })
  changed()
}

// No title attribute: the browser shows it as a tooltip over the whole page.
// inline: in a message, as tall as a page there (.media-frame).
export function ArtifactFrame({ target, at = 0, hidden, inline, frameRef }: { target: PreviewTarget; at?: number; hidden?: boolean; inline?: boolean; frameRef?: React.Ref<HTMLIFrameElement> }) {
  const st = useStore()
  const a = 'artifact' in target ? st.artifacts.find((x) => x.name === target.artifact) : undefined
  if ('artifact' in target && !st.artifactsPort) return null
  if ('artifact' in target && !a) return <div className="artifact-missing muted">There is no artifact “{target.artifact}” now.</div>
  const src = srcOf(target, a, st.artifactsPort, at)
  if (!src) return hidden ? null : <div className="artifact-missing muted">Artifacts show through web.codinger.app only. Open this page there.</div>
  return <iframe ref={frameRef} className={hidden ? 'artifact-check' : inline ? 'media-frame' : 'artifact-frame'} aria-label={a?.title ?? 'Preview'} sandbox={SANDBOX} src={src} aria-hidden={hidden} tabIndex={hidden ? -1 : undefined} />
}

// ![caption](artifact:<name>@<n>) in a message: a card, not the page itself (a page in a
// message was too narrow to use). A click opens that version in the preview pane; its other
// button opens it in a new window.
export function ArtifactCard({ sid, name, v, caption }: { sid: string; name: string; v?: number; caption: string }) {
  const st = useStore()
  const a = st.artifacts.find((x) => x.name === name)
  const tab = a && srcOf({ artifact: name, v }, a, st.artifactsPort, 0)
  const title = caption.trim() || a?.title || name
  // A published transcript has no preview pane.
  const pane = !st.share && !!a
  return (
    <div className={`artifact-card${a ? '' : ' missing'}`}>
      <button className="artifact-card-main" disabled={!pane} onClick={() => showArtifactIn(sid, name, v)}>
        <span className="artifact-card-icon"><ArtifactIcon size={16} /></span>
        <span className="artifact-card-text">
          <span className="artifact-card-title">{title}</span>
          <span className="artifact-card-sub">
            {!a ? `There is no artifact “${name}” now.` : <>{caption.trim() && a.title !== title ? `${a.title} · ` : ''}{v != null ? `version ${v}${v === a.latest ? ' (latest)' : ''}` : 'latest version'}</>}
          </span>
        </span>
        {pane && <span className="artifact-card-act">Open in the pane</span>}
      </button>
      {tab && <a className="icon-btn" data-tip="Open in a new window" aria-label="Open in a new window" href={tab} target="_blank" rel="noreferrer"><OpenIcon size={14} /></a>}
    </div>
  )
}

// When an agent shows an artifact, a hidden copy loads it once, so show_artifact can
// report its script errors even when no pane shows it.
export function ArtifactCheck() {
  const st = useStore()
  const [show, setShow] = useState<{ name: string; at: number } | null>(null)
  const last = Object.values(st.preview).reduce<{ target: PreviewTarget; at: number } | null>((m, p) => !m || p.at > m.at ? p : m, null)
  useEffect(() => {
    if (!last || !('artifact' in last.target) || last.target.v != null || Date.now() - last.at > 5000) return
    setShow({ name: last.target.artifact, at: last.at })
    const t = setTimeout(() => setShow(null), 12_000)
    return () => clearTimeout(t)
  }, [last?.at])
  return show ? <ArtifactFrame key={show.at} target={{ artifact: show.name }} at={show.at} hidden /> : null
}

// The line a show_artifact call leaves in the conversation: which artifact, which version. A click shows that version.
export function ArtifactLine({ sid, b, result }: { sid: string; b: Extract<Block, { type: 'tool_use' }>; result?: Extract<Event, { t: 'tool_result' }> }) {
  const st = useStore()
  const url = typeof b.input?.url === 'string' ? b.input.url : null
  const name = String(b.input?.name ?? '')
  const a = st.artifacts.find((x) => x.name === name)
  const t = a?.edits.find((e) => e.tool === b.id)
  const first = a?.edits.find((e) => e.show) === t && !!t
  const failed = !!result && (result.isError || !result.text.startsWith('Shown'))
  const open = () => showIn(sid, url ? { url } : { artifact: name, v: t?.v })
  return (
    <div className={`tool codinger-line artifact-line${failed ? ' err' : ''}${result ? '' : ' running'}`}>
      {/* A published transcript has no preview pane. */}
      <button className={`tool-line${st.share ? ' static' : ''}`} onClick={st.share ? undefined : open} title={st.share ? undefined : failed ? result!.text : 'Show it in the preview pane'}>
        <span className="tool-icon"><ArtifactIcon size={13} /></span>
        <span className="tool-name">{url ? 'Preview' : first ? 'New artifact' : 'Artifact'}</span>
        <span className="tool-sum">
          {url ?? a?.title ?? name}
          {t?.v != null && <span className="muted"> · version {t.v}{t.v === a?.latest ? ' (latest)' : ''}</span>}
          {failed && <span> · {result!.text.split('\n')[0]}</span>}
        </span>
      </button>
    </div>
  )
}

// Publish an artifact to Prolifica: its data files, then its page. Later publishes make new
// versions there. The first press connects Codinger to Prolifica (one approval in the browser).
// v: the version on view (none: the artifact as it is now), which is what goes up.
export function PublishControl({ a, v }: { a: Artifact; v?: number }) {
  const st = useStore()
  const [open, setOpen] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [vis, setVis] = useState<Visibility>(a.published?.visibility ?? 'public')
  const [note, setNote] = useState('')
  const [replace, setReplace] = useState(false)
  const [busy, setBusy] = useState(false)
  const [made, setMade] = useState<string[] | null>(null)
  // Back from approving: go on to publishing.
  useEffect(() => { if (waiting && st.prolifica) { setWaiting(false); setOpen(true) } }, [waiting, !!st.prolifica])
  const p = a.published
  const local = v ?? a.latest
  // Already there: an old version that went up before, or the artifact unchanged since the last publish.
  const upAs = p && (v != null ? p.history?.find((h) => h.local === v)?.version : p.mtime >= a.mtime ? p.version : undefined)
  // Only who can see it changes: the version on view is there already.
  const onlyVis = upAs != null
  const press = async () => {
    if (st.prolifica) { if (!open) setVis(p?.visibility ?? 'public'); return setOpen(!open) }
    const { url } = await api<{ url: string }>('/api/prolifica/connect')
    setWaiting(true)
    window.open(url, '_blank')
  }
  // A publish runs on the server: the dialog closes, and PublishToasts follows it.
  const go = async () => {
    setBusy(true)
    try {
      if (onlyVis) setMade((await api<{ madePublic: string[] }>(`/api/artifacts/${encodeURIComponent(a.name)}/visibility`, 'POST', { visibility: vis })).madePublic)
      else { setMade(null); await api(`/api/artifacts/${encodeURIComponent(a.name)}/publish`, 'POST', { visibility: vis, note, v, replace: replace && (!!p || !!a.isle) }) }
      setNote(''); setOpen(false)
    } finally { setBusy(false) }
  }
  const running = !!a.publishing && !a.publishing.done && !a.publishing.error
  return (
    <span className="publish">
      {p && <a href={p.url} target="_blank" rel="noreferrer" className="publish-link" data-tip={`Version ${p.version} on Prolifica, published ${timeAgo(p.at)} (${p.visibility})`}>Prolifica v{p.version} <OpenIcon size={11} /></a>}
      <button className="publish-btn" disabled={running} onClick={() => void press()} data-tip={st.prolifica ? 'Publish to Prolifica' : 'Publish to Prolifica (connects Codinger to it first)'}>{waiting ? 'Approve in the browser…' : running ? 'Publishing…' : 'Publish'}</button>
      {open && (
        <div className="publish-pop">
          <div className="small">{upAs != null
            ? `v${local} is on Prolifica already, as v${upAs}.${vis !== p!.visibility ? ' This changes only who can see the page.' : ''}`
            : p && replace ? `This replaces v${p.version} of the page on Prolifica with v${local} here. Earlier versions there stay as they are.`
            : p ? `This makes v${p.version + 1} of the page on Prolifica, from v${local} here. v${p.version} there stays as it is, with its data.`
            : a.isle && replace ? `This replaces the latest version of the isle ${a.isle} on Prolifica with v${local} here. Earlier versions there stay as they are.`
            : a.isle ? `This makes the next version of the isle ${a.isle} on Prolifica, from v${local} here. If that isle is not yours, it makes a new page with the isle as its parent.`
            : `This makes a new page on Prolifica, from v${local} here.`}</div>
          <label>Who can see it
            <select value={vis} onChange={(e) => setVis(e.target.value as Visibility)}>
              <option value="public">Public: listed, anyone can remix</option>
              <option value="unlisted">Unlisted: anyone with the link</option>
              <option value="private">Private: only you</option>
            </select>
          </label>
          {vis !== 'private' && <div className="muted small">Its data goes up with it and is {vis === 'public' ? 'public' : 'visible to anyone with the link'} too.</div>}
          {(p || a.isle) && upAs == null && <label className="check"><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> {p ? `Replace v${p.version}` : 'Replace its latest version'}</label>}
          {(p || a.isle) && !onlyVis && <label>What changed<input value={note} placeholder="For the version history" onChange={(e) => setNote(e.target.value)} /></label>}
          <div className="publish-foot">
            <span className="muted small">{st.prolifica?.handle ? `As @${st.prolifica.handle}` : ''}</span>
            <button className="link" onClick={() => setOpen(false)}>Cancel</button>
            <button className="primary" disabled={busy || (onlyVis && vis === p!.visibility)} onClick={() => void go()}>{busy ? 'Publishing…' : onlyVis ? `Make it ${vis}` : p && replace ? `Replace v${p.version}` : p ? `Publish v${p.version + 1}` : a.isle && replace ? 'Replace latest' : a.isle ? 'Publish next version' : 'Publish'}</button>
          </div>
        </div>
      )}
      {made && made.length > 0 && <span className="muted small" title={made.join('\n')}>{made.length} data {made.length === 1 ? 'file is' : 'files are'} public now</span>}
    </span>
  )
}

// A notice for each publish that runs, or ended and was not closed: the step it does now and a
// bar. It stays until the user closes it, so the result is not missed.
export function PublishToasts() {
  const st = useStore()
  return <>{st.artifacts.filter((a) => a.publishing).map((a) => {
    const p = a.publishing!
    const ended = !!(p.done || p.error)
    return (
      <div key={`${a.name}:${p.at}`} className={`publish-toast${p.error ? ' err' : ''}`} role="status">
        <div className="publish-toast-head">
          <b>{p.error ? `Could not publish ${a.title}` : p.done ? `Published ${a.title}` : `Publishing ${a.title}`}</b>
          {ended && <button className="icon-btn" aria-label="Close" onClick={() => void api(`/api/artifacts/${encodeURIComponent(a.name)}/publishing`, 'DELETE')}><XIcon size={12} /></button>}
        </div>
        {p.error ? <div className="small">{p.error}</div>
          : p.done ? <div className="small">It is v{p.done.version} on Prolifica. <a href={p.done.url} target="_blank" rel="noreferrer">Open it <OpenIcon size={10} /></a>
              {p.done.madePublic.length > 0 && <div className="muted">{p.done.madePublic.length} data {p.done.madePublic.length === 1 ? 'file is' : 'files are'} public now.</div>}</div>
          : <>
              <div className="small muted">{p.step}…</div>
              <div className="publish-bar"><span style={{ width: `${Math.max(4, (p.n / p.of) * 100)}%` }} /></div>
            </>}
      </div>
    )
  })}</>
}

// A small menu in place of a native select: the current choice on a button, the choices below it.
// short: what the button says when it is chosen (the label by default).
type Choice<T> = { value: T; label: string; sub?: string; short?: string }
function Picker<T>({ value, choices, onPick, label, className }: { value: T; choices: Choice<T>[]; onPick(v: T): void; label: string; className?: string }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key) }
  }, [open])
  const cur = choices.find((c) => c.value === value)
  return (
    <div className={`menu-wrap picker${className ? ' ' + className : ''}`} ref={box}>
      <button className={`picker-btn${open ? ' on' : ''}`} aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="picker-label">{cur?.short ?? cur?.label ?? label}</span><ChevronIcon size={11} className="picker-caret" />
      </button>
      {open && (
        <div className="menu picker-menu" role="listbox">
          {choices.map((c, i) => (
            <button key={i} role="option" aria-selected={c.value === value} className={c.value === value ? 'on' : ''} onClick={() => { setOpen(false); onPick(c.value) }}>
              <span>{c.label}</span>{c.sub && <span className="picker-sub">{c.sub}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// Which version shows: the latest (the artifact as it is now) or any one kept, newest first,
// each with when and which session left it.
function VersionPicker({ a, v, onPick }: { a: Artifact; v?: number; onPick(v?: number): void }) {
  const st = useStore()
  if (!a.versions?.length) return null
  const on = (n: number) => { const h = a.published?.history?.find((x) => x.local === n); return h && `Prolifica v${h.version}` }
  const who = (n: number) => { const t = a.edits.find((e) => e.v === n); return t && st.sessions.find((x) => x.id === t.sid)?.title }
  const choices = [...a.versions].reverse().map((x) => ({
    value: x.n === a.latest ? 0 : x.n,
    label: x.n === a.latest ? `Latest · v${x.n}` : `Version ${x.n}`,
    short: `v${x.n}`,
    sub: [timeAgo(x.at), who(x.n), on(x.n)].filter(Boolean).join(' · '),
  }))
  return <Picker label="Version" className="version-picker" value={v != null && v !== a.latest ? v : 0} choices={choices} onPick={(n) => onPick(n || undefined)} />
}

// An old version is showing: say so, with the way back to the artifact as it is now.
function VersionBar({ a, v, onLatest }: { a: Artifact; v: number; onLatest(): void }) {
  if (v === a.latest) return null
  return <div className="artifact-version">Version {v} of {a.latest}<button className="link" onClick={onLatest}>Show the latest</button></div>
}

// The Preview tab of the panel beside a session (SidePanel.tsx): what its agent showed last, or
// an artifact it worked on.
export function ArtifactPane({ sid }: { sid: string }) {
  const st = useStore()
  const mine = st.artifacts.filter((a) => a.edits.some((e) => e.sid === sid))
  const shown = st.preview[sid]
  const target: PreviewTarget | null = shown?.target ?? (mine[0] ? { artifact: mine[0].name } : null)
  const [reload, setReload] = useState(0)
  const a = target && 'artifact' in target ? st.artifacts.find((x) => x.name === target.artifact) : undefined
  const v = target && 'artifact' in target ? target.v : undefined
  const key = target ? ('url' in target ? target.url : `${target.artifact}@${v ?? ''}`) : ''
  const tab = target && srcOf(target, a, st.artifactsPort, 0)
  const frame = useRef<HTMLIFrameElement>(null)
  // Comment mode: a click in the page starts a comment (ArtifactNotes.tsx).
  const [commenting, setCommenting] = useState(false)
  return (
    <div className="artifact-pane">
      <div className="artifact-top">
        {target && 'url' in target
          ? <span className="artifact-url" title={target.url}>{target.url}</span>
          : <Picker label="Artifact" className="artifact-picker" value={a?.name ?? ''} onPick={(name) => showIn(sid, { artifact: name })}
            choices={(a && !mine.includes(a) ? [a, ...mine] : mine).map((x) => ({ value: x.name, label: x.title, sub: timeAgo(x.mtime) }))} />}
        <span className="grow" />
        {/* The title at the left; the view's buttons, then the version and Publish together, at the right. */}
        {a && <button className={`icon-btn${commenting ? ' on' : ''}`} aria-pressed={commenting} data-tip={commenting ? 'Stop commenting (tap Option)' : 'Comment on what you click (tap Option)'} onClick={() => setCommenting(!commenting)}><CommentIcon size={14} /></button>}
        <button className="icon-btn" data-tip="Load again" onClick={() => setReload(Date.now())}><RefreshIcon size={14} /></button>
        {tab && <a className="icon-btn" data-tip="Open in a new tab" href={tab} target="_blank" rel="noreferrer"><OpenIcon size={14} /></a>}
        {a && <>
          <span className="artifact-sep" />
          <VersionPicker a={a} v={v} onPick={(n) => showIn(sid, { artifact: a.name, v: n })} />
          <PublishControl a={a} v={v} />
        </>}
      </div>
      {a && v != null && <VersionBar a={a} v={v} onLatest={() => showIn(sid, { artifact: a.name })} />}
      {target
        ? <div className="artifact-stage">
          <ArtifactFrame key={key} target={target} at={Math.max(shown?.at ?? 0, reload)} frameRef={frame} />
          {/* Comments on what the page shows (ArtifactNotes.tsx). */}
          {a && <ArtifactNotes key={`notes:${key}`} sid={sid} artifact={a.name} v={v != null && v !== a.latest ? v : undefined} mtime={a.mtime} frame={frame} mode={commenting} setMode={setCommenting} />}
        </div>
        : <div className="artifact-missing muted">Nothing to show yet.</div>}
    </div>
  )
}

// Whether a session has anything for its preview pane.
export const hasPreview = (sid: string) => !!state.preview[sid] || state.artifacts.some((a) => a.edits.some((e) => e.sid === sid))

function TouchRow({ a, t, on, onShow }: { a: Artifact; t: ArtifactTouch; on: boolean; onShow(): void }) {
  const st = useStore()
  const s = st.sessions.find((x) => x.id === t.sid)
  const verb = a.created === t || (a.created?.sid === t.sid && a.created.seq === t.seq && a.created.tool === t.tool) ? 'made it' : t.show ? 'showed it' : 'changed it'
  return (
    <li className={on ? 'on' : ''}>
      {t.v != null ? <button className="link version" onClick={onShow}>Version {t.v}</button> : <span className="muted version">Before versions</span>}
      <span className="muted"> {s ? <button className="link" data-tip="Open the session at this message" onClick={() => revealEvent(t.sid, t.seq)}>{s.title}</button> : 'a session that is gone'} {verb} {timeAgo(t.ts)}</span>
    </li>
  )
}

// The description on one line, with Show more when it does not fit there.
function Description({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null)
  const [open, setOpen] = useState(false)
  const [cut, setCut] = useState(false)
  useLayoutEffect(() => {
    const p = ref.current
    if (!p || open) return
    const check = () => setCut(p.scrollWidth > p.clientWidth + 1)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(p)
    return () => ro.disconnect()
  }, [text, open])
  return (
    <div className={`artifact-desc${open ? ' open' : ''}`}>
      <p ref={ref} className="muted">{text}</p>
      {(cut || open) && <button className="link small" onClick={() => setOpen(!open)}>{open ? 'Show less' : 'Show more'}</button>}
    </div>
  )
}

// Show an artifact on the Artifacts page from elsewhere (the command palette): on a phone, the
// artifact itself, not the list.
let pickNext = false
export function openArtifact(name: string) {
  state.page = 'artifacts'; state.artifact = name; state.artifactV = undefined; state.sideOpen = false
  pickNext = true
  changed()
}

// Every artifact: what it is, which sessions made and changed it, and whether it is published.
export function ArtifactsView() {
  const st = useStore()
  // The artifact and the version on view are in the page's address (url.ts).
  const v = st.artifactV
  const setV = (n?: number) => { state.artifactV = n; changed() }
  const a = st.artifacts.find((x) => x.name === st.artifact) ?? st.artifacts[0]
  // On a phone the list and the artifact take turns: a tap shows the artifact, Back the list.
  // There the version, Publish and the history wait behind a menu button.
  const [picked, setPicked] = useState(false)
  useEffect(() => { if (pickNext) { pickNext = false; setPicked(true) } })
  const [more, setMore] = useState(false)
  const choose = (name: string) => { state.artifact = name; state.artifactV = undefined; setPicked(true); setMore(false); changed() }
  // As the preview pane has: load again, a new tab, the full width (no list); and the history can hide.
  const [reload, setReload] = useState(0)
  const [full, setFull] = useState(false)
  const [history, setHistory] = useState(() => localStorage.getItem('codinger.artifactHistory') !== 'off')
  const showHistory = (on: boolean) => { setHistory(on); localStorage.setItem('codinger.artifactHistory', on ? 'on' : 'off') }
  const tab = a && srcOf({ artifact: a.name, v }, a, st.artifactsPort, 0)
  // The list's width and the history's height: drag their borders.
  const [listW, setListW] = useWidth('artifactsList', 300)
  const [histH, setHistH] = useWidth('artifactsHistory', 180)
  // One line for each version, at the call that left it.
  const touches = a ? [...a.edits].reverse().filter((t, i, all) => t.v == null || all.findIndex((x) => x.v === t.v) === i) : []
  return (
    <div className={`artifacts-view${picked ? ' picked' : ''}${full ? ' full' : ''}${history ? '' : ' no-history'}`}>
      <div className="artifacts-list" style={{ width: listW }}>
        <div className="artifacts-head">
          <h1>Artifacts</h1>
          <button className="icon-btn" data-tip="Back to the session" onClick={() => { state.page = null; changed() }}><XIcon size={14} /></button>
        </div>
        {st.prolifica && (
          <div className="artifacts-conn muted small">
            Prolifica: {st.prolifica.handle ? `@${st.prolifica.handle}` : 'connected'}
            <button className="link" onClick={() => void api('/api/prolifica', 'DELETE')}>Disconnect</button>
          </div>
        )}
        {!st.artifacts.length && <div className="muted artifacts-empty">No artifacts yet. Ask an agent to make one, for example a chart of some data.</div>}
        {st.artifacts.map((x) => {
          const sids = new Set(x.edits.map((e) => e.sid))
          return (
            <button key={x.name} className={`artifact-row${x === a ? ' active' : ''}`} onClick={() => choose(x.name)}>
              <span className="artifact-title">{x.title}</span>
              <span className="muted small">
                {timeAgo(x.mtime)}{sids.size > 0 && ` · ${sids.size} ${sids.size === 1 ? 'session' : 'sessions'}`}
                {x.published ? ` · published v${x.published.version}${x.published.mtime < x.mtime ? ', changed since' : ''}` : ' · not published'}
              </span>
              {x.error && <span className="small err">{x.error}</span>}
            </button>
          )
        })}
      </div>
      {!full && <Splitter width={listW} setWidth={setListW} min={200} max={640} initial={300} />}
      {a && (
        <div className={`artifact-detail${more ? ' more-open' : ''}`}>
          <div className="artifact-detail-head">
            <button className="icon-btn artifact-back" aria-label="Back to the list" onClick={() => setPicked(false)}><BackIcon size={16} /></button>
            <div className="grow">
              <h2>{a.title}</h2>
              {a.description && <Description key={a.name} text={a.description} />}
            </div>
            <button className="icon-btn artifact-more" aria-label="Version and publishing" aria-expanded={more} onClick={() => setMore(!more)}><MoreIcon size={18} /></button>
            <h2 className="artifact-more-title">{a.title}</h2>
            {a.description && <p className="muted artifact-more-desc">{a.description}</p>}
            <span className="artifact-detail-actions">
              <button className="icon-btn" data-tip="Load again" onClick={() => setReload(Date.now())}><RefreshIcon size={14} /></button>
              {tab && <a className="icon-btn" data-tip="Open in a new tab" href={tab} target="_blank" rel="noreferrer"><OpenIcon size={14} /></a>}
              <button className="icon-btn artifact-desk" data-tip={full ? 'Show the list' : 'Use the full width'} onClick={() => setFull(!full)}>{full ? <NarrowIcon size={14} /> : <WideIcon size={14} />}</button>
              <button className={`icon-btn artifact-desk${history ? ' on' : ''}`} data-tip={history ? 'Hide the history' : 'Show the history'} onClick={() => showHistory(!history)}><HistoryIcon size={14} /></button>
              <span className="artifact-sep" />
              <VersionPicker a={a} v={v} onPick={setV} />
              <PublishControl key={a.name} a={a} v={v} />
            </span>
          </div>
          {v != null && <VersionBar a={a} v={v} onLatest={() => setV(undefined)} />}
          <ArtifactFrame key={`${a.name}@${v ?? ''}`} target={{ artifact: a.name, v }} at={reload} />
          <Splitter width={histH} setWidth={setHistH} min={60} max={700} initial={180} vertical reverse />
          <div className="artifact-history" style={{ '--hist-h': `${histH}px` } as React.CSSProperties}>
            <h3>History</h3>
            {!touches.length && <div className="muted small">No session has written it since Codinger began to record.</div>}
            <ul>{touches.map((t) => <TouchRow key={`${t.sid}:${t.seq}:${t.tool ?? ''}`} a={a} t={t} on={t.v != null && t.v === (v ?? a.latest)} onShow={() => setV(t.v === a.latest ? undefined : t.v)} />)}</ul>
            <div className="muted small">Folder: <code>~/.codinger/artifacts/{a.name}</code></div>
          </div>
        </div>
      )}
    </div>
  )
}
