// What your plan costs you (shared/costs.ts): the price you pay, what a dollar
// of API work and a prompt cost you, the least they could cost at full utilization,
// and the weekly and monthly reviews. CostBanner, in the sidebar, asks for the
// price and says when a review is ready; Settings has the whole of it.

import { useEffect, useMemo, useState } from 'react'
import { api, changed, currentMachine, state, useStore } from '../store.ts'
import { PLANS, cents, daysAgo, daysIn, fmtDay, lastMonth, lastWeek, money, prevMonth, prevWeek, review, today, totals, weekOf, type CostsReply, type Period } from '../../../shared/costs.ts'
import { XIcon } from './Icons.tsx'
import { UsageAudit, dayTotals, useUsage } from './UsageAudit.tsx'
import { ChartHead, SLOTS, WorkChart, useView, util, type Totals } from './CostChart.tsx'

// One copy for the banner and the page, of the current machine, read again every half hour.
let costs: CostsReply | null = null
let costsOf = ''
let loading: Promise<void> | null = null
let readAt = 0
function load(force = false) {
  const m = currentMachine()
  if (m !== costsOf) { costs = null; costsOf = m; readAt = 0; loading = null }
  if (loading || (!force && Date.now() - readAt < 30 * 60_000)) return loading
  const p: Promise<void> = api<CostsReply>('/api/costs', 'GET', undefined, m)
    .then((c) => { if (m === costsOf && c.days) { costs = c; readAt = Date.now() } }).catch(() => {})
    .finally(() => { if (loading === p) loading = null; changed() })
  return loading = p
}
function useCosts(force = false) {
  useStore()
  // Again when the machine changes; on web.codinger.app there is none until its list comes.
  const m = currentMachine()
  useEffect(() => { void load(force); const t = setInterval(() => void load(), 30 * 60_000); return () => clearInterval(t) }, [m])
  return costsOf === m ? costs : null
}

// The price Codinger works with, a month: the one you confirmed, else the list price of your plan.
function priceOf(c: CostsReply | null) {
  const p = state.settings.plan
  return p ? p.usd : c?.plan?.usd ?? null
}
const tierOf = (c: CostsReply | null) => c?.plan?.tier ?? state.settings.plan?.tier
const setPlan = (tier: string, usd: number, yearly = false) => void api('/api/settings', 'PUT', { plan: { tier, usd, yearly } })
const seen = (kind: 'week' | 'month', key: string) => void api('/api/settings', 'PUT', { reviewSeen: { [kind]: key } })

// The newest review you have not closed, if the record covers its time.
function dueReview(c: CostsReply): Period | null {
  const price = priceOf(c)
  if (price == null || !c.since) return null
  const m = lastMonth(), w = lastWeek()
  if (state.settings.reviewSeen?.month !== m && c.since <= `${m}-31`) return review('month', m, c, price, tierOf(c))
  if (state.settings.reviewSeen?.week !== w && c.since <= w) return review('week', w, c, price, tierOf(c))
  return null
}

export function CostBanner({ open }: { open(): void }) {
  const st = useStore()
  const c = useCosts()
  if (!c) return null
  const p = st.settings.plan, plan = c.plan
  if (plan && p?.tier !== plan.tier) return (
    <div className="cost-banner">
      <div className="cost-banner-text">
        {p ? <>Your plan changed to {plan.label}. Is the price now {money(plan.usd)} a month?</> : <>Your plan looks like {plan.label}, which costs {money(plan.usd)} a month. Is that right?</>}
      </div>
      <div className="cost-banner-actions">
        <button className="primary" onClick={() => setPlan(plan.tier, plan.usd)}>Yes</button>
        <button onClick={open}>No, change it</button>
      </div>
    </div>
  )
  if (!plan && !p) return null
  const r = dueReview(c)
  if (!r) return null
  return (
    <div className="cost-banner">
      <button className="icon-btn cost-banner-x" title="Close" onClick={() => seen(r.kind, r.key)}><XIcon size={11} /></button>
      <div className="cost-banner-title">Your {r.kind === 'week' ? 'weekly' : 'monthly'} review is here: {r.label}</div>
      <div className="cost-banner-text">{r.gist}</div>
      <div className="cost-banner-actions">
        <button onClick={() => { seen(r.kind, r.key); open() }}>Show the details</button>
      </div>
    </div>
  )
}

export function CostPanel() {
  const st = useStore()
  const c = useCosts(true)
  const [payView, setPayView] = useView('pay')
  const u = useUsage()
  const work = useMemo(() => dayTotals(u), [u])
  if (!c) return <div className="muted">Reading your usage…</div>
  const price = priceOf(c)
  const tier = tierOf(c)
  const rate = c.rate
  const weekCeil = rate?.sevenDay ? 1 / rate.sevenDay : null, fiveCeil = rate?.fiveHour ? 1 / rate.fiveHour : null

  // Reviews: every month and the last eight weeks the record covers, newest first.
  const months: string[] = [], weeks: string[] = []
  if (c.since && price != null) {
    for (let m = lastMonth(); m >= c.since.slice(0, 7); m = prevMonth(m)) months.push(m)
    for (let w = lastWeek(); w >= weekOf(c.since) && weeks.length < 8; w = prevWeek(w)) weeks.push(w)
  }
  const now = price == null ? [] : ([
    ['This week', weekOf(today())], ['This month', `${today().slice(0, 7)}-01`], ['The last 30 days', daysAgo(29)],
  ] as const).map(([label, from]) => {
    const t = totals(c, from, today()), cost = price * 12 / 365 * t.days
    return { label, ...t, cost }
  })
  // The graphs: dollars from the same record as the tables, tokens from the
  // ledger. Each day of the record, the last 90 at most.
  const payDays = c.since ? daysIn(c.since > daysAgo(89) ? c.since : daysAgo(89), today()) : []
  const itc = price != null && weekCeil ? price * 12 / 52 / weekCeil : null
  const tot = (d: string): Totals | undefined => { const w = work.get(d), x = c.days[d]; return w || x ? { usd: x?.usd ?? 0, tin: w?.tin ?? 0, tout: w?.tout ?? 0 } : undefined }

  return (
    <>
      <PriceForm c={c} />
      {c.extra && <div className="cost-line">
        <b>Extra usage:</b> {c.extra.enabled ? 'on' : `off${c.extra.reason === 'out_of_credits' ? ' (no credits)' : c.extra.reason ? ` (${c.extra.reason.replace(/_/g, ' ')})` : ''}`}.
        {' '}This month you spent {money(c.extra.used)}{c.extra.limit != null ? ` of your ${money(c.extra.limit)} limit` : ''} on it.
        {st.usage.overage && ' Claude Code uses extra usage now.'}
      </div>}

      {price != null && <div>
        <ChartHead title="What you pay for the work" view={payView} set={setPayView} />
        {payView === 'table' && <p className="muted cost-note">API work is what Claude Code used, at API prices. Your cost is your price over the same days.</p>}
        {payView === 'graph' ? <WorkChart id="pay" buckets={payDays.map((d) => ({ label: fmtDay(d), days: [d] }))} tot={tot} price={price} itc={itc} rolling />
        : <table className="mcp-table cost-table">
          <thead><tr><th></th><th>API work</th><th>Prompts</th><th>Your cost</th><th>For each API dollar</th><th>For each prompt</th><th>Utilization</th></tr></thead>
          <tbody>{now.map((r) => <tr key={r.label}>
            <td>{r.label}</td><td>{money(r.usd)}</td><td>{r.prompts}</td><td>{money(r.cost)}</td>
            <td>{r.usd ? cents(r.cost / r.usd) : '–'}</td><td>{r.prompts ? cents(r.cost / r.prompts) : '–'}</td><td>{itc != null && r.cost ? util(r.usd * itc / r.cost * 100) : '–'}</td>
          </tr>)}</tbody>
        </table>}
        {c.scanning && <p className="muted cost-note">Codinger is still reading your transcripts. The numbers will go up.</p>}
        {c.since && <p className="muted cost-note">The record starts on {fmtDay(c.since)}. Claude Code deletes transcripts after 30 days, so Codinger keeps its own record and a copy of the transcripts.</p>}
      </div>}

      <UsageAudit price={price} weekCeil={weekCeil} />

      <div>
        <h3 className="cost-h">At full utilization</h3>
        {weekCeil && price != null ? <>
          <p className="cost-line">
            A full week of your plan is about {money(weekCeil)} of API work{fiveCeil ? `, and a full 5-hour window about ${money(fiveCeil)}` : ''}.
            If you used all of it, each API dollar would cost you about {cents(price / (weekCeil * 52 / 12))}.
          </p>
          <p className="muted cost-note">Codinger estimates the limits from {rate?.pairs ?? 0} measurements of the last 3 days: it compares spend at API prices with how far the percentages move. The estimate gets better as you use Claude Code.</p>
        </> : <p className="muted cost-note">Codinger does not know your limits in dollars yet. It learns them as you use Claude Code.</p>}
      </div>

      {months.length > 0 && <Reviews title="Monthly reviews" ps={months.map((m) => review('month', m, c, price!, tier))} tier={tier} tot={tot} price={price} itc={itc} since={c.since} />}
      {weeks.length > 0 && <Reviews title="Weekly reviews" ps={weeks.map((w) => review('week', w, c, price!, tier))} tier={tier} tot={tot} price={price} itc={itc} since={c.since} />}

      <label className="settings-check">
        Show session costs as
        <select value={st.money} onChange={(e) => { state.money = e.target.value as typeof st.money; localStorage.setItem('codinger.money', JSON.stringify(state.money)); changed() }}>
          <option value="usd">dollars at API prices</option>
          <option value="pct">a share of the 5-hour limit</option>
          <option value="week">a share of the weekly limit</option>
        </select>
      </label>
    </>
  )
}

function PriceForm({ c }: { c: CostsReply }) {
  const st = useStore()
  const p = st.settings.plan
  const tier = c.plan?.tier ?? p?.tier ?? ''
  const [yearly, setYearly] = useState(!!p?.yearly)
  const [text, setText] = useState(() => p ? String(p.yearly ? +(p.usd * 12).toFixed(2) : p.usd) : c.plan ? String(c.plan.usd) : '')
  const n = Number(text)
  const usd = yearly ? n / 12 : n
  const dirty = text !== '' && Number.isFinite(n) && n >= 0 && (!p || p.tier !== tier || Math.abs(p.usd - usd) > 0.001 || !!p.yearly !== yearly)
  return (
    <div>
      <h3 className="cost-h">Your plan</h3>
      <p className="cost-line">
        {c.plan ? <>Claude Code is logged in to <b>{c.plan.label}</b>. Its list price is {money(c.plan.usd)} a month.</> : <>Codinger can not tell your plan from Claude Code's login. Type what you pay.</>}
      </p>
      <label className="settings-check cost-pay">
        You pay $
        <input className="cost-price" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && dirty) setPlan(tier, usd, yearly) }} />
        <select value={yearly ? 'year' : 'month'} onChange={(e) => setYearly(e.target.value === 'year')}>
          <option value="month">a month</option>
          <option value="year">a year</option>
        </select>
        <button className="primary" disabled={!dirty} onClick={() => setPlan(tier, usd, yearly)}>Save</button>
        {!p && <span className="muted">Not saved yet</span>}
      </label>
      <p className="muted cost-note">Max has no yearly price. Pro costs {money(PLANS[0].year!)} a year, which is about {money(PLANS[0].year! / 12)} a month. If you pay tax, include it in the price.</p>
    </div>
  )
}

// The reviews of one kind, newest first, and a graph of the work in them: by
// week for the weekly ones (with what each plan would have cost), by day for
// the monthly ones.
function Reviews({ title, ps, tier, tot, price, itc, since }: {
  title: string; ps: Period[]; tier: string | undefined; tot(d: string): Totals | undefined; price: number | null; itc: number | null; since: string | null
}) {
  const [view, setView] = useView(ps[0].kind)
  const weekly = ps[0].kind === 'week'
  const can = !weekly || ps.length > 1
  const v = can ? view : 'table'
  const old = [...ps].reverse()
  const buckets = weekly ? old.map((p) => ({ label: fmtDay(p.key), days: daysIn(p.from, p.to) })) : daysIn(old[0].from, ps[0].to).map((d) => ({ label: fmtDay(d), days: [d] }))
  const plans = weekly && ps.some((p) => p.fits.length) ? PLANS.map((pl, i) => ({
    key: pl.tier, label: pl.tier === tier ? `${pl.label} (your plan)` : pl.label, short: pl.label, bold: pl.tier === tier, color: SLOTS[i],
    values: old.map((p) => p.fits.find((f) => f.plan.tier === pl.tier)?.cost ?? null),
  })) : undefined
  return (
    <div>
      <ChartHead title={title} view={v} set={can ? setView : undefined} />
      {v === 'graph' && <WorkChart id={ps[0].kind} buckets={buckets} tot={tot} price={price} itc={itc} rolling={!weekly} plans={plans} />}
      {ps.map((p, i) => <Review key={p.key} p={p} tier={tier} open={i === 0} itc={itc} since={since} />)}
    </div>
  )
}

function Review({ p, tier, open, itc, since }: { p: Period; tier: string | undefined; open: boolean; itc: number | null; since: string | null }) {
  // Utilization over the days of the period that the record covers, at the plan cost of those days.
  const from = since && since > p.from ? since : p.from, to = p.to < today() ? p.to : today()
  const covered = from <= to ? daysIn(from, to).length : 0, all = daysIn(p.from, p.to).length
  const cost = p.planCost * covered / all
  const hits = (f: Period['fits'][number]) => f.weekHits + f.fiveHits
  return (
    <details className="cost-review" open={open}>
      <summary><b>{p.label}</b> <span className="muted">· {money(p.usd)} of API work · {p.prompts} prompts{p.perDollar != null ? ` · ${cents(p.perDollar)} for each API dollar` : ''}{itc != null && cost ? ` · ${util(p.usd * itc / cost * 100)} utilization` : ''}</span></summary>
      <p className="cost-line">{p.advice}</p>
      {p.overage && <p className="cost-line">Claude Code used extra usage in this time.</p>}
      {p.extraUsed != null && p.extraUsed > 0 && <p className="cost-line">You spent {money(p.extraUsed)} on extra usage this month.</p>}
      {p.fits.length > 0 && <table className="mcp-table cost-table">
        <thead><tr><th>Plan</th><th>Price</th><th>Times past its limits</th><th>Extra usage</th><th>Total</th></tr></thead>
        <tbody>{p.fits.map((f) => <tr key={f.plan.tier} className={f.plan.tier === tier ? 'cost-cur' : ''}>
          <td>{f.plan.label}</td><td>{money(f.cost - f.over)}</td><td>{hits(f) || '–'}</td><td>{f.over ? `about ${money(f.over)}` : '–'}</td><td>{money(f.cost)}</td>
        </tr>)}</tbody>
      </table>}
      {p.weekShare != null && <p className="muted cost-note">The busiest week used about {Math.round(p.weekShare * 100)}% of your weekly limit. {covered < all ? `The record has only ${covered} days of this time.` : ''}</p>}
    </details>
  )
}
