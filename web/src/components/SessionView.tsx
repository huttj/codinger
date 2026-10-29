import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Mail, PermissionMode, SessionMeta, SlashCommand } from '../../../shared/types.ts'
import { MAX_RUN } from '../../../shared/mail.ts'
import { api, changed, closeSession, composerOf, draftsOf, hasContent, loadEvents, queuedParts, select, sendQueued, setComposer, state, undismissItem, useStore, deselect, globalId, machineOf, localId, quietly, panelOf, setPanel, type PanelTab } from '../store.ts'
import { fatigue, kTokens } from '../util.ts'
import { Mascot, STATUS_LABEL } from './Mascot.tsx'
import { dragToGroup } from './Sidebar.tsx'
import { RichInput } from './Inputs.tsx'
import { Transcript } from './Transcript.tsx'
import { ItemCount } from './AttentionPanel.tsx'
import { hasPreview } from './Artifacts.tsx'
import { SidePanel } from './SidePanel.tsx'
import { revealItem, useItems } from '../items.ts'
import { CheckIcon, ChevronIcon, ChildrenIcon, ClipIcon, FolderIcon, MailIcon, MoreIcon, PanelIcon, SendIcon, StarIcon, StopIcon, UndoIcon, XIcon } from './Icons.tsx'
import { inboxLabel } from '../../../shared/inbox.ts'
import { renderInline } from '../util.ts'
import { isReaction } from '../emoji.ts'
import { Splitter, useWidth } from './Splitter.tsx'
import { cacheOf, limitLeft, minutes, money, moneyLong, ofFresh, pct, shareOf, spendOf, toggleMoney, useNow, usd } from '../cache.ts'
import { ttlLabel } from '../../../shared/cache.ts'
import { NotesPill } from './NotesDialog.tsx'
import { StateMark, TasksDialog } from './TasksDialog.tsx'
import { McpPill } from './McpDialog.tsx'
import { shortPath } from './DirPicker.tsx'
import { AutopilotPanel, autopilotOn, budgetLabel } from './Autopilot.tsx'
import { PublishDialog } from './PublishDialog.tsx'

export function ContextGauge({ m, onCompact }: { m: SessionMeta; onCompact?: () => void }) {
  const used = m.context.used
  const window = Math.max(m.context.window, used)
  const pct = Math.min(100, (used / (window || 1)) * 100)
  const f = fatigue(used, window)
  const color = f < 0.35 ? 'var(--ok)' : f < 0.6 ? 'var(--warn)' : f < 0.85 ? 'var(--hot)' : 'var(--bad)'
  return (
    <div className="gauge" title={`${used.toLocaleString()} of ${window.toLocaleString()} tokens in context`}>
      <div className="gauge-bar"><div style={{ width: `${Math.max(pct, used ? 1 : 0)}%`, background: color }} /></div>
      <span className="gauge-label">{kTokens(used)} / {kTokens(window)}</span>
      {onCompact && <button className="link" disabled={m.status === 'working' || !m.started} onClick={onCompact} title="Summarise the conversation to free context (/compact)">Compact</button>}
    </div>
  )
}

// How long the prompt cache keeps this conversation; past that, the next send pays to write it again.
// The tooltip answers "chat on here, or start a new session from the notes?" with the numbers.
export function CachePill({ m }: { m: SessionMeta }) {
  const now = useNow()
  useStore()   // the dollars-or-percent choice
  const c = cacheOf(m, now)
  if (c.left == null) return null
  const busy = m.status === 'working' || m.status === 'permission'
  const soon = !c.cold && c.left < (c.ttl >= 3_600_000 ? 10 : 2) * 60_000
  const { cold: costCold, warm: costWarm } = c.limit
  const cost = (d: number, share: number | null) => `${usd(d)} (${ofFresh(d, c.dollars.fresh)} of those tokens${share != null ? `, about ${pct(share)} of your 5-hour limit` : ''})`
  const tokens = kTokens(m.context.used)
  const here = c.cold
    ? `The prompt cache expired ${minutes(-c.left)} ago. A message here re-caches all ${tokens} tokens: ${cost(c.dollars.cold, costCold)}. With a warm cache, a message cost ${usd(c.dollars.warm)}.`
    : `The prompt cache stays warm ${minutes(c.left)} more (${ttlLabel(c.ttl)} after each call). A message here reads ${tokens} cached tokens: ${cost(c.dollars.warm, costWarm)}.`
  const f = c.fresh
  const fresh = `A new session from the notes: about ${usd(f.first)} for the first message, then about ${usd(f.next)} a message (it starts at about ${kTokens(f.tokens)} tokens).`
    + (f.after == null ? ' It does not cost less.' : f.after <= 1 ? ' It costs less from the first message.' : ` It costs less after about ${f.after} messages.`)
  const title = `${here}\n\n${fresh} Neither counts what each reply adds.${costWarm == null ? '\n\nCodinger does not know the 5-hour limit in dollars yet.' : ''}`
  return (
    <button className={`cache-pill${c.cold ? ' cold' : soon ? ' soon' : ' warm'}${c.blocked ? ' blocked' : ''}`} data-tip={title} onClick={toggleMoney}>
      {busy ? 'Cache warm' : c.cold ? `Cache expired · ${money(c.dollars.cold)}` : `Cache warm · ${minutes(c.left)} · ${money(c.dollars.warm)}`}
    </button>
  )
}

// What this conversation has cost so far, each call priced when it was made (shared/prices.ts).
export function SpendPill({ m }: { m: SessionMeta }) {
  useStore()
  useNow(60_000)
  const s = spendOf(m)
  if (!s) return null
  return <button className="cache-pill spend-pill" data-tip={s.tip} onClick={toggleMoney}>{s.label}</button>
}

const MODES: { v: PermissionMode; label: string }[] = [
  { v: 'auto', label: 'Auto mode' },
  { v: 'default', label: 'Ask before tools' },
  { v: 'acceptEdits', label: 'Auto-accept edits' },
  { v: 'plan', label: 'Plan only' },
  { v: 'bypassPermissions', label: 'Bypass permissions' },
]

// The session's names: in Claude Code it is "codinger-<id>". A click copies that name.
function IdChip({ m }: { m: SessionMeta }) {
  const [copied, setCopied] = useState(false)
  const name = `codinger-${localId(m.id)}`
  const copy = () => { void navigator.clipboard.writeText(name); setCopied(true); setTimeout(() => setCopied(false), 1200) }
  return <button className="link mono head-id" title={`Codinger session ${localId(m.id)}\nClaude Code: name ${name}, session ${m.claudeSessionId}\nClick to copy the name`} onClick={copy}>{copied ? 'copied' : name}</button>
}

export function SessionHeader({ m, extra }: { m: SessionMeta; extra?: React.ReactNode }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(m.title)
  useEffect(() => setTitle(m.title), [m.title])
  const save = () => { setEditing(false); if (title.trim() && title !== m.title) void api(`/api/sessions/${m.id}`, 'PATCH', { title }) }
  // An alias or the default shows what it ran last time until Claude Code reports.
  const model = m.model?.includes('-') ? m.model : m.expectedModel ?? m.model
  const parent = useStore().sessions.find((x) => x.id === m.parentId)
  // In a narrow head the head is one line; this button shows the gauges and the mode (styles.css).
  const [more, setMore] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [menu, setMenu] = useState<Menu>(null)
  const ap = m.autopilot
  // Under 680px (and always on a phone) the head takes the phone's one-line layout.
  const head = useRef<HTMLElement>(null)
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const el = head.current, phone = matchMedia('(max-width: 720px)')
    if (!el) return
    const check = () => setNarrow(phone.matches || el.clientWidth < 680)
    const ro = new ResizeObserver(check)
    ro.observe(el)
    phone.addEventListener('change', check)
    return () => { ro.disconnect(); phone.removeEventListener('change', check) }
  }, [])
  return (
    <header ref={head} className={`session-head${narrow ? ' narrow' : ''}${more ? ' head-open' : ''}`}>
      {/* Drag it onto a group in the sidebar to move the session there. */}
      <span className="head-critter" onPointerDown={(e) => dragToGroup(e, m)}>
        <Mascot status={m.status} look={m.look} fatigue={fatigue(m.context.used, m.context.window)} size={44} title={STATUS_LABEL[m.status]} child={!!m.parentId} review={!!m.pendingReviews} starred={m.starred} />
      </span>
      <div className="head-main">
        {editing
          ? <input className="title-edit" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setTitle(m.title); setEditing(false) } }} />
          : <h1 className="rename" onClick={() => setEditing(true)} title="Click to rename">{m.title}</h1>}
        {/* Claude renamed a session you had named: your name stays one click away. */}
        {!editing && m.titleBefore != null && (
          <span className="title-before muted">was “{m.titleBefore}” <button className="link" onClick={() => void api(`/api/sessions/${m.id}`, 'PATCH', { title: m.titleBefore, undo: true })}>Undo</button></span>
        )}
        <div className="head-sub">
          {/* The critter shows the status; only compacting, which it does not show, has a tag. */}
          {m.compacting && <span className={`status-pill st-${m.status}`}>compacting</span>}
          <span className="muted mono path" title={m.cwd}>{'\u200E' + shortPath(m.cwd) + '\u200E'}</span>
          {model && <span className="muted head-model" title={m.model?.includes('-') ? undefined : 'Model used for this choice last time'}>{model}</span>}
          <IdChip m={m} />
          {parent && <button className="link head-parent" title="Show the session that started this one" onClick={() => select(parent.id)}>from {parent.title}</button>}
          {/* Its transcript is public: say so, one click from its link. */}
          {m.share && <button className="link head-published" onClick={() => setPublishing(true)}>published</button>}
        </div>
      </div>
      <div className="head-side">
        <div className="head-gauges">
          <CachePill m={m} />
          <SpendPill m={m} />
          <NotesPill m={m} />
          <McpPill m={m} />
          <ContextGauge m={m} onCompact={() => {
            if (cacheOf(m, Date.now()).blocked && !confirm(`The prompt cache has expired. Compacting reads all ${kTokens(m.context.used)} tokens at full price. Compact anyway?`)) return
            void api(`/api/sessions/${m.id}/command`, 'POST', { cmd: '/compact' })
          }} />
        </div>
        <div className="head-actions">
          <span className="head-mode">
            {/* While autopilot runs, the head says so; a click opens it in the menu. */}
            {m.kind === 'worker' && autopilotOn(m) && <button className="autopilot-on" onClick={() => setMenu('autopilot')}>Autopilot · {budgetLabel(ap!.unit, Math.max(0, ap!.budget - ap!.used))} left</button>}
            <ChildrenButton m={m} />
          </span>
          {extra}
          <button className="icon-tall head-more" aria-label={more ? 'Fewer details' : 'More details'} onClick={() => setMore(!more)}><ChevronIcon size={15} /></button>
          <SessionMenu m={m} open={menu} setOpen={setMenu} onPublish={() => setPublishing(true)} />
        </div>
      </div>
      {publishing && <PublishDialog m={m} onClose={() => setPublishing(false)} />}
    </header>
  )
}

// The sessions this one started, archived ones last. Hover shows them, a click keeps them open,
// and a click on one shows it.
function ChildrenButton({ m }: { m: SessionMeta }) {
  const kids = useStore().sessions.filter((x) => x.parentId === m.id)
    .sort((a, b) => Number(a.archived) - Number(b.archived) || a.createdAt - b.createdAt)
  const [hover, setHover] = useState(false)
  const [pinned, setPinned] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!pinned) return
    const down = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setPinned(false) }
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [pinned])
  if (!kids.length) return null
  const open = hover || pinned
  const go = (id: string) => { setPinned(false); setHover(false); select(id) }
  return (
    <div className="menu-wrap" ref={box} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button className={`icon-tall${pinned ? ' pinned' : ''}`} aria-label={`Children: ${kids.length}`} aria-expanded={open} onClick={() => setPinned(!pinned)}>
        <ChildrenIcon size={15} />{kids.length}
      </button>
      {open && (
        <div className="menu children-pop">
          {kids.map((k) => (
            <button key={k.id} className={k.archived ? 'archived' : ''} onClick={() => go(k.id)}>
              <Mascot status={k.status} look={k.look} fatigue={fatigue(k.context.used, k.context.window)} size={18} child />
              <span className="child-title">{k.title}</span>
              <span className="muted">{k.archived ? 'archived' : STATUS_LABEL[k.status]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// The menu, or its autopilot panel, or closed.
type Menu = null | 'list' | 'autopilot'

// Stop, the permission mode, autopilot, Close and the rest, out of the way behind one button.
function SessionMenu({ m, open, setOpen, onPublish }: { m: SessionMeta; open: Menu; setOpen(v: Menu): void; onPublish(): void }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(null) }
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [open])
  const busy = m.status === 'working' || m.status === 'permission'
  const act = (f: () => unknown) => () => { setOpen(null); void f() }
  const worker = m.kind === 'worker'
  const ap = m.autopilot
  const items = [
    busy && <button key="stop" className="danger" onClick={act(() => api(`/api/sessions/${m.id}/interrupt`))}>Stop</button>,
    worker && <div key="modes" className="menu-label">Permission mode</div>,
    ...(worker ? MODES.map((x) => (
      <button key={x.v} className="menu-check" onClick={act(() => api(`/api/sessions/${m.id}`, 'PATCH', { permissionMode: x.v }))}>
        <span>{m.permissionMode === x.v && <CheckIcon size={13} />}</span>{x.label}
      </button>
    )) : []),
    worker && <hr key="sep" />,
    worker && <button key="autopilot" className={autopilotOn(m) ? 'autopilot-on' : ''} onClick={() => setOpen('autopilot')}>
      {autopilotOn(m) ? `Autopilot · ${budgetLabel(ap!.unit, Math.max(0, ap!.budget - ap!.used))} left` : 'Autopilot'}
    </button>,
    worker && <button key="star" onClick={act(() => api(`/api/sessions/${m.id}`, 'PATCH', { starred: !m.starred }))}>{m.starred ? 'Remove star' : 'Star'}</button>,
    worker && <button key="publish" onClick={act(onPublish)}>{m.share ? 'Published transcript' : 'Publish transcript'}</button>,
    worker && !m.archived && <button key="close" title="Archive session" onClick={act(() => closeSession(m.id))}>Close</button>,
    worker && m.archived && <button key="reopen" onClick={act(() => api(`/api/sessions/${m.id}`, 'PATCH', { archived: false }))}>Reopen</button>,
    worker && m.archived && <button key="delete" className="danger" title="Remove from Codinger (it stays in Resume)" onClick={act(() => { if (confirm(`Delete "${m.title}" from Codinger? Claude Code's own transcript is kept, so you can still find it under Resume.`)) return api(`/api/sessions/${m.id}`, 'DELETE').then(deselect) })}>Delete</button>,
  ].filter(Boolean)
  // Press, drag to an item and release to choose it, as in a native menu. A press opens the
  // menu; a release over an item clicks it, a release away from the menu closes it, and a
  // release on the button keeps it open, so a plain click works as before. A finger works the
  // same way: the browser keeps a touch's events on the button it started on, so the item is
  // the element under the point, and it takes the hover colour (.hot) while the finger is on it.
  const pressed = useRef(false)
  const press = (e: React.PointerEvent) => {
    if (e.button !== 0 || open) return
    pressed.current = true
    setOpen('list')
    let hot: Element | null = null
    const under = (p: PointerEvent) => document.elementFromPoint(p.clientX, p.clientY)
    const move = (p: PointerEvent) => {
      if (p.pointerId !== e.pointerId) return
      const item = under(p)?.closest('.menu button') ?? null
      if (item === hot) return
      hot?.classList.remove('hot')
      item?.classList.add('hot')
      hot = item
    }
    const end = (u: PointerEvent) => {
      if (u.pointerId !== e.pointerId) return
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      hot?.classList.remove('hot')
      // A scroll took the touch: leave the menu open, as after a tap.
      if (u.type === 'pointercancel') { pressed.current = false; return }
      const t = under(u)
      if (t && box.current?.contains(t)) {
        // On the button, its own click follows and clears pressed.
        if (t.closest('.icon-tall')) return
        pressed.current = false
        const item = t.closest('.menu button')
        if (item instanceof HTMLButtonElement) {
          item.click()
          // The browser can send a click of its own after the release: drop it.
          const eat = (c: MouseEvent) => { c.stopPropagation(); c.preventDefault() }
          window.addEventListener('click', eat, { capture: true, once: true })
          setTimeout(() => window.removeEventListener('click', eat, true), 300)
        }
        return
      }
      pressed.current = false
      setOpen(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }
  const toggle = () => {
    if (pressed.current) { pressed.current = false; return }
    setOpen(open ? null : 'list')
  }
  if (!items.length) return null
  return (
    <div className="menu-wrap" ref={box}>
      <button className={`icon-tall${busy ? ' busy' : ''}`} title="More" onPointerDown={press} onClick={toggle}><MoreIcon size={15} /></button>
      {open === 'list' && <div className="menu">{items}</div>}
      {open === 'autopilot' && <AutopilotPanel m={m} onClose={() => setOpen(null)} />}
    </div>
  )
}

// The lead's drafts, in the reply tray: edit or remove each; they go with your next message.
// This session's tasks that still run (server/tasks.ts), at the bottom of the
// chat whatever is in view; a click shows a task's log. An ended one moves into
// the transcript (Transcript.tsx, TaskEnd).
function RunningTasks({ sid }: { sid: string }) {
  const { tasks } = useStore()
  useNow(10_000)
  const [open, setOpen] = useState<string | null>(null)
  const running = tasks.filter((t) => t.sid === sid && !t.ended)
  // Ended, and the agent has not heard yet: the result goes with your next message.
  const waiting = tasks.filter((t) => t.sid === sid && t.ended && !t.told)
  if (!running.length && !waiting.length && !open) return null
  return (
    <div className="running-tasks">
      {running.map((t) => (
        <button key={t.id} className="running-task" title={`${t.command}${t.progress?.label ? `\n${t.progress.label}: ${t.progress.pct}%` : ''}\nShow its log`} onClick={() => setOpen(t.id)}
          style={t.progress ? { '--pct': `${t.progress.pct}%` } as React.CSSProperties : undefined}>
          <span className="task-dot running" /><span className="rt-title">{t.title}</span>
          {t.progress && <span className="task-pct">{t.progress.pct}%</span>}
          <span className="muted">{minutes(Date.now() - t.started)}</span>
        </button>
      ))}
      {waiting.map((t) => (
        <button key={t.id} className="running-task waiting" title={`${t.notify === 'next' ? 'This result goes to the agent with your next message.' : 'This result goes to the agent when its turn ends, or with your next message.'}\nShow its log`} onClick={() => setOpen(t.id)}>
          <StateMark t={t} /><span className="rt-title">Task result: {t.title}</span>
        </button>
      ))}
      {open && <TasksDialog first={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

function Inbox({ m }: { m: SessionMeta }) {
  if (!m.inbox.length) return null
  const remove = (id: string) => api(`/api/sessions/${m.id}/inbox/${id}/dismiss`)
  const edit = (id: string, text: string) => api(`/api/sessions/${m.id}/inbox/${id}/edit`, 'POST', { text })
  return (
    <div className="inbox">
      {m.inbox.map((i) => (
        <div key={i.id} className="inbox-item">
          <div className="inbox-head">
            <span className="inbox-from">From the {i.from === 'master' ? 'lead' : i.from}</span>
            {i.key
              ? <button className="link inbox-on" title="Show in conversation" onClick={() => revealItem(i.key!)}>{inboxLabel(i)}</button>
              : <span className="inbox-on">{inboxLabel(i)}</span>}
            <button className="icon-btn" title="Remove draft" onClick={() => void remove(i.id)}><XIcon size={13} /></button>
          </div>
          {!!i.choices?.length && <div className="inbox-choices">{i.choices.map((c) => <span key={c} className="chip static">{c}</span>)}</div>}
          {i.kind !== 'dismiss' && (
            <textarea className="inbox-text" defaultValue={i.text} rows={Math.min(8, Math.max(1, i.text.split('\n').length))}
              placeholder={i.kind === 'done' ? 'Any problem?' : ''}
              onBlur={(e) => { if (e.target.value !== i.text) void edit(i.id, e.target.value) }} />
          )}
        </div>
      ))}
    </div>
  )
}

// Messages from other sessions that wait: for the end of this turn, or, past the limit, for your OK.
// Each is a pill in the queue row; a click opens the message above it.
function Mailbox({ m }: { m: SessionMeta }) {
  const { sessions } = useStore()
  const [open, setOpen] = useState<string | null>(null)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const out = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(null) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null) }
    document.addEventListener('mousedown', out)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', out); document.removeEventListener('keydown', esc) }
  }, [open])
  if (!m.mail?.length) return null
  const name = (x: Mail) => sessions.find((s) => s.id === globalId(machineOf(m.id), x.from))?.title ?? x.title
  const act = (id: string, send: boolean) => { setOpen(null); void api(`/api/sessions/${m.id}/mail/${id}`, 'POST', { send }) }
  const x = m.mail.find((y) => y.id === open)
  return (
    <span className="mail-pills" ref={ref}>
      {m.mail.map((y) => (
        <button key={y.id} className={`chip mail-pill${y.held ? ' held' : ''}${y.id === open ? ' on' : ''}`} onClick={() => setOpen(y.id === open ? null : y.id)}>
          <MailIcon size={12} /><span className="mail-pill-name">{y.idle ? `${name(y)} is idle` : name(y)}</span>
        </button>
      ))}
      {x && (
        <div className={`mail-pop${x.held ? ' held' : ''}`}>
          <div className="inbox-head">
            <span className="inbox-from"><MailIcon size={12} /> {x.idle ? `${name(x)} is idle` : x.replyTo ? `Reply from ${name(x)}` : `From ${name(x)}`}</span>
            <span className="inbox-on">
              {x.held ? `Waits for your OK: ${name(x)} sent ${MAX_RUN} messages in a row here, and you wrote in neither session since.` : x.step ? `Goes in when ${name(x)} goes on or ends its turn` : 'Goes in when this turn ends'}
            </span>
            {x.held && <button className="link" onClick={() => act(x.id, true)}>Send</button>}
            <button className="icon-btn" title="Discard the message" onClick={() => act(x.id, false)}><XIcon size={13} /></button>
          </div>
          {x.text && <div className="mail-text">{x.text}</div>}
        </div>
      )}
    </span>
  )
}

// Typing "/" at the start of the composer lists the session's slash commands:
// Claude Code's built-ins, your skills and the project's own.
function useSlashMenu(sid: string, text: string, setText: (t: string) => void) {
  const [cmds, setCmds] = useState<SlashCommand[] | null>(null)
  const [index, setIndex] = useState(0)
  const [closedFor, setClosedFor] = useState<string | null>(null)
  const m = /^\/([\w:.-]*)$/.exec(text)
  const typing = !!m && closedFor !== text
  useEffect(() => { setCmds(null) }, [sid])
  useEffect(() => { if (typing && !cmds) void api<SlashCommand[]>(`/api/sessions/${sid}/commands`, 'GET').then(setCmds).catch(() => {}) }, [typing, cmds, sid])
  const q = (m?.[1] ?? '').toLowerCase()
  const matches = !typing || !cmds ? [] : cmds
    .filter((c) => c.name.toLowerCase().includes(q))
    .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
    .slice(0, 50)
  useEffect(() => setIndex(0), [q])
  const pick = (c: SlashCommand) => setText(`/${c.name} `)
  const onKey = (e: React.KeyboardEvent) => {
    if (!matches.length) return false
    if (e.key === 'ArrowDown') { setIndex((i) => (i + 1) % matches.length); return true }
    if (e.key === 'ArrowUp') { setIndex((i) => (i - 1 + matches.length) % matches.length); return true }
    if ((e.key === 'Tab' || (e.key === 'Enter' && !e.metaKey && !e.ctrlKey)) && matches[index]) { pick(matches[index]); return true }
    if (e.key === 'Escape') { setClosedFor(text); return true }
    return false
  }
  const menu = matches.length > 0 && (
    <div className="slash-menu" onMouseDown={(e) => e.preventDefault()}>
      {matches.map((c, i) => (
        <button key={c.name} className={i === index ? 'on' : ''} onMouseEnter={() => setIndex(i)} onClick={() => pick(c)} ref={i === index ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}>
          <span className="slash-name">/{c.name}{c.argumentHint && <span className="muted"> {c.argumentHint}</span>}</span>
          <span className="slash-desc">{c.description}</span>
        </button>
      ))}
    </div>
  )
  return { onKey, menu }
}

// What you set aside for this message: each one to look at again or take back.
function DismissedChip({ sid }: { sid: string }) {
  const [open, setOpen] = useState(false)
  const list = draftsOf(sid).flatMap((d) => d.kind === 'dismiss' ? [d] : [])
  useEffect(() => { if (!list.length) setOpen(false) }, [list.length])
  return (
    <span className="dismissed-wrap">
      <button className="chip open-chip" onClick={() => setOpen(!open)}>{list.length} dismissed</button>
      {open && (
        <div className="dismissed-list">
          {list.map((d) => (
            <div key={d.id}>
              <button className="link" title={d.label} onClick={() => revealItem(d.key)} dangerouslySetInnerHTML={{ __html: renderInline(d.label) }} />
              <button className="icon-btn" title="Undo" onClick={() => undismissItem(sid, d.key)}><UndoIcon size={13} /></button>
            </div>
          ))}
        </div>
      )}
    </span>
  )
}

// On a phone the word goes, for room.
const resolve = (n: number) => <>Resolve {n}<span className="not-phone not-narrow"> {n === 1 ? 'issue' : 'issues'}</span> ↑</>

export function Composer({ m, attachRef }: { m: SessionMeta; attachRef?: React.RefObject<((files: File[]) => void) | null> }) {
  useStore()
  const c = composerOf(m.id)
  const drafts = draftsOf(m.id).filter(hasContent)
  const reactions = drafts.filter((d) => (d.kind === 'note' || d.kind === 'artifact') && isReaction(d.text) && !d.images.length).length
  const notes = drafts.filter((d) => d.kind === 'note' || d.kind === 'artifact' || d.kind === 'line').length - reactions
  const verdicts = drafts.filter((d) => d.kind === 'verdict').length
  const answers = drafts.filter((d) => d.kind === 'answer').length
  const dismissed = drafts.filter((d) => d.kind === 'dismiss').length
  const done = drafts.filter((d) => d.kind === 'done').length
  const [sending, setSending] = useState(false)
  const busy = m.status === 'working' || m.status === 'permission'
  // Sending while questions or items are still open warns once; sending again
  // dismisses the rest.
  const open = useItems(m.id).filter((i) => i.status === 'open')
  // An item marked critical has to get a comment with text (or Done) before anything goes, a slash command too.
  const critical = open.filter((i) => i.kind === 'consider' && i.critical)
  const [warned, setWarned] = useState(false)
  useEffect(() => { if (!open.length) setWarned(false) }, [open.length])
  useEffect(() => setWarned(false), [m.id])
  const slash = useSlashMenu(m.id, c.text, (text) => setComposer(m.id, { text }))
  const isCommand = /^\/[\w:.-]+/.test(c.text.trim()) && !c.images.length
  const n = isCommand ? 1 : queuedParts(m.id).length
  // A send that would re-cache a big, expired context waits for "Send anyway" in the bar above.
  const now = useNow()
  const cache = cacheOf(m, now)
  const costly = cache.blocked && (!isCommand || /^\/compact\b/.test(c.text.trim()))
  const [nudge, setNudge] = useState(0)
  const send = async (force = false) => {
    if (critical.length) { revealItem(critical[0].key); return }
    if (!n || sending) return
    if (costly && !force) { setNudge((x) => x + 1); return }
    if (!isCommand && open.length && !warned) { setWarned(true); revealItem(open[0].key); return }
    setSending(true)
    try {
      if (isCommand) {
        // A slash command has to be the whole message; queued replies wait for the next one.
        await api(`/api/sessions/${m.id}/send`, 'POST', { parts: [{ kind: 'text', text: c.text.trim() }] })
        setComposer(m.id, { text: '' })
      } else await sendQueued(m.id, open.map((i) => ({ key: i.key, label: i.label })))
    } finally { setSending(false) }
  }
  return (
    <div className="composer">
      <RunningTasks sid={m.id} />
      <Inbox m={m} />
      {(!!m.mail?.length || notes > 0 || verdicts > 0 || reactions > 0 || answers > 0 || dismissed > 0 || done > 0 || open.length > 0) && (
        <div className="queue">
          <Mailbox m={m} />
          {verdicts > 0 && <span className="chip static">{verdicts} {verdicts === 1 ? 'verdict' : 'verdicts'}</span>}
          {notes > 0 && <span className="chip static">{notes} {notes === 1 ? 'comment' : 'comments'}</span>}
          {reactions > 0 && <span className="chip static">{reactions} {reactions === 1 ? 'reaction' : 'reactions'}</span>}
          {answers > 0 && <span className="chip static">{answers} {answers === 1 ? 'answer' : 'answers'}</span>}
          {done > 0 && <span className="chip static">{done} done</span>}
          {dismissed > 0 && <DismissedChip sid={m.id} />}
          {open.length > 0 && <button className={`chip open-chip${warned ? ' warn' : ''}`} onClick={() => revealItem(open[0].key)}>{open.length} open</button>}
        </div>
      )}
      {costly && n > 0 && (
        <div key={nudge} className={`cache-guard${nudge ? ' nudge' : ''}`}>
          <span>
            <b>The prompt cache expired {minutes(-(cache.left ?? 0))} ago.</b> This message writes {kTokens(m.context.used)} tokens to the cache again.{' '}
            That costs about <button className="link" title="Show as dollars or % of 5-hour or weekly limit" onClick={toggleMoney}><b>{moneyLong(cache.dollars.cold)}</b></button>
            {state.money !== 'usd' && shareOf(cache.dollars.cold) != null && limitLeft() != null && <> ({pct(limitLeft()!)} left)</>}, about {cache.times}× a message sent while the cache is warm ({moneyLong(cache.dollars.warm)}).
            {state.money !== 'usd' && shareOf(cache.dollars.cold) == null && <> Codinger is still measuring how much of your usage limit that is.</>}
          </span>
          <button className="primary" disabled={sending} onClick={() => void send(true)}>Send anyway</button>
        </div>
      )}
      <div className="composer-row">
        {slash.menu}
        <RichInput
          value={c.text}
          onChange={(text) => setComposer(m.id, { text })}
          images={c.images}
          onImages={(images) => setComposer(m.id, { images })}
          placeholder={m.kind === 'lead' ? 'Message the lead' : 'Message Claude'}
          // A session you open is ready to type in; on a touch screen the keyboard would cover it.
          autoFocus={!matchMedia('(pointer: coarse)').matches}
          onSubmit={() => send()}
          onKey={slash.onKey}
          minRows={1}
          machine={machineOf(m.id)}
          uploadDir={m.cwd}
          attachRef={attachRef}
        />
        {busy && <button className="stop danger" aria-label="Stop" onClick={() => void api(`/api/sessions/${m.id}/interrupt`)}><StopIcon size={12} /><span className="not-phone not-narrow">Stop</span></button>}
        <button className={`primary send${critical.length ? ' critical' : ''}`} disabled={(!n && !critical.length) || sending} onClick={() => send()} title={costly ? 'Prompt cache expired: use Send anyway above' : undefined}>
          {/* In a narrow main area, plain Send is a paper airplane (styles.css, @container main). */}
          {sending ? 'Sending…' : critical.length ? resolve(critical.length) : isCommand ? 'Run' : open.length && n ? (warned ? 'Send anyway' : resolve(open.length)) : <><SendIcon className="send-icon" size={15} /><span className="not-narrow">Send</span>{n > 1 && <span>{n}</span>}</>}
        </button>
      </div>
    </div>
  )
}

// Files dropped anywhere in the chat go to the message box: images into the text,
// other files into the session's directory (Inputs.tsx).
function DropZone({ m, children }: { m: SessionMeta; children(attachRef: React.RefObject<((files: File[]) => void) | null>): React.ReactNode }) {
  const attachRef = useRef<((files: File[]) => void) | null>(null)
  const [over, setOver] = useState(false)
  const depth = useRef(0)   // dragenter and dragleave come for each child the pointer crosses
  const files = (e: React.DragEvent) => e.dataTransfer.types.includes('Files')
  const reset = () => { depth.current = 0; setOver(false) }
  return (
    <div
      className="session-main"
      onDragEnter={(e) => { if (files(e)) { depth.current++; setOver(true) } }}
      onDragLeave={(e) => { if (files(e) && --depth.current <= 0) reset() }}
      onDragOver={(e) => { if (files(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' } }}
      onDrop={(e) => {
        if (!files(e)) return
        reset()
        // A drop on the message box itself already went in where it fell.
        if (e.defaultPrevented) return
        e.preventDefault()
        attachRef.current?.([...e.dataTransfer.files])
      }}
    >
      {children(attachRef)}
      {over && (
        <div className="drop-zone">
          <div className="drop-card">
            <ClipIcon size={22} />
            <b>Drop to add to the chat</b>
            <span className="muted">Files go into <span className="mono">{shortPath(m.cwd, machineOf(m.id))}</span>; images go into the message.</span>
          </div>
        </div>
      )}
    </div>
  )
}

export function SessionView({ id, extra }: { id: string; extra?: React.ReactNode }) {
  const st = useStore()
  const m = st.sessions.find((s) => s.id === id)
  useEffect(() => { void loadEvents(id) }, [id])
  const items = useItems(id)
  // The panel beside the session (SidePanel.tsx): the tab you left open, Preview whenever the agent
  // shows something, and Files whenever you click a path in a reply. A tab this session has
  // nothing for does not show. Each session has its own tab, wide and width; the tab and wide of
  // the selected one are in the page's address (url.ts).
  const canPreview = hasPreview(id)
  const tabs = (['items', 'preview', 'files'] as const).filter((t) => t === 'files' || (t === 'preview' ? canPreview : items.length > 0))
  const panel = panelOf(id)
  const tab = panel.tab && tabs.includes(panel.tab) ? panel.tab : null
  const setTab = (t: PanelTab | null) => { setPanel(id, { tab: t }); changed() }
  const togglePanel = () => setTab(tab ? null : panel.last && tabs.includes(panel.last) ? panel.last : tabs[0])
  const [panelW, setPanelW] = useWidth(`panel.${id}`, 440)
  // Where the session is too narrow for the conversation beside the panel, the panel takes its place.
  const body = useRef<HTMLDivElement>(null)
  const [bodyW, setBodyW] = useState(0)
  useLayoutEffect(() => {
    const el = body.current
    if (!el) return
    const ro = new ResizeObserver(() => setBodyW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [!!m])
  // The panel gets narrower as the session does, down to PANEL_MIN; past that it takes the full width.
  const fit = bodyW > 0 ? Math.min(panelW, bodyW - CONVERSATION_MIN) : panelW
  const auto = fit < PANEL_MIN
  const wide = !!tab && (panel.wide || auto)
  // A tap on the tab that shows: in Files, closes the file on view; else hides the panel.
  const again = (t: PanelTab) => {
    if (t === 'files' && state.fileOpen[id]) {
      const { [id]: _, ...rest } = state.fileOpen
      state.fileOpen = rest
      changed()
    } else setTab(null)
  }
  const toggleWide = () => { setPanel(id, { wide: !panel.wide }); changed() }
  const shownAt = st.preview[id]?.at
  useEffect(() => { if (shownAt && Date.now() - shownAt < 5000 && panelOf(id).tab !== 'preview') quietly(() => { setPanel(id, { tab: 'preview' }); changed() }) }, [shownAt])
  if (!m) return <div className="empty">No such session.</div>
  const open = items.filter((i) => i.status === 'open')
  return (
    <div className="session">
      <SessionHeader m={m} extra={<>
        {extra}
        {m.kind === 'worker' && <button className={`star-toggle icon-tall${m.starred ? ' on' : ''}`} aria-pressed={!!m.starred} data-tip={m.starred ? 'Remove the star' : 'Star this session: it goes to the top of its group'} onClick={() => void api(`/api/sessions/${m.id}`, 'PATCH', { starred: !m.starred })}><StarIcon size={15} /></button>}
        <button className={`panel-toggle icon-tall${tab ? ' on' : ''}`} data-tip={tab ? 'Hide the panel' : 'Show the panel: issues, artifacts, files'} onClick={togglePanel}><PanelIcon size={15} />{open.length > 0 && <ItemCount items={open} />}</button>
      </>} />
      <div ref={body} className={`session-body${wide ? ' panel-wide' : ''}`}>
        <DropZone m={m}>
          {(attachRef) => <>
            <Transcript sid={id} />
            <Composer m={m} attachRef={attachRef} />
          </>}
        </DropZone>
        {tab && <>
          {!wide && <Splitter width={fit} setWidth={setPanelW} min={PANEL_MIN} max={Math.max(PANEL_MIN, bodyW - CONVERSATION_MIN)} initial={440} reverse />}
          <SidePanel m={m} tab={tab} tabs={tabs} width={fit} full={bodyW} wide={wide} auto={auto} onTab={(t) => t === tab ? again(t) : setTab(t)} onWide={toggleWide} onHide={() => setTab(null)} />
        </>}
      </div>
    </div>
  )
}

// The least widths of the conversation and of the panel beside it.
const CONVERSATION_MIN = 380
const PANEL_MIN = 260
