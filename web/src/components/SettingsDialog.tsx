// Settings, in tabs: general options, appearance, and the notes files you and Claude keep (AGENTS.md,
// CLAUDE.md, the lead's LEAD_NOTES.md, and any you add), each with its history.
// Read shows a file rendered, every block marked by when it last changed and
// by whom (server/filehistory.ts); clicking a block lists its changes, with
// links to the conversations that made them.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useEscape } from '../escape.ts'
import type { Token, Tokens } from 'marked'
import DOMPurify from 'dompurify'
import { api, changed, revealEvent, select, state, useStore } from '../store.ts'
import { marked, timeAgo } from '../util.ts'
import { shortPath } from './DirPicker.tsx'
import { XIcon } from './Icons.tsx'
import { AppearancePanel } from './AppearanceDialog.tsx'
import { StartContext } from './StartContext.tsx'
import { CostPanel } from './CostPanel.tsx'
import { EstimatesPanel } from './EstimatesPanel.tsx'
import { RemotePanel } from './RemotePanel.tsx'
import { DEFAULT_CACHE_GUARD } from '../../../shared/cache.ts'
import { KEEP_WARM } from '../../../shared/notes.ts'
import { disablePush, enablePush, pushSubscribed, pushSupported } from '../push.ts'

const GUARDS = [0, 20_000, 50_000, 100_000, 250_000, 500_000]
const WARM_HOURS = [0, 1, 2, 4, 6, 8, 12, 16, 24]
const WARM_MAX = [200_000, 300_000, 500_000, 750_000, 1_000_000]
const WARM_USAGE = [50, 70, 80, 90, 100]
const PAGES = [['general', 'General'], ['cost', 'Plan and cost'], ['estimates', 'Estimates'], ['appearance', 'Appearance'], ['context', 'Start-up context'], ['files', 'Notes files'], ['remote', 'Remote access']] as const
export type Page = typeof PAGES[number][0]

type FileRow = { path: string; builtIn: boolean; exists: boolean; versions: number; last: number | null }
type By =
  | { kind: 'initial' } | { kind: 'settings' } | { kind: 'outside' }
  | { kind: 'session'; sid: string; title: string; seq: number }
  | { kind: 'claude'; csid: string; cwd: string }
type VersionInfo = { ts: number; by: By; added: number; removed: number }
type Blame = { path: string; exists: boolean; text: string; lines: number[]; versions: VersionInfo[]; outOfDate: boolean }

const who = (by: By) =>
  by.kind === 'initial' ? 'First seen'
  : by.kind === 'settings' ? 'You, in Settings'
  : by.kind === 'session' ? `Codinger session "${by.title}"`
  : by.kind === 'claude' ? `Claude Code in ${shortPath(by.cwd)}`
  : 'Outside Codinger'

export function SettingsDialog({ onClose }: { onClose(): void }) {
  const st = useStore()
  const [files, setFiles] = useState<FileRow[]>([])
  const [sel, setSel] = useState('')
  const [tab, setTab] = useState<'read' | 'edit' | 'history'>('read')
  const [blame, setBlame] = useState<Blame | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState('')
  const tick = sel ? st.fileTick[sel] ?? 0 : 0

  // The page is in the page's address (url.ts).
  const page: Page = PAGES.find(([p]) => p === st.settingsPage)?.[0] ?? 'general'
  const go = (p: Page) => { localStorage.setItem('codinger.settingsPage', p); state.settingsPage = p; changed() }
  const guard = st.settings.cacheGuard ?? DEFAULT_CACHE_GUARD
  const [stale, setStale] = useState(false)   // the server predates file history: it needs a restart
  const loadFiles = () => api<FileRow[]>('/api/files', 'GET')
    .then((f) => { setFiles(f); setSel((s) => s || f[0]?.path || '') })
    .catch(() => { setStale(true); state.error = null; changed() })
  useEffect(() => { void loadFiles() }, [])
  useEffect(() => {
    if (!sel) return
    void api<Blame>(`/api/files/blame?path=${encodeURIComponent(sel)}`, 'GET').then((b) => { setBlame(b); setText(b.text) })
  }, [sel, tick])

  const dirty = tab === 'edit' && !!blame && text !== blame.text
  // Esc does what the X does: with unsaved edits, it asks first.
  useEscape(() => { if (!dirty || confirm('Discard your changes?')) onClose() })
  const save = async () => {
    setBusy(true)
    try { const b = await api<Blame>(`/api/files?path=${encodeURIComponent(sel)}`, 'PUT', { text }); setBlame(b); setText(b.text); void loadFiles() } finally { setBusy(false) }
  }
  const pick = (p: string) => { if (dirty && !confirm('Discard your changes to this file?')) return; setSel(p); setTab('read') }
  const add = async () => {
    if (!adding.trim()) return
    const { path } = await api<{ path: string }>('/api/files/track', 'POST', { path: adding })
    setAdding('')
    await loadFiles()
    pick(path)
  }
  const untrack = async (p: string) => {
    await api(`/api/files/track?path=${encodeURIComponent(p)}`, 'DELETE')
    if (sel === p) setSel('')
    void loadFiles()
  }
  // Going to a conversation closes Settings.
  const open = (by: By) => {
    if (by.kind === 'session') { onClose(); revealEvent(by.sid, by.seq) }
    else if (by.kind === 'claude') void api<{ id: string }>(`/api/history/${by.csid}/resume`, 'POST').then((m) => { onClose(); select(m.id) })
  }

  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget && !dirty) onClose() }}>
      <div className="modal files-modal" onKeyDown={(e) => {
        if (e.key === 's' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (dirty) void save() }
      }}>
        <div className="files-head">
          <h2>Settings</h2>
          <button className="icon-btn" title="Close" onClick={() => { if (!dirty || confirm('Discard your changes?')) onClose() }}><XIcon size={14} /></button>
        </div>
        <div className="settings-body">
          <nav className="settings-tabs">
            {PAGES.map(([p, label]) => <button key={p} className={page === p ? 'on' : ''} onClick={() => go(p)}>{label}</button>)}
          </nav>
          {page === 'general' && <section className="settings-page">
            <div className="settings-group">
              <h3 className="cost-h">Notifications and messages</h3>
              <PushSetting />
              <label className="settings-check">
                <input type="checkbox" checked={st.showSteps} onChange={(e) => { state.showSteps = e.target.checked; changed() }} />
                Show Claude's in-between messages
              </label>
              {/* Only a touch screen has it; it is saved in this browser. */}
              {matchMedia('(pointer: coarse)').matches && <label className="settings-check">
                <input type="checkbox" checked={st.touchPick} onChange={(e) => { state.touchPick = e.target.checked; changed() }} />
                While the keyboard is open, hold a finger on message text to pick it for a comment
              </label>}
            </div>
            <div className="settings-group">
              <h3 className="cost-h">New sessions</h3>
              <label className="settings-check" data-tip="New sessions get only Codinger's tools, also when a server is on for every new session in the MCP dialog. The MCP chip or Claude turns servers on. When this is off, new sessions start with the servers on for every new session. Current sessions do not change.">
                <input type="checkbox" checked={st.settings.mcpStartOff !== false} onChange={(e) => void api('/api/settings', 'PUT', { mcpStartOff: e.target.checked })} />
                Start new sessions with my MCP servers off
              </label>
              <label className="settings-check" data-tip="When off, Claude asks you first. Applies to new sessions only.">
                <input type="checkbox" checked={st.settings.mcpClaude !== false} onChange={(e) => void api('/api/settings', 'PUT', { mcpClaude: e.target.checked })} />
                Let Claude turn on an MCP server when the task needs it
              </label>
              <label className="settings-check" data-tip="Claude may estimate work in agent time and dollars, and saves each estimate with what the work took. Applies when a session starts again.">
                <input type="checkbox" checked={st.settings.estimates !== false} onChange={(e) => void api('/api/settings', 'PUT', { estimates: e.target.checked })} />
                Estimates in agent time and cost, measured against the work
              </label>
            </div>
            <div className="settings-group">
              <h3 className="cost-h">Prompt cache and notes</h3>
              <label className="settings-check" title="When the prompt cache expires, the next message re-caches the whole context at full price">
                Ask before re-caching more than
                <select value={guard} onChange={(e) => void api('/api/settings', 'PUT', { cacheGuard: Number(e.target.value) })}>
                  {[...new Set([...GUARDS, guard])].sort((x, y) => x - y).map((g) => <option key={g} value={g}>{g ? `${g / 1000}k tokens` : 'never ask'}</option>)}
                </select>
              </label>
              <label className="settings-check" title="A short call keeps the 1-hour cache warm at the cache-read price. A later message then does not re-cache it all">
                Keep the cache warm for
                <select value={st.settings.keepWarmHours ?? KEEP_WARM.hours} onChange={(e) => void api('/api/settings', 'PUT', { keepWarmHours: Number(e.target.value) })}>
                  {[...new Set([...WARM_HOURS, st.settings.keepWarmHours ?? KEEP_WARM.hours])].sort((x, y) => x - y).map((h) => <option key={h} value={h}>{h ? `${h} ${h === 1 ? 'hour' : 'hours'}` : 'no time (off)'}</option>)}
                </select>
                after the last activity
              </label>
              <label className="settings-check" title="After 20 idle minutes, a call writes notes to the folder's .codinger/notes/, to start a new session from">
                <input type="checkbox" checked={st.settings.notes !== false} onChange={(e) => void api('/api/settings', 'PUT', { notes: e.target.checked })} />
                Write notes on quiet sessions
              </label>
              <label className="settings-check" title="No notes or keep-warm calls that would take your 5-hour usage past this">
                Stop notes and keep-warm calls at
                <select value={st.settings.keepWarmUsage ?? KEEP_WARM.usage} onChange={(e) => void api('/api/settings', 'PUT', { keepWarmUsage: Number(e.target.value) })}>
                  {[...new Set([...WARM_USAGE, st.settings.keepWarmUsage ?? KEEP_WARM.usage])].sort((x, y) => x - y).map((u) => <option key={u} value={u}>{u === 100 ? 'never' : `${u}%`}</option>)}
                </select>
                of the 5-hour limit
              </label>
              <label className="settings-check" title="A large context is slow and costly even with a warm cache. The Notes chip turns amber past this size">
                Suggest a new session from the notes past
                <select value={st.settings.keepWarmMax ?? KEEP_WARM.max} onChange={(e) => void api('/api/settings', 'PUT', { keepWarmMax: Number(e.target.value) })}>
                  {[...new Set([...WARM_MAX, st.settings.keepWarmMax ?? KEEP_WARM.max])].sort((x, y) => x - y).map((t) => <option key={t} value={t}>{t / 1000}k tokens</option>)}
                </select>
              </label>
            </div>
            <div className="settings-group">
              <h3 className="cost-h">Updates and restarts</h3>
              <label className="settings-check">
                Updates from GitHub
                <select value={st.settings.autoUpdate ?? 'ask'} onChange={(e) => void api('/api/settings', 'PUT', { autoUpdate: e.target.value })}>
                  <option value="ask">Ask first</option>
                  <option value="always">Install automatically</option>
                  <option value="never">Never</option>
                </select>
              </label>
              <label className="settings-check" title="For work on Codinger itself: a banner offers a server restart">
                <input type="checkbox" checked={!!st.settings.selfRestart} onChange={(e) => void api('/api/settings', 'PUT', { selfRestart: e.target.checked })} />
                Offer to restart when Codinger's code changes
              </label>
              <label className="settings-check" title="After a crash or a forced stop of the server. A restart from Codinger keeps a working session working anyway.">
                <input type="checkbox" checked={!!st.settings.resumeCut} onChange={(e) => void api('/api/settings', 'PUT', { resumeCut: e.target.checked })} />
                Go on with turns that a server stop cut short
              </label>
            </div>
          </section>}
          {page === 'cost' && <section className="settings-page"><CostPanel /></section>}
          {page === 'estimates' && <section className="settings-page"><EstimatesPanel onClose={onClose} /></section>}
          {page === 'appearance' && <section className="settings-page"><AppearancePanel /></section>}
          {page === 'context' && <section className="settings-page"><StartContext /></section>}
          {page === 'remote' && <section className="settings-page"><RemotePanel /></section>}
          {page === 'files' && <div className="files-body">
            <nav className="files-list">
              {files.map((f) => (
                <div key={f.path} className={`file-row${f.path === sel ? ' on' : ''}`} onClick={() => pick(f.path)} title={f.path}>
                  <span className="file-name">{f.path.split(/[\\/]/).pop()}</span>
                  <span className="file-dir muted">{shortPath(f.path.replace(/[\\/][^\\/]*$/, ''))}</span>
                  <span className="file-meta muted">{!f.exists ? 'no file yet' : f.last ? `changed ${timeAgo(f.last)}` : ''}</span>
                  {!f.builtIn && <button className="icon-btn file-x" title="Stop tracking" onClick={(e) => { e.stopPropagation(); void untrack(f.path) }}><XIcon size={11} /></button>}
                </div>
              ))}
              <div className="file-add">
                <input placeholder="Track another file…" value={adding} onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add() }} />
              </div>
            </nav>
            <section className="file-pane">
              {stale && <div className="empty">Codinger's server is older than this page, so it has no file history yet. Restart Codinger, then open Settings again.</div>}
              {blame && <>
                <div className="file-tabs">
                  {(['read', 'edit', 'history'] as const).map((t) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}
                  <span className="muted mono file-path">{shortPath(blame.path)}</span>
                </div>
                {tab === 'read' && (blame.exists ? <BlameView b={blame} open={open} /> : <div className="empty">This file does not exist yet. Write it in Edit.</div>)}
                {tab === 'edit' && <>
                  <textarea className="agents-md mono" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
                  <div className="modal-actions">
                    <button disabled={!dirty} onClick={() => setText(blame.text)}>Discard</button>
                    <button className="primary" disabled={!dirty || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
                  </div>
                </>}
                {tab === 'history' && <History b={blame} open={open} />}
              </>}
            </section>
          </div>}
        </div>
      </div>
    </div>
  )
}

// Push notifications, for this browser only: the hub sends them, so a machine's own page
// needs the machine connected to web.codinger.app.
function PushSetting() {
  const st = useStore()
  const [on, setOn] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { void pushSubscribed().then(setOn) }, [])
  if (!pushSupported()) return null
  const reachable = st.web || !!st.self
  const toggle = async (want: boolean) => {
    setBusy(true); setErr(null)
    try { if (want) await enablePush(); else await disablePush(); setOn(want) } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  return <>
    <label className="settings-check">
      <input type="checkbox" checked={!!on} disabled={busy || on === null || (!on && !reachable)} onChange={(e) => void toggle(e.target.checked)} />
      Notify me in this browser when a session finishes, asks something, or needs a permission
    </label>
    {!reachable && !on && <div className="muted">Connect this machine to web.codinger.app in Remote access first: it sends the notifications.</div>}
    {err && <div className="notice error">{err}</div>}
  </>
}

function Who({ by, open }: { by: By; open(by: By): void }) {
  const link = by.kind === 'session' || by.kind === 'claude'
  return link ? <button className="link who-link" onClick={() => open(by)}>{who(by)}</button> : <span>{who(by)}</span>
}

function History({ b, open }: { b: Blame; open(by: By): void }) {
  return (
    <div className="file-history">
      {[...b.versions].reverse().map((v, i) => (
        <div key={i} className="hist-row">
          <span className="hist-when muted" title={new Date(v.ts).toLocaleString()}>{timeAgo(v.ts)}</span>
          <Who by={v.by} open={open} />
          {v.by.kind !== 'initial' && <span className="hist-size"><span className="add">+{v.added}</span> <span className="del">−{v.removed}</span></span>}
        </div>
      ))}
    </div>
  )
}

// The file rendered block by block (list items one by one), each with a bar
// at its left: brighter for a newer change, tinted if it came with the latest
// one. Hover says who and when; a click lists every change to it.
function BlameView({ b, open }: { b: Blame; open(by: By): void }) {
  const [picked, setPicked] = useState<number[] | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const newest = b.versions.length - 1
  const blocks = useMemo(() => {
    const tokens = marked.lexer(b.text)
    if (marked.defaults.walkTokens) void marked.walkTokens(tokens, marked.defaults.walkTokens)
    // Tokens' raw text, joined, is the file: a block's lines follow from its offset.
    const nl: number[] = []
    for (let i = 0; i < b.text.length; i++) if (b.text[i] === '\n') nl.push(i)
    const lineAt = (c: number) => { let lo = 0, hi = nl.length; while (lo < hi) { const m = (lo + hi) >> 1; if (nl[m] < c) lo = m + 1; else hi = m } return lo }
    const range = (c: number, raw: string) => { const a = lineAt(c); const n = raw.replace(/\n+$/, '').split('\n').length; return [...new Set(b.lines.slice(a, a + n))].sort((x, y) => x - y) }
    let off = 0
    return tokens.flatMap((t: Token) => {
      const at = off
      off += t.raw.length
      if (t.type === 'space') return []
      // List items get their own marks (set on the rendered <li>s after mount).
      let items: number[][] | undefined
      if (t.type === 'list') { let c = at; items = (t as Tokens.List).items.map((it) => { const vs = range(c, it.raw); c += it.raw.length; return vs }) }
      const html = DOMPurify.sanitize(marked.parser(Object.assign([t], { links: tokens.links })) as string)
      return [{ html, vs: range(at, t.raw), items }]
    })
  }, [b])

  const mark = (vs: number[]) => {
    const top = vs.length ? Math.max(...vs) : 0
    const v = b.versions[top]
    return {
      cls: `blame${top === newest && newest > 0 ? ' latest' : ''}`,
      style: { '--age': String(newest ? 0.2 + 0.8 * (top / newest) : 0.2) } as React.CSSProperties,
      title: v ? `${who(v.by)} · ${timeAgo(v.ts)}${vs.length > 1 ? ` (and ${vs.length - 1} earlier)` : ''}` : '',
    }
  }
  useLayoutEffect(() => {
    root.current?.querySelectorAll<HTMLElement>('[data-items]').forEach((el) => {
      const items: number[][] = JSON.parse(el.dataset.items!)
      el.querySelectorAll<HTMLElement>(':scope > ul > li, :scope > ol > li').forEach((li, i) => {
        const m = mark(items[i] ?? [])
        li.className = m.cls
        li.style.setProperty('--age', String(m.style['--age' as keyof React.CSSProperties]))
        li.title = m.title
        li.dataset.vs = JSON.stringify(items[i] ?? [])
      })
    })
  })

  return (
    <div className="blame-view" ref={root} onClick={(e) => {
      const el = (e.target as Element).closest<HTMLElement>('[data-vs]')
      if (el && !(e.target as Element).closest('a, button')) setPicked(JSON.parse(el.dataset.vs!))
    }}>
      {picked && (
        <div className="blame-picked">
          {picked.slice().reverse().map((k) => { const v = b.versions[k]; return (
            <div key={k} className="hist-row"><span className="hist-when muted">{timeAgo(v.ts)}</span><Who by={v.by} open={open} /></div>
          ) })}
          <button className="icon-btn" title="Close" onClick={() => setPicked(null)}><XIcon size={11} /></button>
        </div>
      )}
      <div className="md">
        {blocks.map((bl, i) => {
          if (bl.items) return <div key={i} className="blame-list" data-items={JSON.stringify(bl.items)} dangerouslySetInnerHTML={{ __html: bl.html }} />
          const m = mark(bl.vs)
          return <div key={i} className={m.cls} style={m.style} title={m.title} data-vs={JSON.stringify(bl.vs)} dangerouslySetInnerHTML={{ __html: bl.html }} />
        })}
      </div>
    </div>
  )
}
