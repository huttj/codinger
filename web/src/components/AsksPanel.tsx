// The Asks page in Settings: the questions that sessions send to your phone as push
// notifications (server/asks.ts). A scheduled ask goes each day at its time; an ask waits for
// an answer until your next message in its session.

import { useEffect, useState } from 'react'
import { api, currentMachine, globalId, select } from '../store.ts'
import { XIcon } from './Icons.tsx'

type Schedule = { id: string; sid: string; title?: string; question: string; time: string; days?: string[]; then?: string; last?: string }
type Open = { sid: string; title?: string; question: string; ts: number }
type Reply = { schedules: Schedule[]; open: Open[] }

const DAY_NAMES: Record<string, string> = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' }
const when = (s: Schedule) => `${s.time}, ${s.days?.length ? s.days.map((d) => DAY_NAMES[d] ?? d).join(', ') : 'every day'}`
const sentAt = (ts: number) => new Date(ts).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export function AsksPanel({ onClose }: { onClose(): void }) {
  const m = currentMachine()
  const [r, setR] = useState<Reply | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const load = () => api<Reply>('/api/asks', 'GET', undefined, m).then(setR).catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  useEffect(() => { void load() }, [m])
  const cancel = async (s: Schedule) => {
    if (!confirm(`Cancel the daily ask "${s.question}"?`)) return
    try { await api(`/api/asks/${s.id}`, 'DELETE', undefined, m); await load() } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }
  const session = (sid: string, title?: string) => <button className="link" onClick={() => { onClose(); select(globalId(m, sid)) }}>{title ?? sid}</button>
  if (!r) return err ? <div className="notice error">{err}</div> : null
  return <>
    <p className="muted">Questions that sessions send to your phone as push notifications. A scheduled ask goes each day at its time, while Codinger runs on this machine. Your answer is your next message in that session.</p>
    {err && <div className="notice error">{err}</div>}
    <h3 className="cost-h">Scheduled</h3>
    {r.schedules.length ? <table className="mcp-table cost-table">
      <thead><tr><th>Question</th><th>Session</th><th>When</th><th>Last sent</th><th /></tr></thead>
      <tbody>{r.schedules.map((s) => <tr key={s.id}>
        <td>{s.question}{s.then && <div className="muted">Then: {s.then}</div>}</td>
        <td data-label="Session">{session(s.sid, s.title)}</td>
        <td data-label="When">{when(s)}</td>
        <td data-label="Last sent">{s.last ?? '–'}</td>
        <td><button className="icon-btn" aria-label="Cancel this ask" onClick={() => void cancel(s)}><XIcon size={12} /></button></td>
      </tr>)}</tbody>
    </table> : <p className="muted">No scheduled asks. An agent makes one with its schedule_ask tool.</p>}
    {r.open.length > 0 && <>
      <h3 className="cost-h">Waiting for your answer</h3>
      <table className="mcp-table cost-table">
        <thead><tr><th>Question</th><th>Session</th><th>Sent</th></tr></thead>
        <tbody>{r.open.map((o) => <tr key={`${o.sid} ${o.ts}`}>
          <td>{o.question}</td>
          <td data-label="Session">{session(o.sid, o.title)}</td>
          <td data-label="Sent">{sentAt(o.ts)}</td>
        </tr>)}</tbody>
      </table>
    </>}
  </>
}
