// Settings → Remote access. On a machine: connect it to web.codinger.app (you
// approve its code there), turn remote access off and on, or disconnect it.
// On web.codinger.app: who is signed in, and signing out.
// Both list your machines, each with a Remove.

import { useState } from 'react'
import { api, knownMachines, LOCAL, refreshMachines, useStore } from '../store.ts'

// The hub's second address, for networks where web.codinger.app does not resolve.
const WORKERS_DEV = 'https://codinger-web.huttj.workers.dev'

export function RemotePanel() {
  const st = useStore()
  if (st.web) return (
    <div className="remote-panel">
      <p>Signed in to web.codinger.app as <b>{st.email}</b>.</p>
      {knownMachines().map((m) => (
        <div key={m.name} className="remote-machine">
          <Names name={m.name} label={m.label} connected={m.connected} removable />
        </div>
      ))}
      {!knownMachines().length && <p>No machines yet.</p>}
      <p className="muted">To add a machine, open Settings → Remote access in the Codinger on that machine.</p>
      <form method="post" action="/_remote/logout"><button>Sign out</button></form>
    </div>
  )
  return <MachinePanel />
}

function MachinePanel() {
  const st = useStore()
  const r = st.machines[LOCAL]?.remote
  const [name, setName] = useState(r?.name ?? '')
  const [hub, setHub] = useState(r?.hub ?? '')
  const [busy, setBusy] = useState(false)
  if (!r) return <p className="muted">Loading…</p>
  const others = knownMachines().filter((m) => m.name !== r.name)
  const call = (path: string, body?: unknown) => api(`/api/remote/${path}`, 'POST', body, LOCAL)

  const link = async () => {
    // Open the tab in the click, so the browser lets it open; it goes to the approval page once there is one.
    const tab = window.open('', '_blank')
    setBusy(true)
    try {
      const s = await call('link', { name: name.trim() || r.name, hub: hub.trim() || r.hub })
      if (s.linking && tab) tab.location.href = s.linking.url
      else tab?.close()
    } catch { tab?.close() } finally { setBusy(false) }
  }

  if (r.linking) return (
    <div className="remote-panel">
      <p>Approve this machine on web.codinger.app. Check that the page shows this code:</p>
      <p className="remote-code">{r.linking.code}</p>
      <p><a href={r.linking.url} target="_blank" rel="noreferrer">Open the approval page</a> · <button className="link" onClick={() => void call('cancel')}>Cancel</button></p>
    </div>
  )

  if (!r.linked) return (
    <div className="remote-panel">
      <p>Connect this machine to <b>web.codinger.app</b>. Then you can use its sessions from any browser where you are signed in, and from your other machines.</p>
      <label>Name of this machine <input value={name} onChange={(e) => setName(e.target.value)} placeholder={r.name} /></label>
      <label>Address of the hub <input value={hub} onChange={(e) => setHub(e.target.value)} placeholder={r.hub} /></label>
      <p className="muted">Use <code>{WORKERS_DEV}</code> if <code>web.codinger.app</code> does not work on this network.</p>
      <p><button className="primary" disabled={busy} onClick={() => void link()}>{busy ? 'Starting…' : 'Connect this machine'}</button></p>
      <p className="muted">The machine makes the connection itself. It opens no port.</p>
    </div>
  )

  return (
    <div className="remote-panel">
      <label className="toggle"><input type="checkbox" checked={r.on} onChange={(e) => void call('on', { on: e.target.checked })} /> Remote access</label>
      <p>
        This machine{' '}
        {!r.on ? <span className="muted">is off: nobody can use it from the web or your other machines.</span>
          : r.connected ? <span>is connected to {r.hub.replace(/^https?:\/\//, '')}.</span>
          : <span className="muted">is connecting…</span>}
      </p>
      <Names name={r.name} label={r.label} connected={r.connected} />
      <HubAddress hub={r.hub} onSave={(h) => void call('hub', { hub: h })} />
      <p><button onClick={() => { if (confirm(`Disconnect ${r.label ?? r.name} from web.codinger.app? To connect it again, you approve it again.`)) void call('forget') }}>Disconnect this machine</button></p>
      {others.length > 0 && <>
        <p className="remote-others">Your other machines</p>
        {others.map((m) => (
          <div key={m.name} className="remote-machine">
            <Names name={m.name} label={m.label} connected={m.connected} removable />
          </div>
        ))}
      </>}
    </div>
  )
}

// Where a connected machine reaches the hub. Both addresses are the same hub, so a change needs no new approval.
function HubAddress({ hub, onSave }: { hub: string; onSave(h: string): void }) {
  const [edit, setEdit] = useState<string | null>(null)
  if (edit == null) return <p className="muted">Through <code>{hub.replace(/^https:\/\//, '')}</code> · <button className="link" onClick={() => setEdit(hub)}>Change</button></p>
  return (
    <form className="remote-hub" onSubmit={(e) => { e.preventDefault(); onSave(edit); setEdit(null) }}>
      <label>Address of the hub <input value={edit} autoFocus onChange={(e) => setEdit(e.target.value)} /></label>
      <p className="muted">
        <button type="button" className="link" onClick={() => setEdit('https://web.codinger.app')}>web.codinger.app</button> · <button type="button" className="link" onClick={() => setEdit(WORKERS_DEV)}>{WORKERS_DEV.replace(/^https:\/\//, '')}</button>
      </p>
      <p><button type="submit" className="primary">Save</button> <button type="button" onClick={() => setEdit(null)}>Cancel</button></p>
    </form>
  )
}

// A machine's display name (what the sidebar shows) and its name (its id in addresses), each with a Rename.
// removable: a Remove too, which deletes the machine and its token on the hub.
function Names({ name, label, connected, removable }: { name: string; label?: string; connected: boolean; removable?: boolean }) {
  const st = useStore()
  const [edit, setEdit] = useState<'label' | 'rename' | null>(null)
  const [value, setValue] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const open = (what: 'label' | 'rename') => { setEdit(what); setValue(what === 'label' ? label ?? name : name); setErr(null) }
  const save = async () => {
    const body = edit === 'label' ? { label: value } : { name: value.trim().toLowerCase() }
    const path = `/machines/${name}/${edit}`
    try {
      if (st.web) {
        const r = await fetch(`/_remote${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `${r.status}`)
      } else await api(`/api/remote${path}`, 'POST', body, LOCAL)
      setEdit(null)
      void refreshMachines()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }
  const remove = async () => {
    if (!confirm(`Remove ${label ?? name} from web.codinger.app? It disconnects at once. To connect it again, open Settings → Remote access on that machine and approve it again.`)) return
    setErr(null)
    try {
      const path = `/machines/${name}`
      if (st.web) {
        const r = await fetch(`/_remote${path}`, { method: 'DELETE' })
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `${r.status}`)
      } else await api(`/api/remote${path}`, 'DELETE', undefined, LOCAL)
      void refreshMachines()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }
  if (edit) return (
    <form className="remote-names" onSubmit={(e) => { e.preventDefault(); void save() }}>
      <label>{edit === 'label' ? 'Display name' : 'Machine name (lower-case letters, digits and dashes)'} <input value={value} autoFocus onChange={(e) => setValue(e.target.value)} /></label>
      {edit === 'rename' && <p className="muted">The name is in the addresses of its sessions. Browsers lose unsent drafts in that machine's sessions.</p>}
      {err && <p className="notice error">{err}</p>}
      <p><button type="submit" className="primary">Save</button> <button type="button" onClick={() => setEdit(null)}>Cancel</button></p>
    </form>
  )
  return (<>
    <p className="remote-names">
      <b>{label ?? name}</b>{!connected && <span className="muted"> · not connected</span>}
      <br /><span className="muted">Name <code>{name}</code> · <button className="link" onClick={() => open('label')}>Change display name</button> · <button className="link" onClick={() => open('rename')}>Rename</button>{removable && <> · <button className="link" onClick={() => void remove()}>Remove</button></>}</span>
    </p>
    {err && <p className="notice error">{err}</p>}
  </>)
}
