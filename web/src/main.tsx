import { createRoot } from 'react-dom/client'
import { useEffect } from 'react'
import { api, changed, globalId, opened, select, start, state, useStore, currentMachine, labelOf, localId, machineOf } from './store.ts'
import type { SessionMeta } from '../../shared/types.ts'
import { useState } from 'react'
import { Sidebar } from './components/Sidebar.tsx'
import { SessionView } from './components/SessionView.tsx'
import { Splitter, useWidth } from './components/Splitter.tsx'
import { AppearanceDialog } from './components/AppearanceDialog.tsx'
import { ArtifactCheck, ArtifactsView, PublishToasts } from './components/Artifacts.tsx'
import { useFavicon } from './favicon.tsx'
import { ChevronIcon, MenuIcon } from './components/Icons.tsx'
import { initTooltips } from './tooltip.ts'
import { initPeek } from './peek.ts'
import { closeLinkedNew, initUrl, linkedNew } from './url.ts'
import { NewSession } from './components/NewSession.tsx'
import { Lightbox } from './components/Lightbox.tsx'
import { Palette } from './components/Palette.tsx'
import { PhoneSetup } from './components/PhoneSetup.tsx'
import { useCritterIcons } from './critterIcon.tsx'
import './push.ts'
import './styles.css'

function App() {
  const st = useStore()
  const [side, setSide] = useWidth('sidebar', 260)
  // The lead agent is hidden for now: only workers show.
  const sel = st.sessions.find((s) => s.id === st.selected && s.kind === 'worker')
  useEffect(() => { if (sel) opened(sel.id) }, [sel?.id])

  useFavicon(st.sessions, st.settings.appearance)
  useCritterIcons(st.sessions)

  // The first load asks for a colour; the welcome stays until you close it.
  const [welcome, setWelcome] = useState(false)
  useEffect(() => { if (st.loaded && !st.settings.appearance) setWelcome(true) }, [st.loaded])

  return (
    <div className={`app${st.sideOpen ? ' side-open' : ''}${st.sideHidden ? ' side-hidden' : ''}`}>
      <Sidebar width={side} />
      {/* On a wide screen a click on the splitter hides the sidebar; the strip in its place shows it again. */}
      <Splitter width={side} setWidth={setSide} min={180} max={560} initial={260} tip="Drag to resize · click to hide (⌘\)"
        onClick={() => { state.sideHidden = true; changed() }} />
      <button className="side-reveal" aria-label="Show sessions (⌘\)" onClick={() => { state.sideHidden = false; changed() }}><ChevronIcon size={12} /></button>
      <main>
        {/* On a phone the sidebar covers the page; this shows it again. */}
        <button className="icon-btn side-show" aria-label="Sessions" onClick={() => { state.sideOpen = true; changed() }}><MenuIcon size={18} /></button>
        <SignIn />
        <Update />
        <Restart />
        <Reload />
        <PhoneSetup />
        {!st.connected && !st.sessions.length ? <div className="empty">Connecting to the Codinger server…</div>
          : st.page === 'artifacts' ? <ArtifactsView />
          : sel ? <SessionView key={sel.id} id={sel.id} />
          : <div className="empty no-session">No session selected.</div>}
      </main>
      <ArtifactCheck />
      {welcome && <AppearanceDialog welcome onClose={() => setWelcome(false)} />}
      {linkedNew && st.loaded && <NewSession cwd={linkedNew.cwd} title={linkedNew.title} prompt={linkedNew.prompt} onClose={closeLinkedNew} />}
      <Palette />
      {st.lightbox && <Lightbox src={st.lightbox} onClose={() => { state.lightbox = null; changed() }} />}
      {/* Notices stack in the bottom left corner. */}
      <div className="toasts">
        <Offline />
        <PublishToasts />
        {st.error && <div className="toast" onClick={() => { state.error = null; changed() }}>{st.error}</div>}
      </div>
    </div>
  )
}

// An update from origin/main (server/update.ts) that waits, runs or stopped. When it
// installs, the server restarts and the page comes back by itself.
function Update() {
  const { update: u } = useStore()
  const [closed, setClosed] = useState(() => localStorage.getItem('codinger.updateClosed'))
  // The first time it asks: your answer can stand for next time too (Settings → Updates from GitHub).
  const [remember, setRemember] = useState(true)
  if (!u || u.state === 'current' || (closed === u.head && u.state !== 'updating')) return null
  const subject = u.subject.length > 90 ? u.subject.slice(0, 88) + '…' : u.subject
  const what = `A Codinger update is ready (${u.behind === 1 ? '1 new commit' : `${u.behind} new commits`}, latest: “${subject}”).`
  const close = () => { localStorage.setItem('codinger.updateClosed', u.head); setClosed(u.head) }
  const agent = () => { const m = currentMachine(); void api<SessionMeta>('/api/update/agent', 'POST', undefined, m).then((s) => select(globalId(m, s.id))) }
  if (u.state === 'offer') {
    const answer = (yes: boolean) => {
      if (remember) void api('/api/settings', 'PUT', { autoUpdate: yes ? 'always' : 'never' })
      else if (yes) void api('/api/update/now', 'POST')
      else close()
    }
    return (
      <div className="signin restart">
        <span>Codinger on GitHub has an update ({u.behind === 1 ? '1 new commit' : `${u.behind} new commits`}, latest: “{subject}”). Install it and restart?</span>
        <button className="primary" onClick={() => answer(true)}>Update</button>
        <button onClick={() => answer(false)}>Not now</button>
        <label className="update-remember"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember my choice</label>
      </div>
    )
  }
  return (
    <div className="signin restart">
      {u.state === 'updating' ? <span>Updating Codinger to “{subject}”…</span>
        : u.state === 'waiting' ? <>
          <span>{what} It installs when no session is working.</span>
          <button className="primary" onClick={() => void api('/api/update/now', 'POST')}>Update now</button>
        </> : <>
          <span>{u.state === 'failed' ? `The Codinger update failed: ${u.why}` : `${what} It cannot install by itself: ${u.why}`}</span>
          <button className="primary" onClick={agent}>Ask an agent to update</button>
        </>}
      {u.state !== 'updating' && <button className="link" onClick={close}>Not now</button>}
    </div>
  )
}

// Where this page came from serves a newer one: the machine's server after a restart, the hub
// after a deploy (web.codinger.app), or a machine's page through the hub (/m/<machine>/). Its
// index.html names another main script. Reload to use it: drafts and the message box are kept
// in localStorage, so a reload loses nothing.
const OWN_BUILD = new URL(import.meta.url).pathname.split('/').pop()
let newer = false
async function checkBuild() {
  if (import.meta.env.DEV || newer || document.hidden) return
  try {
    const html = await (await fetch((window as { __base?: string }).__base || '/', { cache: 'no-store' })).text()
    const build = /\/assets\/(main-[\w-]+\.js)/.exec(html)?.[1]
    if (build && build !== OWN_BUILD) { newer = true; changed() }
  } catch { /* offline: the next check tries again */ }
}
function Reload() {
  const st = useStore()
  // When the server comes back (a restart), when the page shows again, and every ten minutes.
  useEffect(() => { if (st.connected) void checkBuild() }, [st.connected])
  useEffect(() => {
    const t = setInterval(() => void checkBuild(), 10 * 60_000)
    const seen = () => void checkBuild()
    document.addEventListener('visibilitychange', seen)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', seen) }
  }, [])
  if (!newer) return null
  return (
    <div className="signin restart">
      <span>Codinger has a newer version of this page. Reload to use it.</span>
      <span className="banner-btns"><button className="primary" onClick={() => location.reload()}>Reload</button></span>
    </div>
  )
}

// The server's code changed on disk: restart it from here (it comes back by itself).
function Restart() {
  const st = useStore()
  // The × hides it until that server has newer code, or the page loads again.
  const [hidden, setHidden] = useState('')
  const key = `${currentMachine()} ${st.staleAt ?? ''}`
  // Only for working on Codinger itself (Settings turns it on).
  if (st.restarting === null && !(st.stale && st.settings.selfRestart && hidden !== key)) return null
  const busy = st.sessions.filter((s) => s.status === 'working' || s.status === 'permission').length
  return (
    <div className="signin restart">
      {st.restarting !== null ? <span>Restarting Codinger…</span> : <>
        <span>The Codinger server on {st.web || machineOf(st.selected) ? labelOf(currentMachine()) : 'this machine'} has new code on disk (an update, or a change an agent made). Restart that server to use it.{busy ? ` ${busy} ${busy === 1 ? 'session is' : 'sessions are'} working and will keep working.` : ''}</span>
        {/* At the right: Later, then Restart, the main one, last. */}
        <span className="banner-btns">
          <button onClick={() => setHidden(key)}>Later</button>
          <button className="primary" onClick={() => { const m = currentMachine(); state.restarting = m; changed(); void api('/api/restart', 'POST', undefined, m).catch(() => {}) }}>Restart</button>
        </span>
      </>}
    </div>
  )
}

// The page lost its connection to the server and reconnects by itself: a toast in the
// bottom left corner. A drop shorter than a second shows nothing; a restart has its own banner (Restart, below).
function Offline() {
  const st = useStore()
  const down = !st.connected && st.sessions.length > 0 && st.restarting === null
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!down) { setShown(false); return }
    const t = setTimeout(() => setShown(true), 1000)
    return () => clearTimeout(t)
  }, [down])
  if (!down || !shown) return null
  return <div className="offline-toast"><span className="conn off" />Not connected{st.web ? ` to ${labelOf(currentMachine())}` : ''}. Reconnecting…</div>
}

// Claude Code's login is missing or expired: sign in from here.
function SignIn() {
  const { auth } = useStore()
  const [code, setCode] = useState('')
  if (auth.state === 'ok') return null
  const submit = () => { if (code.trim()) void api('/api/login/code', 'POST', { code }).then(() => setCode('')) }
  return (
    <div className={`signin st-${auth.state}`}>
      {auth.state === 'pending' ? <>
        <span>Sign in to Claude in the browser.</span>
        {auth.url && <a href={auth.url} target="_blank" rel="noreferrer">Open the sign-in page</a>}
        <input placeholder="Code" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit() }} />
        <button disabled={!code.trim()} onClick={submit}>Submit</button>
        <button className="link" onClick={() => void api('/api/login/cancel')}>Cancel</button>
      </> : <>
        <span>{auth.state === 'failed' ? `Sign-in failed${auth.error ? `: ${auth.error}` : ''}` : 'Claude Code is signed out.'}</span>
        <button className="primary" onClick={() => void api('/api/login')}>Sign in</button>
      </>}
    </div>
  )
}

// Images in replies and sent messages are small; a click shows one full size. So it does
// for an image an agent shows, in a message (not one in a link) or from show_file.
document.addEventListener('click', (e) => {
  const img = (e.target as Element | null)?.closest?.('img.ri-img, .user-part .md img, .note-card.sent .md img, .assistant-text img:not(a img), img.media-img') as HTMLImageElement | null
  if (!img || img.classList.contains('loading')) return
  e.preventDefault()
  state.lightbox = img.src
  changed()
})
// A link to another session in a message (util.ts) shows it: the id is on the machine of the
// message's session, and may be cut short.
document.addEventListener('click', (e) => {
  const a = (e.target as Element | null)?.closest?.<HTMLElement>('a.session-link')
  if (!a) return
  e.preventDefault()
  const id = a.dataset.session!, from = a.closest<HTMLElement>('[data-sid]')?.dataset.sid
  const machine = from ? machineOf(from) : currentMachine()
  const s = state.sessions.find((x) => x.id === globalId(machine, id))
    ?? state.sessions.find((x) => machineOf(x.id) === machine && localId(x.id).startsWith(id) && id.length >= 6)
  if (s) select(s.id)
})
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.lightbox) { state.lightbox = null; changed() } })
// ⌘\ (Ctrl+\ off a Mac) hides the sidebar on a wide screen, or shows it again.
document.addEventListener('keydown', (e) => {
  if (e.key === '\\' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && !phone.matches) { e.preventDefault(); state.sideHidden = !state.sideHidden; changed() }
})
// No zoom on a phone: iOS Safari ignores user-scalable=no in the viewport tag, so stop the pinch here.
for (const t of ['gesturestart', 'gesturechange']) document.addEventListener(t, (e) => e.preventDefault(), { passive: false })
document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault() }, { passive: false })

// On a phone a swipe from the left edge pulls the sessions out under the finger, instead of going back a page.
// They open if you let go past a third of the way or with a flick to the right; else they go back.
// A swipe to the left anywhere on the open sessions pushes them back the same way.
const phone = matchMedia('(max-width: 720px)')
const openSide = () => { if (!state.sideOpen) { state.sideOpen = true; changed() } }
const sideEl = () => document.querySelector<HTMLElement>('.sidebar')
// Show the sidebar with its right edge at x, or (null) give it back to the stylesheet, which animates it to open or closed.
function pull(x: number | null) {
  const el = sideEl()
  if (!el) return
  if (x === null) { el.style.transform = el.style.transition = el.style.visibility = ''; return }
  el.style.transition = 'none'
  el.style.visibility = 'visible'
  el.style.transform = `translateX(${Math.min(0, x - el.offsetWidth)}px)`
}
let edge: { x0: number; y0: number; x: number; t: number; v: number; drag: boolean; shut: boolean } | null = null
document.addEventListener('touchstart', (e) => {
  const t = e.touches[0], el = e.target as Element
  // A reaction button keeps its press and drag: no pull, and no back swipe from Safari (which opens
  // the sessions, below), however near the edge it is. It works by pointer events, which still come.
  if (phone.matches && el.closest?.('.ack-btn, .react-mark')) { edge = null; e.preventDefault(); return }
  // A dialog that the sidebar opened (Settings) is inside it, but a drag there scrolls the dialog.
  const shut = state.sideOpen && !!el.closest?.('.sidebar') && !el.closest?.('.modal-back')
  edge = phone.matches && e.touches.length === 1 && (shut || (!state.sideOpen && t.clientX < 20 && !el.closest?.('button, a, input, textarea, select, .ack-pop, .emoji-picker')))
    ? { x0: t.clientX, y0: t.clientY, x: t.clientX, t: e.timeStamp, v: 0, drag: false, shut } : null
  if (edge && !shut) e.preventDefault()  // so Safari does not start its own back swipe, where it lets a page stop it
}, { passive: false })
document.addEventListener('touchmove', (e) => {
  if (!edge) return
  if (document.body.classList.contains('sorting')) { edge = null; return }  // a held press moves a session, not the sessions
  const t = e.touches[0], dx = (t.clientX - edge.x0) * (edge.shut ? -1 : 1), dy = t.clientY - edge.y0
  if (!edge.drag) {
    if (Math.abs(dy) > 10 && Math.abs(dy) > dx) { edge = null; return }  // a move up or down, not a pull
    if (dx < 10) return
    edge.drag = true
  }
  if (edge.shut) e.preventDefault()  // the list does not scroll under a push
  // The speed in px/ms, smoothed over the last moves.
  const dt = e.timeStamp - edge.t
  if (dt > 0) edge.v = 0.6 * (t.clientX - edge.x) / dt + 0.4 * edge.v
  edge.x = t.clientX
  edge.t = e.timeStamp
  pull(edge.shut ? (sideEl()?.offsetWidth ?? innerWidth) + edge.x - edge.x0 : edge.x)
}, { passive: false })
const release = (e: TouchEvent) => {
  const d = edge
  edge = null
  if (!d?.drag) return
  const w = sideEl()?.offsetWidth ?? innerWidth
  const v = e.timeStamp - d.t < 100 ? d.v : 0  // a finger that stopped before it let go has no flick
  pull(null)
  if (d.shut) {
    if (e.type === 'touchend' && (v < -0.3 || (d.x0 - d.x > w / 3 && v < 0.3))) { state.sideOpen = false; changed() }
    return
  }
  const open = e.type === 'touchend' && (v > 0.3 || (d.x > w / 3 && v > -0.3))
  if (open) openSide()
}
document.addEventListener('touchend', release)
document.addEventListener('touchcancel', release)
// Where Safari's back swipe still happens, it goes back to an entry of our own: open the sessions and add it again.
// The entry goes in at the first tap, as Safari can skip entries that a page adds before the user does anything.
document.addEventListener('click', () => { if (phone.matches) history.pushState({ side: true }, '') }, { once: true })
addEventListener('popstate', () => { if (phone.matches) { openSide(); history.pushState({ side: true }, '') } })

initUrl()
void start()
initTooltips()
initPeek()
createRoot(document.getElementById('root')!).render(<App />)
