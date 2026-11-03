import { useEffect, useRef, useState } from 'react'
import type { SessionGroup, SessionMeta, Usage } from '../../../shared/types.ts'
import { api, archiveAsksOf, changed, closeSession, showArchive, currentMachine, LOCAL, localId, machineList, machineOf, offline, select, state, useStore, type Machine, labelOf } from '../store.ts'
import { HistoryDialog } from './HistoryDialog.tsx'
import { fatigue, timeAgo } from '../util.ts'
import { Mascot, STATUS_LABEL } from './Mascot.tsx'
import { NewSession } from './NewSession.tsx'
import { ArchiveIcon, ChevronIcon, DesktopIcon, GearIcon, GlobeIcon, LaptopIcon, SearchIcon, TerminalIcon, XIcon } from './Icons.tsx'
import { TasksDialog } from './TasksDialog.tsx'
import { ArtifactIcon } from './Artifacts.tsx'
import { SettingsDialog } from './SettingsDialog.tsx'
import { cacheOf, minutes, spendOf, useNow, usd } from '../cache.ts'
import { CostBanner } from './CostPanel.tsx'
import type { Page } from './SettingsDialog.tsx'
import { shortPath } from './DirPicker.tsx'
import { NEEDS_YOU } from '../favicon.tsx'

// A session that stopped with an error, or that left an item marked critical: shown in red.
const alertOf = (s: SessionMeta) => s.status === 'error' || !!s.pendingCritical

// Sessions in alert come first, then the others that need you, then the ones at work, then the
// finished ones. A session nested under another lifts it to its own tier.
const own = (s: SessionMeta) => alertOf(s) ? -1 : s.status === 'working' ? 1 : s.status === 'idle' || s.status === 'new' ? 2 : 0
function tiers(list: SessionMeta[], same = (a: SessionMeta, b: SessionMeta) => a.cwd === b.cwd) {
  const t = new Map(list.map((s) => [s.id, own(s)]))
  const byId = new Map(list.map((s) => [s.id, s]))
  for (const s of list) {
    const seen = new Set<string>()
    const up = (x: SessionMeta) => x.parentId ? byId.get(x.parentId) : undefined
    for (let p = up(s); p && same(p, s) && !seen.has(p.id); p = up(p)) {
      seen.add(p.id)
      t.set(p.id, Math.min(t.get(p.id)!, own(s)))
    }
  }
  return (s: SessionMeta) => t.get(s.id)!
}
// On a shut machine or group: how many sessions in it wait on you, as the tab's icon counts them.
function NeedBadge({ list }: { list: SessionMeta[] }) {
  const n = list.filter((s) => s.kind === 'worker' && !s.archived && (NEEDS_YOU.includes(s.status) || alertOf(s))).length
  return n > 0 ? <span className="need-badge">{Math.min(n, 99)}</span> : null
}

// For the lead's overview: sessions grouped by directory; sessions spawned for another one nest under it.
// Each tier keeps the order you dragged them into, then the newest on top; folders
// go by the order you dragged them into, then by their most urgent session. Neither
// goes by latest activity, so a busy session does not move the others about.
export function groupSessions(sessions: SessionMeta[], archived: boolean, groupOrder: string[] = []) {
  const workers = sessions.filter((s) => s.kind === 'worker' && s.archived === archived)
  const groups = new Map<string, SessionMeta[]>()
  const tier = tiers(workers)
  const place = (s: SessionMeta) => s.order ?? -1
  for (const s of workers.sort((a, b) => tier(a) - tier(b) || place(a) - place(b) || b.createdAt - a.createdAt)) groups.set(s.cwd, [...(groups.get(s.cwd) ?? []), s])
  const rank = (cwd: string) => { const i = groupOrder.indexOf(cwd); return i < 0 ? -1 : i }
  const top = (list: SessionMeta[]) => Math.min(...list.map(tier))
  const newest = (list: SessionMeta[]) => Math.max(...list.map((s) => s.createdAt))
  return [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || top(a[1]) - top(b[1]) || newest(b[1]) - newest(a[1]))
}

export function treeOf(list: SessionMeta[]): { s: SessionMeta; depth: number; parent: string | null }[] {
  const ids = new Set(list.map((s) => s.id))
  const out: { s: SessionMeta; depth: number; parent: string | null }[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const s of list) if ((s.parentId && ids.has(s.parentId) ? s.parentId : null) === parent) { out.push({ s, depth, parent }); walk(s.id, depth + 1) }
  }
  walk(null, 0)
  return out
}

// Press and drag a session (with any nested under it) or a group's name up or
// down among its siblings, which share a data-sort-key. The others slide aside
// to make room; letting go puts it there. A session let go over another group
// (data-group) moves there instead; a free one (a critter in a group's bottom
// line) only moves between groups. A finger holds still a moment first, so that
// a swipe scrolls the list.
type Drag = { key: string; id: string; dx: number; dy: number; shift: Record<string, number>; over: string | null }
function useDragSort(onDrop: (key: string, ids: string[]) => void, onMove?: (id: string, group: string) => void) {
  const [drag, setDrag] = useState<Drag | null>(null)
  const moved = useRef(false)
  // from: the group it is in, if it can move to another; free: it follows the pointer both ways.
  const start = (e: React.PointerEvent, key: string, id: string, from?: string, free = false) => {
    if (e.button !== 0 || (e.target as Element).closest('.row-close, .face-close, .group-head button, .group-head input, .machine-head button')) return
    const nav = (e.currentTarget as HTMLElement).closest('nav')
    if (!nav) return
    const scope = (e.currentTarget as HTMLElement).closest('.groups')
    const x0 = e.clientX, y0 = e.clientY
    // The list can scroll while you drag (a wheel, a trackpad): the dragged one stays under the pointer.
    const top0 = nav.scrollTop
    let last = { x: x0, y: y0 }
    const lift = (y: number) => y - y0 + nav.scrollTop - top0
    moved.current = false
    // Where everything was when the drag began: the slots stay put while things slide.
    const els = [...nav.querySelectorAll<HTMLElement>('[data-sort-key]')].filter((el) => el.dataset.sortKey === key)
    const ids = els.map((el) => el.dataset.sortId!)
    const i = ids.indexOf(id)
    const rects = els.map((el) => el.getBoundingClientRect())
    const size = free ? 0 : i + 1 < els.length ? rects[i + 1].top - rects[i].top : rects[i].height + parseFloat(getComputedStyle(els[i]).marginBottom)
    const others = ids.filter((x) => x !== id)
    // A sibling slides aside once the dragged one covers most of it, whatever their heights.
    const slot = (dy: number) => {
      const top = rects[i].top + dy, bottom = rects[i].bottom + dy
      return rects.filter((r, k) => k < i ? top > r.bottom - 0.6 * r.height : k > i && bottom > r.top + 0.6 * r.height).length
    }
    // The other group under the pointer, if any.
    const groupAt = (x: number, y: number) => {
      if (from == null || !scope) return null
      const g = [...scope.querySelectorAll<HTMLElement>('[data-group]')].find((el) => {
        const r = el.getBoundingClientRect()
        return x >= r.left && x <= r.right && y >= r.top && y < r.bottom
      })?.dataset.group
      return g == null || g === from ? null : g
    }
    let held = e.pointerType !== 'touch'
    const hold = held ? 0 : window.setTimeout(() => {
      held = moved.current = true
      document.body.classList.add('sorting')
      setDrag({ key, id, dx: 0, dy: 0, shift: {}, over: null })
    }, 400)
    // Once it holds, the finger moves the row, not the list.
    const noScroll = (ev: TouchEvent) => { if (held) ev.preventDefault() }
    const move = (ev: { clientX: number; clientY: number }) => {
      last = { x: ev.clientX, y: ev.clientY }
      const dx = ev.clientX - x0, dy = lift(ev.clientY)
      if (!held) { if (Math.hypot(dx, ev.clientY - y0) > 8) end(); return }
      if (!moved.current && Math.hypot(free ? dx : 0, dy) < 5) return
      if (!moved.current) { moved.current = true; document.body.classList.add('sorting') }
      const over = groupAt(ev.clientX, ev.clientY)
      const shift: Record<string, number> = {}
      if (!free && over == null) {
        const to = slot(dy)
        others.forEach((x, j) => { if (j < i && j >= to) shift[x] = size; else if (j >= i && j < to) shift[x] = -size })
      }
      setDrag({ key, id, dx: free ? dx : 0, dy, shift, over })
    }
    const end = () => {
      clearTimeout(hold)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('touchmove', noScroll)
      nav.removeEventListener('scroll', scrolled)
      document.body.classList.remove('sorting')
      setDrag(null)
    }
    const cancel = () => { end(); setTimeout(() => { moved.current = false }) }
    const up = (ev: PointerEvent) => {
      end()
      if (!moved.current) return
      // The click that ends a drag selects nothing.
      setTimeout(() => { moved.current = false })
      const over = groupAt(ev.clientX, ev.clientY)
      if (over != null) return onMove?.(id, over)
      if (free) return
      const order = [...others]
      order.splice(slot(lift(ev.clientY)), 0, id)
      if (order.some((x, k) => x !== ids[k])) onDrop(key, order)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('touchmove', noScroll, { passive: false })
    const scrolled = () => { if (moved.current) move({ clientX: last.x, clientY: last.y }) }
    nav.addEventListener('scroll', scrolled)
  }
  // Props for one sortable element.
  const sortable = (key: string, id: string) => {
    const on = drag?.key === key
    const dx = on && drag.id === id ? drag.dx : 0
    const dy = !on ? 0 : drag.id === id ? drag.dy : drag.shift[id] ?? 0
    return {
      'data-sort-key': key,
      'data-sort-id': id,
      onClickCapture: (e: React.MouseEvent) => { if (moved.current) { e.stopPropagation(); e.preventDefault() } },
      className: !on ? '' : drag.id === id ? ' dragged' : ' sliding',
      style: dx || dy ? { transform: `translate(${dx}px, ${dy}px)` } : undefined,
    }
  }
  return { start, sortable, over: drag?.over ?? null }
}

const short = shortPath

export function Sidebar({ width }: { width: number }) {
  const st = useStore()
  const [newIn, setNewIn] = useState<{ cwd: string; machine?: string; group?: string } | null>(null)
  const [history, setHistory] = useState(false)
  // Settings, on its page: in the page's address (url.ts). true: the page you looked at last.
  const setSettings = (p: Page | true) => { state.settingsPage = p === true ? localStorage.getItem('codinger.settingsPage') ?? 'general' : p; changed() }
  const [tasks, setTasks] = useState(false)
  const [menu, setMenu] = useState<MenuAt | null>(null)
  const openMenu = (e: React.MouseEvent, items: MenuItem[]) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, items }) }
  const local = st.machines[LOCAL]
  const others = machineList().filter((m) => m.name !== LOCAL)
  const away = offline()
  const custom = st.sessions.some((x) => x.order != null)
  const u = st.usage
  const tab = st.web || !local ? 'remote' : st.sideTab
  // Machines move like folders: drag one by its head.
  const drag = useDragSort((_key, names) => { state.machineOrder = names; changed() })
  const tree = (machine: string) => <MachineTree machine={machine} onNew={(cwd, group) => setNewIn({ cwd, machine, group: group || undefined })} onMenu={openMenu} />
  return (
    <aside className="sidebar" style={{ width }}>
      <div className="side-actions">
        <button className="primary" onClick={() => setNewIn({ cwd: '', machine: tab === 'local' ? LOCAL : others[0]?.name })}>+ New session</button>
        <button onClick={() => setHistory(true)} title={`Continue any Claude Code conversation on ${st.web ? currentMachine() : 'this machine'}, including terminal ones`}>Resume…</button>
        {/* Opens the palette (Palette.tsx), as ⌘K does: the way in on a phone. */}
        <button className="icon-btn side-search" aria-label="Search" data-tip="Search (⌘K)" onClick={() => window.dispatchEvent(new Event('codinger:palette'))}><SearchIcon size={16} /></button>
        {/* Only on a phone, where the sidebar covers the page: its close button. A lost connection shows as a banner (main.tsx: Offline). */}
        <button className="icon-btn side-hide" aria-label="Hide sessions" onClick={() => { state.sideOpen = false; changed() }}><XIcon size={18} /></button>
      </div>
      {/* Only the sessions that need you as rows, the rest as critters; or every session as a row. */}
      {!st.showArchived && (
        <div className="side-filter">
          {([false, true] as const).map((v) => <button key={String(v)} className={st.sideAll === v ? 'on' : ''} onClick={() => { state.sideAll = v; changed() }}>{v ? 'All sessions' : 'Needs me'}</button>)}
        </div>
      )}
      {/* The archived view: its banner, and a filter by folder that stays above the list. */}
      {st.showArchived && <>
        <div className="archive-banner"><ArchiveIcon size={13} /> Archived sessions<button className="icon-btn" title="Back to active sessions" onClick={() => showArchive(false)}><XIcon size={12} /></button></div>
        <ArchiveFilter machines={tab === 'local' ? [LOCAL] : others.map((m) => m.name)} />
      </>}
      <nav className={`tree${st.showArchived ? ' archived' : ''}`}>
        {tab === 'local' ? local && tree(LOCAL) : <>
          {others.map((m) => {
            const d = drag.sortable('machines', m.name)
            const shut = st.collapsed.includes(m.name)
            return (
              <div key={m.name} {...d} className={`machine${shut ? ' shut' : ''}${d.className}`}>
                <div className="machine-head"
                  onPointerDown={(e) => drag.start(e, 'machines', m.name)}
                  onClick={() => { state.collapsed = shut ? state.collapsed.filter((n) => n !== m.name) : [...state.collapsed, m.name]; changed() }}>
                  <ChevronIcon size={11} className="machine-chevron" />
                  <DeviceIcon m={m} />
                  <span className="machine-name">{labelOf(m.name)}</span>
                  {shut && !st.showArchived && <NeedBadge list={st.machines[m.name]?.sessions ?? []} />}
                  {!m.connected && <span className="conn off" />}
                  <button className="link" title={`New session on ${m.name}`} onClick={(e) => { e.stopPropagation(); setNewIn({ cwd: '', machine: m.name }) }}>+</button>
                </div>
                {!shut && tree(m.name)}
              </div>
            )
          })}
          {away.map((name) => <div key={name} className="machine off"><div className="machine-head"><span className="machine-name">{labelOf(name)}</span><span className="muted">not connected</span></div></div>)}
          {!others.length && !away.length && <div className="muted pad">No other machines. Connect one in Settings → Remote access on that machine.</div>}
        </>}
        {tab === 'local' && !local?.sessions.some((s) => s.kind === 'worker' && s.archived === st.showArchived) && <div className="muted pad">{st.showArchived ? 'No archived sessions.' : 'No sessions yet.'}</div>}
      </nav>
      <CostBanner open={() => setSettings('cost')} />
      <div className="side-bottom">
      {/* Floats above the line, so it takes no room from the footer. */}
      {custom && <button className="reset-order" title="Sort sessions by status again, newest first" onClick={() => void api('/api/sessions/order', 'DELETE')}>Reset order</button>}
      {/* On a machine's own page: its sessions, and the other machines'. On the web, every machine is remote. */}
      {!st.web && (others.length > 0 || away.length > 0 || !!local?.remote?.linked) && (
        <div className="side-tabs">
          {(['local', 'remote'] as const).map((t) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => { state.sideTab = t; changed() }}>{t === 'local' ? <>{local && <DeviceIcon m={local} tip={false} />} Local</> : <><GlobeIcon size={13} /> Remote</>}</button>)}
        </div>
      )}
      <div className="side-foot">
        <button className="link" title={st.web ? `Settings of ${currentMachine()}` : 'Settings'} onClick={() => setSettings(true)}><GearIcon size={14} /></button>
        <div className="side-foot-mid">
          {(u.fiveHour != null || u.sevenDay != null) && (
            <div className="usage" data-tip={limitsTip(u)} onClick={() => setSettings('cost')}>
              {u.fiveHour != null && <span className={level(u.fiveHour)}>5h {limitLabel(u.fiveHour, u.rate?.fiveHour, st.money)}</span>}
              {u.fiveHour != null && u.sevenDay != null && <span className="usage-dot">·</span>}
              {u.sevenDay != null && <span className={level(u.sevenDay)}>7d {limitLabel(u.sevenDay, u.rate?.sevenDay, st.money)}</span>}
            </div>
          )}
        </div>
        {st.artifacts.length > 0 && <button className={`link side-artifacts${st.page === 'artifacts' ? ' on' : ''}`} title={`Artifacts: ${st.artifacts.length}`} onClick={() => { state.page = state.page === 'artifacts' ? null : 'artifacts'; state.sideOpen = false; changed() }}><ArtifactIcon size={14} /></button>}
        {st.tasks.length > 0 && (() => {
          const running = st.tasks.filter((t) => !t.ended).length
          return <button className="link side-tasks" title={`Tasks: ${running} running`} onClick={() => setTasks(true)}><TerminalIcon size={14} />{running > 0 && <span>{running}</span>}</button>
        })()}
        {/* One toggle: pressed while the list shows archived sessions. */}
        <button className={`link archive-toggle${st.showArchived ? ' on' : ''}`} title={st.showArchived ? 'Show active sessions' : 'Show archived sessions'} onClick={() => showArchive(!st.showArchived)}><ArchiveIcon size={14} /></button>
      </div>
      </div>
      {newIn !== null && <NewSession cwd={newIn.cwd} machine={newIn.machine} group={newIn.group} onClose={() => setNewIn(null)} />}
      {history && <HistoryDialog onClose={() => setHistory(false)} />}
      {st.settingsPage && <SettingsDialog onClose={() => { state.settingsPage = null; changed() }} />}
      {tasks && <TasksDialog onClose={() => setTasks(false)} />}
      {menu && <CtxMenu at={menu} onClose={() => setMenu(null)} />}
    </aside>
  )
}

// Does a session match the text of the archived view's filter? The full path of a folder that
// one of the sessions has matches only that folder, not the folders under it; other text
// matches each session whose folder or name has it.
type Archived = { cwd: string; machine: string; title: string }
function archiveMatch(q: string, sessions: Archived[]) {
  const paths = (s: Archived) => [s.cwd.toLowerCase(), shortPath(s.cwd, s.machine).toLowerCase()]
  if (!q) return () => true
  const exact = sessions.some((s) => paths(s).includes(q))
  return (s: Archived) => exact ? paths(s).includes(q) : paths(s).some((p) => p.includes(q)) || s.title.toLowerCase().includes(q)
}

// The filter of the archived view: a box that suggests the folders and the sessions of the
// archived view as you type, and a checkbox that puts the sessions under their folders. The
// list shows 5 lines and scrolls to the others. With the box empty, all folders and sessions,
// newest first; with a folder's full path in it, all folders and the sessions in that folder;
// with other text, the folders and the session names that have it, those that start with it
// first. A folder you pick goes in the box; a session you pick opens.
type Option = { kind: 'folder'; path: string; n: number; newest: number } | { kind: 'session'; s: SessionMeta; machine: string }
function ArchiveFilter({ machines }: { machines: string[] }) {
  const st = useStore()
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState(-1)
  const list = useRef<HTMLDivElement>(null)
  const q = st.archiveQuery.trim().toLowerCase()
  const folders = new Map<string, { path: string; n: number; newest: number }>()
  const sessions: { s: SessionMeta; machine: string; path: string }[] = []
  for (const machine of machines) for (const s of st.machines[machine]?.sessions ?? []) {
    if (s.kind !== 'worker' || !s.archived) continue
    const path = shortPath(s.cwd, machine)
    const f = folders.get(path) ?? { path, n: 0, newest: 0 }
    folders.set(path, { path, n: f.n + 1, newest: Math.max(f.newest, s.createdAt) })
    sessions.push({ s, machine, path })
  }
  const picked = [...folders.keys()].find((p) => p.toLowerCase() === q)
  const typed = q && !picked ? q : ''
  const first = (name: string) => name.toLowerCase().startsWith(typed) ? 0 : 1
  const dirs: Option[] = [...folders.values()]
    .filter((f) => !typed || f.path.toLowerCase().includes(typed))
    .sort((a, b) => (typed ? first(nameOf(a.path)) - first(nameOf(b.path)) : 0) || b.newest - a.newest)
    .slice(0, 100).map((f) => ({ kind: 'folder', ...f }))
  const named: Option[] = sessions
    .filter((x) => picked ? x.path === picked : !typed || x.s.title.toLowerCase().includes(typed))
    .sort((a, b) => (typed ? first(a.s.title) - first(b.s.title) : 0) || b.s.lastActivity - a.s.lastActivity)
    .slice(0, 100).map((x) => ({ kind: 'session', s: x.s, machine: x.machine }))
  const options = [...dirs, ...named]
  // The list opens on the folder in the box, or on the line the arrow keys reach.
  const shown = open && options.length > 0
  useEffect(() => {
    if (!shown) return
    const el = list.current?.querySelector(at >= 0 ? '.archive-option.on' : '.archive-option.picked')
    el?.scrollIntoView({ block: 'nearest' })
  }, [shown, at, picked])
  const set = (v: string) => { state.archiveQuery = v; changed(); setAt(-1) }
  const pick = (o: Option) => {
    if (o.kind === 'folder') set(o.path)
    else select(o.s.id)
    setOpen(false)
  }
  const line = (o: Option, i: number) => (
    <div key={o.kind === 'folder' ? `d:${o.path}` : `s:${o.s.id}`} role="option" aria-selected={i === at}
      className={`archive-option${i === at ? ' on' : ''}${o.kind === 'folder' && o.path === picked ? ' picked' : ''}`}
      onMouseDown={(e) => { e.preventDefault(); pick(o) }} onMouseEnter={() => setAt(i)}>
      {o.kind === 'folder' ? <>
        <span className="archive-option-name">{nameOf(o.path)}</span>
        <span className="archive-option-path">{o.path}</span>
        <span className="archive-option-n">{o.n}</span>
      </> : <>
        <span className="archive-option-name">{o.s.title}</span>
        <span className="archive-option-path">{nameOf(shortPath(o.s.cwd, o.machine))}</span>
        <span className="archive-option-n">{timeAgo(o.s.lastActivity)}</span>
      </>}
    </div>
  )
  return (
    <div className="archive-filter">
      <div className="archive-search">
        <input type="search" placeholder="Filter by folder or name" value={st.archiveQuery} data-pid="archive-filter"
          onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onBlur={() => { setOpen(false); setAt(-1) }}
          onChange={(e) => { set(e.target.value); setOpen(true) }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              setOpen(true)
              // From the line you reached, or else from the folder in the box.
              const n = options.length, from = at >= 0 ? at : options.findIndex((o) => o.kind === 'folder' && o.path === picked)
              if (n) setAt(e.key === 'ArrowDown' ? (from + 1) % n : from < 0 ? n - 1 : (from - 1 + n) % n)
            } else if (e.key === 'Enter' && open && options[at]) pick(options[at])
            else if (e.key === 'Escape' && open) { e.preventDefault(); setOpen(false) }
          }} />
        {shown && (
          <div ref={list} className="archive-options" role="listbox">
            {dirs.length > 0 && <div className="archive-options-head">Folders</div>}
            {dirs.map((o, i) => line(o, i))}
            {named.length > 0 && <div className="archive-options-head">Sessions</div>}
            {named.map((o, i) => line(o, dirs.length + i))}
          </div>
        )}
      </div>
      <label><input type="checkbox" checked={st.archiveByFolder} data-pid="archive-by-folder" onChange={(e) => { state.archiveByFolder = e.target.checked; changed() }} /> By folder</label>
    </div>
  )
}

// A machine's icon: laptop or desktop, and what it runs.
const OS: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }
function DeviceIcon({ m, tip = true }: { m: Machine; tip?: boolean }) {
  // The only tooltip on a machine's head: on its icon, not on the head you click and drag.
  const title = `${labelOf(m.name)}${labelOf(m.name) !== m.name ? ` (${m.name})` : ''}: ${m.device === 'laptop' ? 'laptop' : m.device === 'desktop' ? 'desktop' : 'computer'}${OS[m.platform] ? `, ${OS[m.platform]}` : ''}, ${m.connected ? 'connected through web.codinger.app' : 'reconnecting…'}`
  const Icon = m.device === 'desktop' ? DesktopIcon : LaptopIcon
  return <span className="device" data-tip={tip ? title : undefined}><Icon os={m.platform} size={tip ? 18 : 15} /></span>
}

// The groups you made on a machine, in your order. A session is in one, or in
// none: those go last, under "No group".
const NONE = ''
const groupsOf = (machine: string): SessionGroup[] => state.machines[machine]?.settings.groups ?? []
function saveGroups(machine: string, groups: SessionGroup[]) {
  const m = state.machines[machine]
  if (!m) return
  m.settings = { ...m.settings, groups }
  changed()
  void api('/api/settings', 'PUT', { groups }, machine)
}
// A group you are naming: a new one, or one you double-clicked.
let naming: string | null = null
function newGroup(machine: string) {
  const g = { id: Math.random().toString(36).slice(2, 10), name: 'New group' }
  naming = g.id
  saveGroups(machine, [...groupsOf(machine), g])
  return g.id
}
// The server moves the sessions it started along with it.
function moveToGroup(s: SessionMeta, group: string) {
  const machine = machineOf(s.id), m = state.machines[machine]
  if (!m) return
  m.sessions = m.sessions.map((x) => x.id === s.id ? { ...x, group: group || undefined } : x)
  changed()
  void api(`/api/sessions/${s.id}`, 'PATCH', { group: group || null }, machine)
}

// Drag the critter in a session's head onto a group in the sidebar to move the session there.
// You pick the critter up: it leaves the head, and a copy that tilts and wiggles follows the
// pointer. The group under it shows the drop outline.
let headOver: { machine: string; group: string } | null = null
export function dragToGroup(e: React.PointerEvent, s: SessionMeta) {
  if (e.button !== 0 || e.pointerType === 'touch' || s.kind !== 'worker') return
  const src = e.currentTarget as HTMLElement
  const machine = machineOf(s.id)
  const x0 = e.clientX, y0 = e.clientY
  const r = src.getBoundingClientRect()
  let ghost: HTMLElement | null = null
  const groupAt = (x: number, y: number) => {
    const scope = document.querySelector<HTMLElement>(`.groups[data-machine="${CSS.escape(machine)}"]`)
    const g = scope && [...scope.querySelectorAll<HTMLElement>('[data-group]')].find((el) => {
      const b = el.getBoundingClientRect()
      return x >= b.left && x <= b.right && y >= b.top && y < b.bottom
    })?.dataset.group
    const known = new Set(groupsOf(machine).map((x) => x.id))
    const now = s.group && known.has(s.group) ? s.group : NONE
    return g == null || g === now ? null : g
  }
  const show = (g: string | null) => {
    if ((headOver?.group ?? null) === g) return
    headOver = g == null ? null : { machine, group: g }
    changed()
  }
  const move = (ev: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return
      ghost = document.createElement('div')
      Object.assign(ghost.style, { position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, zIndex: '1000', pointerEvents: 'none' })
      const copy = src.cloneNode(true) as HTMLElement
      copy.classList.add('critter-lift')
      ghost.append(copy)
      document.body.append(ghost)
      src.style.visibility = 'hidden'
      document.body.classList.add('sorting')
    }
    ghost.style.transform = `translate(${ev.clientX - x0}px, ${ev.clientY - y0}px)`
    show(groupAt(ev.clientX, ev.clientY))
  }
  const end = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', end)
    ghost?.remove()
    src.style.visibility = ''
    document.body.classList.remove('sorting')
    show(null)
  }
  const up = (ev: PointerEvent) => {
    const g = ghost ? groupAt(ev.clientX, ev.clientY) : null
    end()
    if (g != null) moveToGroup(s, g === '+' ? newGroup(machine) : g)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', end)
}

// One machine's sessions, by the groups you made. In a group, the sessions that need
// you are rows; the others are critters in one line at the bottom, unless you show all.
// A shut group shows only its head.
function MachineTree({ machine, onNew, onMenu }: { machine: string; onNew(cwd: string, group: string): void; onMenu(e: React.MouseEvent, items: MenuItem[]): void }) {
  const st = useStore()
  const m = st.machines[machine]
  const groups = m?.settings.groups ?? []
  const known = new Set(groups.map((g) => g.id))
  const gid = (s: SessionMeta) => s.group && known.has(s.group) ? s.group : NONE
  // Archived: only the sessions whose folder has the text you typed, and by folder if you ask.
  const q = st.showArchived ? st.archiveQuery.trim().toLowerCase() : ''
  const byDir = st.showArchived && st.archiveByFolder
  const shown = (m?.sessions ?? []).filter((s) => s.kind === 'worker' && s.archived === st.showArchived)
  const match = archiveMatch(q, shown.map((s) => ({ cwd: s.cwd, machine, title: s.title })))
  const workers = shown.filter((s) => match({ cwd: s.cwd, machine, title: s.title }))
  const tier = tiers(workers, (a, b) => byDir ? a.cwd === b.cwd : gid(a) === gid(b))
  const place = (s: SessionMeta) => s.order ?? -1
  // Starred sessions go first in their group, then the tiers.
  const star = (s: SessionMeta) => s.starred ? 0 : 1
  workers.sort((a, b) => star(a) - star(b) || tier(a) - tier(b) || place(a) - place(b) || b.createdAt - a.createdAt)
  const loose = workers.filter((s) => gid(s) === NONE)
  // Archived: only the groups with something in them. By folder: one section for each folder,
  // the folder with the newest session first. You cannot drag these or rename them.
  const sections = byDir
    ? [...new Set(workers.map((s) => s.cwd))]
      .map((cwd) => ({ g: { id: `dir:${cwd}`, name: shortPath(cwd, machine) }, list: workers.filter((s) => s.cwd === cwd) }))
      .sort((a, b) => Math.max(...b.list.map((s) => s.createdAt)) - Math.max(...a.list.map((s) => s.createdAt)))
    : [...groups, ...(loose.length ? [{ id: NONE, name: 'No group' }] : [])]
      .map((g) => ({ g, list: workers.filter((s) => gid(s) === g.id) }))
      .filter(({ list }) => list.length || !st.showArchived)
  const all = st.sideAll || st.showArchived
  const { start, sortable, over } = useDragSort((key, ids) => {
    if (!m) return
    if (key === `${machine}|groups`) {
      saveGroups(machine, ids.map((id) => groups.find((g) => g.id === id)!).filter(Boolean))
      return
    }
    m.sessions = m.sessions.map((s) => ids.includes(s.id) ? { ...s, order: ids.indexOf(s.id) } : s)
    void api('/api/sessions/order', 'PUT', { ids: ids.map(localId) }, machine)
    changed()
  }, (id, group) => {
    const s = m?.sessions.find((x) => x.id === id)
    if (s) moveToGroup(s, group === '+' ? newGroup(machine) : group)
  })
  const rename = (g: SessionGroup, name: string) => {
    naming = null
    if (name.trim() && name.trim() !== g.name) saveGroups(machine, groups.map((x) => x.id === g.id ? { ...x, name: name.trim() } : x))
    else changed()
  }
  const groupMenu = (g: SessionGroup) => (e: React.MouseEvent) => onMenu(e, [
    { label: 'Rename', run: () => { naming = g.id; changed() } },
    { label: 'Delete group', run: () => saveGroups(machine, groups.filter((x) => x.id !== g.id)) },
  ])
  if (!sections.length) return q && (m?.sessions ?? []).some((s) => s.kind === 'worker' && s.archived) ? <div className="muted pad">No folder or session matches “{st.archiveQuery.trim()}”.</div> : null
  const dropOn = (g: string) => over === g || (headOver?.machine === machine && headOver.group === g)
  return <div className="groups" data-machine={machine}>{sections.map(({ g, list }) => {
    const shutKey = `group:${machine}:${g.id}`
    const shut = st.collapsed.includes(shutKey)
    // A group you made: you can drag it, rename it, and drag sessions into it.
    const mine = !byDir && !!g.id
    const sg = mine ? sortable(`${machine}|groups`, g.id) : null
    const needs = list.filter((s) => own(s) <= 0)
    const rows = shut ? [] : all ? list : needs
    // The rest in the order they came, starred ones first, so that a critter keeps its place in the line.
    const rest = all ? [] : list.filter((s) => own(s) > 0).sort((a, b) => star(a) - star(b) || a.createdAt - b.createdAt)
    // Shown as a tree, a session and those nested under it move as one.
    const ids = new Set(rows.map((x) => x.id))
    const nest = all && !shut
    const kids = (parent: string | null) => rows.filter((x) => (nest && x.parentId && ids.has(x.parentId) ? x.parentId : null) === parent)
    const branch = (x: SessionMeta, depth: number): React.ReactNode => {
      const key = `${machine}|${g.id}|${nest && x.parentId && ids.has(x.parentId) ? x.parentId : ''}`
      const b = sortable(key, x.id)
      return (
        <div key={x.id} {...b} className={`branch${b.className}`}>
          <Row s={x} depth={depth} active={st.selected === x.id} folder={!byDir} onPointerDown={(e) => start(e, key, x.id, byDir ? undefined : g.id)} onMenu={onMenu} />
          {kids(x.id).map((k) => branch(k, depth + 1))}
        </div>
      )
    }
    const toggle = () => { state.collapsed = shut ? state.collapsed.filter((n) => n !== shutKey) : [...state.collapsed, shutKey]; changed() }
    // A new session in a group starts in the folder of its latest one.
    const folder = [...list].sort((a, b) => b.createdAt - a.createdAt)[0]?.cwd ?? ''
    return (
      <div key={g.id || '-'} {...sg} data-group={byDir ? undefined : g.id} className={`group${shut ? ' shut' : ''}${dropOn(g.id) ? ' drop' : ''}${sg?.className ?? ''}`}>
        <div className={`group-head${mine ? '' : ' fixed'}${byDir ? ' dir' : ''}`} onPointerDown={mine ? (e) => start(e, `${machine}|groups`, g.id) : undefined} onClick={toggle} onContextMenu={mine ? groupMenu(g) : undefined}>
          <ChevronIcon size={11} className="group-chevron" />
          {naming === g.id
            ? <GroupName name={g.name} onDone={(name) => rename(g, name)} />
            : <span className="group-name" onDoubleClick={mine ? (e) => { e.stopPropagation(); naming = g.id; changed() } : undefined}>{g.name}</span>}
          {byDir && <span className="group-count">{list.length}</span>}
          {shut && <NeedBadge list={list} />}
          <button className="link" title={`New session in ${byDir ? g.name : g.id ? g.name : 'no group'}`} onClick={(e) => { e.stopPropagation(); onNew(folder, byDir ? '' : g.id) }}>+</button>
        </div>
        {kids(null).map((x) => branch(x, 0))}
        {!shut && rest.length > 0 && (
          <div className="dock">
            {rest.map((s) => {
              const d = sortable(`${machine}|dock`, s.id)
              const parent = s.parentId && m?.sessions.find((x) => x.id === s.parentId)
              return (
                <button key={s.id} {...d} className={`face${st.selected === s.id ? ' active' : ''}${alertOf(s) ? ' alert' : ''}${d.className}`}
                  data-tip={`${s.title}${parent ? ` (from ${parent.title})` : ''} · ${s.compacting ? 'compacting' : STATUS_LABEL[s.status]}`} data-tip-at="right" data-tip-touch
                  onClick={() => select(s.id)} onPointerDown={(e) => start(e, `${machine}|dock`, s.id, g.id, true)} onContextMenu={(e) => onMenu(e, rowItems(s))}>
                  <Mascot status={s.status} look={s.look} fatigue={fatigue(s.context.used, s.context.window)} size={22} child={!!s.parentId} review={!!s.pendingReviews} starred={s.starred} />
                  {/* The open one can be archived from here, as a row can. */}
                  {st.selected === s.id && !s.archived && (
                    <span className="face-close" role="button" aria-label="Archive session" onClick={(e) => { e.stopPropagation(); void closeSession(s.id) }}><XIcon size={9} /></span>
                  )}
                </button>
              )
            })}
          </div>
        )}
        {!shut && !list.length && <div className="muted group-empty">Drag sessions here.</div>}
      </div>
    )
  })}
    {!st.showArchived && <div data-group="+" className={`new-group${dropOn('+') ? ' drop' : ''}`} role="button" onClick={() => newGroup(machine)}>+ New group</div>}
  </div>
}

// A group's name as you type it: Enter or a click elsewhere keeps it, Escape does not.
function GroupName({ name, onDone }: { name: string; onDone(name: string): void }) {
  const [v, setV] = useState(name)
  const done = useRef(false)
  const finish = (x: string) => { if (!done.current) { done.current = true; onDone(x) } }
  return <input className="group-input" autoFocus value={v} onFocus={(e) => e.target.select()} onChange={(e) => setV(e.target.value)}
    onClick={(e) => e.stopPropagation()} onBlur={() => finish(v)}
    onKeyDown={(e) => { if (e.key === 'Enter') finish(v); if (e.key === 'Escape') finish(name) }} />
}

// The last part of a path: the folder's own name.
const nameOf = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path

// A row names its folder, not its status: the critter shows the status. In a folder section the head names the folder.
function Row({ s, depth = 0, active, label, folder = true, onPointerDown, onMenu }: { s: SessionMeta; depth?: number; active: boolean; label?: string; folder?: boolean; onPointerDown?(e: React.PointerEvent): void; onMenu?(e: React.MouseEvent, items: MenuItem[]): void }) {
  const { sessions } = useStore()
  const parent = sessions.find((x) => x.id === s.parentId)
  const asks = archiveAsksOf(sessions, s.id).length
  return (
    <button className={`row${active ? ' active' : ''}${s.unread ? ' unread' : ''}${alertOf(s) ? ' alert' : ''}${s.status === 'error' ? ' error' : ''}`} style={{ paddingLeft: 10 + depth * 16 }} onClick={() => select(s.id)} onPointerDown={onPointerDown} onContextMenu={onMenu && ((e) => onMenu(e, rowItems(s)))}>
      <Mascot status={s.status} look={s.look} fatigue={fatigue(s.context.used, s.context.window)} size={26} title={STATUS_LABEL[s.status]} child={!!s.parentId} review={!!s.pendingReviews} starred={s.starred} />
      <span className="row-main">
        <span className="row-title">{machineOf(s.id) !== LOCAL && <GlobeIcon size={11} className="row-remote" title={`On ${machineOf(s.id)}`} />}{label ?? s.title}{parent && <span className="row-from"> (from {parent.title})</span>}</span>
        <span className="row-sub">{[s.compacting && 'compacting', folder && nameOf(s.cwd), timeAgo(s.lastActivity)].filter(Boolean).join(' · ')}<SpendHint s={s} /><CacheHint s={s} /></span>
      </span>
      {!!s.pendingCritical && <span className="count critical" data-tip="Critical items" data-tip-at="right">{s.pendingCritical}</span>}
      {asks > 0 && <span className="count held" data-tip="Asks to write to an archived session" data-tip-at="right">{asks}</span>}
      {s.inbox.length > 0 && <span className="count" title="Drafts from the lead">{s.inbox.length}</span>}
      {s.kind === 'worker' && !s.archived && (
        <span className="row-close" role="button" title="Archive session" onClick={(e) => { e.stopPropagation(); void closeSession(s.id) }}><XIcon size={12} /></span>
      )}
    </button>
  )
}

type MenuItem = { label: string; run(): unknown } | 'line' | { head: string }
type MenuAt = { x: number; y: number; items: MenuItem[] }

// What a right click on a session offers: read or unread, and a group to move it to.
function rowItems(s: SessionMeta): MenuItem[] {
  const machine = machineOf(s.id)
  const read: MenuItem = s.unread
    ? { label: 'Mark as read', run: () => api(`/api/sessions/${s.id}/seen`) }
    : { label: 'Mark as unread', run: () => api(`/api/sessions/${s.id}/unread`) }
  if (s.kind !== 'worker') return [read]
  const groups = groupsOf(machine).filter((g) => g.id !== s.group)
  const star: MenuItem = { label: s.starred ? 'Remove star' : 'Star', run: () => api(`/api/sessions/${s.id}`, 'PATCH', { starred: !s.starred }) }
  return [read, star, 'line', { head: 'Move to' },
    ...groups.map((g) => ({ label: g.name, run: () => moveToGroup(s, g.id) })),
    { label: 'New group', run: () => moveToGroup(s, newGroup(machine)) },
    ...(s.group && groupsOf(machine).some((g) => g.id === s.group) ? [{ label: 'No group', run: () => moveToGroup(s, NONE) }] : []),
  ]
}

// The menu a right click in the sidebar opens, where the pointer is.
function CtxMenu({ at, onClose }: { at: MenuAt; onClose(): void }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const down = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    window.addEventListener('blur', onClose)
    document.addEventListener('scroll', onClose, true)
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', key)
      window.removeEventListener('blur', onClose)
      document.removeEventListener('scroll', onClose, true)
    }
  }, [onClose])
  // Inside the window, however long the menu is.
  const [pos, setPos] = useState({ left: at.x, top: at.y })
  useEffect(() => {
    const r = box.current?.getBoundingClientRect()
    if (r) setPos({ left: Math.min(at.x, innerWidth - r.width - 6), top: Math.max(6, Math.min(at.y, innerHeight - r.height - 6)) })
  }, [at])
  return (
    <div className="menu ctx-menu" ref={box} style={pos} onContextMenu={(e) => e.preventDefault()}>
      {at.items.map((x, i) => x === 'line' ? <hr key={i} />
        : 'head' in x ? <div key={i} className="ctx-head">{x.head}</div>
        : <button key={i} onClick={() => { onClose(); void x.run() }}>{x.label}</button>)}
    </div>
  )
}

// A usage window in dollars at API prices, once the meter knows what a dollar uses:
// the meter's rate is the share of the limit one dollar uses, so the whole limit is 1 / rate.
function limitLabel(used: number, rate: number | undefined, mode: string) {
  if (mode !== 'usd' || !rate) return `${Math.round(used * 100)}%`
  return `${dollars(used / rate)}/${dollars(1 / rate)}`
}

// A limit close to used up: yellow from 80%, red from 90%.
const level = (used: number) => used >= 0.9 ? 'usage-bad' : used >= 0.8 ? 'usage-warn' : ''

// Dollars in few characters: $4.7, $48, $282, $1.8k, $18k.
function dollars(x: number): string {
  if (x >= 1000) return `$${+(x / 1000).toPrecision(2)}k`
  if (x >= 10) return `$${Math.round(x)}`
  return `$${+x.toPrecision(2)}`
}

function limitsTip(u: Usage) {
  const line = (name: string, used: number | undefined, rate: number | undefined) => used == null ? '' : rate
    ? `The ${name} limit is about ${usd(1 / rate)} at API prices. You used ${Math.round(used * 100)}% (about ${usd(used / rate)}); about ${usd((1 - used) / rate)} is left.`
    : `You used ${Math.round(used * 100)}% of your ${name} limit. Codinger does not know its dollar value yet.`
  return [line('5-hour', u.fiveHour, u.rate?.fiveHour), line('weekly', u.sevenDay, u.rate?.sevenDay)].filter(Boolean).join('\n\n')
    + `\n\nDollar values are estimates: Codinger compares Claude Code's spend at API prices with how far the percentages move (${u.rate?.pairs ?? 0} measurements). Click to see what your plan costs you.`
}

// What the conversation has cost so far. Only a label: the session's own pill explains it.
function SpendHint({ s }: { s: SessionMeta }) {
  useStore()
  const x = spendOf(s)
  if (!x) return null
  return <span className="row-spend"> · {x.label}</span>
}

// A cache about to expire, or one that has expired with a lot in it.
function CacheHint({ s }: { s: SessionMeta }) {
  const c = cacheOf(s, useNow())
  if (c.left == null || s.status === 'working') return null
  if (c.blocked) return <span className="cache-hint cold" title="Prompt cache expired. The next message re-caches the whole context"> · cache expired</span>
  if (!c.cold && c.left < (c.ttl >= 3_600_000 ? 10 : 2) * 60_000) return <span className="cache-hint soon" title="Prompt cache expires soon"> · cache {minutes(c.left)}</span>
  return null
}
