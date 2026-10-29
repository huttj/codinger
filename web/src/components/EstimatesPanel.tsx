// The Estimates page in Settings: each estimate an agent saved with save_estimate, next to what
// the work took (server/estimates.ts), under the medians that the agents' prompt quotes. The time
// is the time of the session's turns: the waits between turns do not count.

import { useEffect, useState } from 'react'
import { api, currentMachine, globalId, select } from '../store.ts'
import { money } from '../../../shared/costs.ts'
import type { EstimatesReply } from '../../../shared/estimates.ts'

const mins = (m: number) => m < 1 ? `${Math.round(m * 60)} s` : m < 120 ? `${Math.round(m * 10) / 10} min` : `${Math.round(m / 6) / 10} h`
const times = (x: number) => `${x >= 10 ? Math.round(x) : Math.round(x * (x < 1 ? 100 : 10)) / (x < 1 ? 100 : 10)}×`
const day = (t: number) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export function EstimatesPanel({ onClose }: { onClose(): void }) {
  const m = currentMachine()
  const [r, setR] = useState<EstimatesReply | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let on = true
    api<EstimatesReply>('/api/estimates', 'GET', undefined, m).then((x) => { if (on) setR(x) }).catch((e) => { if (on) setErr(e instanceof Error ? e.message : String(e)) })
    return () => { on = false }
  }, [m])
  if (!r) return err ? <div className="notice error">{err}</div> : null
  const f = r.found
  return <>
    <p className="muted">Each estimate that an agent saved with save_estimate, next to what the work took when it called save_actual. The time counts only the session's turns: the time when it waited for you or for a background task does not count. The agents' prompt quotes the medians, so the next estimates start from them.</p>
    {f.n > 0 && <div className="est-tiles" data-pid="estimate-medians">
      {f.time != null && <div className="est-tile"><b>{times(f.time)}</b><span>the estimated time</span></div>}
      {f.cost != null && <div className="est-tile"><b>{times(f.cost)}</b><span>the estimated cost</span></div>}
      {f.perHour != null && <div className="est-tile"><b>{mins(f.perHour)}, {money(f.usdPerHour ?? 0)}</b><span>for 1 human hour</span></div>}
      <div className="est-tile-note muted">Medians of {f.n} finished {f.n === 1 ? 'estimate' : 'estimates'}: the actual work took</div>
    </div>}
    {r.rows.length ? <div className="est-list">{r.rows.map((e) => {
      const a = e.actual
      return <article key={e.id} className="est-card" data-pid={`estimate-${e.id}`}>
        <h4>{e.task}</h4>
        <div className="est-meta muted">
          {e.title ? <button className="link" onClick={() => { onClose(); select(globalId(m, e.sid)) }}>{e.title}</button> : e.sid}
          <span> · {day(e.t)}</span>
        </div>
        <div className="est-grid">
          <span /><span className="muted">Estimate</span><span className="muted">Actual</span><span className="muted">Ratio</span>
          <span className="muted">Time</span><span>{mins(e.minutes)}</span><span>{a ? mins(a.minutes) : '–'}</span><span className="est-ratio">{a ? times(a.minutes / e.minutes) : ''}</span>
          <span className="muted">Cost</span><span>{e.usd != null ? money(e.usd) : '–'}</span><span>{a ? money(a.usd) : '–'}</span><span className="est-ratio">{a && e.usd ? times(a.usd / e.usd) : ''}</span>
        </div>
        <div className="est-meta muted">{[
          a ? null : 'Open: no actual yet',
          a && a.wall != null && a.wall !== a.minutes ? `${mins(a.wall)} on the clock` : null,
          a ? `${a.calls} API calls` : null,
          e.humanHours != null ? `${e.humanHours} human hours estimated` : null,
        ].filter(Boolean).join(' · ')}</div>
        {a?.note && <p className="est-note">{a.note}</p>}
      </article>
    })}</div> : <p className="muted">No estimates yet. An agent saves one when it gives you an estimate of a piece of work.</p>}
  </>
}
