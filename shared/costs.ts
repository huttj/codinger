// What your plan costs you, set against the work it buys. The server keeps a
// day-by-day record of spend at API prices (server/costs.ts); this works out,
// from that record and the price you pay, what a dollar of API work and a
// prompt cost you, the least they could cost at full use, and how each plan
// would have done with your usage: the weekly and monthly reviews.
//
// The limits of a plan are not in dollars. The usage meter (server/meter.ts)
// learns how much of your limits a dollar of API work uses; the other plans'
// limits follow from theirs being a fixed multiple of Pro's.

import type { Usage } from './types.ts'

// One local day: spend at API prices (total, by model, by hour), prompts you
// sent, and the highest share of each limit Claude Code reported that day.
export type CostDay = {
  usd: number; prompts: number; models: Record<string, number>; hours: number[]
  five?: number; seven?: number; overage?: boolean
}
// Extra usage as claude.ai reports it, in dollars, for the month it was read in.
export type Extra = { at: number; month: string; enabled: boolean; used: number; limit: number | null; reason: string | null }
export type Plan = { tier: string; label: string; usd: number; mult: number; year?: number }
export type CostsReply = {
  plan: Plan | null; days: Record<string, CostDay>; rate: Usage['rate']; extra: Extra | null; extraMonths: Record<string, number>
  scanning: boolean; since: string | null
  // The other machines whose days are in days (their synced ledgers, server/usage.ts), and when each copy was read.
  others?: { machine: string; label?: string; at: number | null }[]
}

// List prices in US dollars a month (year: paid yearly, if the plan can be), as of
// October 2026. mult: the plan's limits as a multiple of Pro's.
export const PLANS: Plan[] = [
  { tier: 'pro', label: 'Pro', usd: 20, mult: 1, year: 200 },
  { tier: 'max5', label: 'Max 5x', usd: 100, mult: 5 },
  { tier: 'max20', label: 'Max 20x', usd: 200, mult: 20 },
]
export const planOf = (tier: string | undefined) => PLANS.find((p) => p.tier === tier) ?? null

const DAY = 86_400_000
export const dayKey = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const parse = (k: string) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d).getTime() }
export const addDays = (k: string, n: number) => dayKey(parse(k) + n * DAY + 12 * 3_600_000)   // noon: a DST change can't skip a day
// The Monday on or before a day.
export const weekOf = (k: string) => addDays(k, -((new Date(parse(k)).getDay() + 6) % 7))
export const daysIn = (from: string, to: string) => { const out: string[] = []; for (let k = from; k <= to; k = addDays(k, 1)) out.push(k); return out }

export type Fit = { plan: Plan; weekHits: number; fiveHits: number; over: number; cost: number }
export type Period = {
  kind: 'week' | 'month'; key: string; from: string; to: string; label: string
  usd: number; prompts: number; planCost: number; perDollar: number | null; perPrompt: number | null
  models: Record<string, number>; seven?: number; five?: number; overage: boolean; extraUsed?: number
  weekShare: number | null    // the share of your weekly limit the busiest week used
  fits: Fit[]; advice: string; gist: string; days: number
}

// What a period cost and how each plan would have done. price: what you pay a month.
export function review(kind: 'week' | 'month', key: string, c: CostsReply, price: number, tier: string | undefined): Period {
  const from = kind === 'week' ? key : `${key}-01`
  const to = kind === 'week' ? addDays(key, 6) : addDays(dayKey(new Date(+key.slice(0, 4), +key.slice(5, 7), 1).getTime()), -1)
  const ks = daysIn(from, to)
  const ds = ks.map((k) => c.days[k]).filter(Boolean) as CostDay[]
  const sum = (f: (d: CostDay) => number) => ds.reduce((s, d) => s + f(d), 0)
  const usd = sum((d) => d.usd), prompts = sum((d) => d.prompts)
  const models: Record<string, number> = {}
  for (const d of ds) for (const m in d.models) models[m] = (models[m] ?? 0) + d.models[m]
  const planCost = kind === 'week' ? price * 12 / 52 : price
  const peak = (f: 'five' | 'seven') => ds.reduce<number | undefined>((m, d) => d[f] == null ? m : Math.max(m ?? 0, d[f]!), undefined)
  const cur = planOf(tier)

  // Each week the period touches (a whole Monday-to-Sunday week), and the
  // spend of each 5-hour stretch, from the hourly record.
  const weeks = [...new Set(ks.map(weekOf))].map((w) => daysIn(w, addDays(w, 6)).reduce((s, k) => s + (c.days[k]?.usd ?? 0), 0))
  const hours = daysIn(addDays(from, -1), to).flatMap((k) => c.days[k]?.hours ?? Array(24).fill(0))
  const weekCeil = c.rate?.sevenDay ? 1 / c.rate.sevenDay : null, fiveCeil = c.rate?.fiveHour ? 1 / c.rate.fiveHour : null
  const weekShare = weekCeil ? Math.max(0, ...weeks) / weekCeil : peak('seven') ?? null

  // With neither, nothing says how far your limits go.
  const fits: Fit[] = cur && (weekCeil || weekShare != null) ? PLANS.map((plan) => {
    const k = plan.mult / cur.mult
    let weekHits = 0, fiveHits = 0, over = 0
    // Without a dollar value for the limit, the highest weekly share reported tells only whether it fit.
    if (weekCeil) { for (const w of weeks) if (w > weekCeil * k) { weekHits++; over += w - weekCeil * k } }
    else if (weekShare != null && weekShare > k) weekHits = 1
    if (fiveCeil) for (let h = 24; h < hours.length; h++) {
      let s = 0
      for (let j = h; j < h + 5 && j < hours.length; j++) s += hours[j]
      if (s > fiveCeil * k) { fiveHits++; over += s - fiveCeil * k; h += 4 }
    }
    // Your own plan at what you pay; the others at their list prices.
    return { plan, weekHits, fiveHits, over, cost: (plan.tier === cur.tier ? planCost : kind === 'week' ? plan.usd * 12 / 52 : plan.usd) + over }
  }) : []

  const label = kind === 'week' ? `Week of ${fmtDay(from)}` : new Date(parse(from)).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  const p: Period = {
    kind, key, from, to, label, usd, prompts, planCost, models, days: ds.length,
    perDollar: usd ? planCost / usd : null, perPrompt: prompts ? planCost / prompts : null,
    seven: peak('seven'), five: peak('five'), overage: ds.some((d) => d.overage), extraUsed: kind === 'month' ? c.extraMonths[key] : undefined,
    weekShare, fits, advice: '', gist: '',
  }
  p.advice = adviceOf(p, cur)
  p.gist = `${money(usd)} of API work for ${money(planCost)} of plan`
    + (p.perDollar != null ? ` (${cents(p.perDollar)} for each API dollar)` : '') + `. ${p.advice}`
  return p
}

// Which plan would have cost you least, with what it would have cost in extra usage.
function adviceOf(p: Period, cur: Plan | null): string {
  if (!cur) return ''
  if (!p.fits.length) return 'Codinger does not know how far your limits go yet, so it can not compare the plans.'
  if (!p.usd) return 'You used no Claude Code in this time.'
  const best = [...p.fits].sort((a, b) => a.cost - b.cost || b.plan.mult - a.plan.mult)[0]
  const mine = p.fits.find((f) => f.plan.tier === cur.tier)!
  const hits = (f: Fit) => f.weekHits + f.fiveHits
  const times = (n: number) => `${n} ${n === 1 ? 'time' : 'times'}`
  if (best.plan.tier === cur.tier) return hits(mine)
    ? `${cur.label} is right for you: you went past its limits ${times(hits(mine))}.`
    : `${cur.label} is right for you.`
  const saves = `${best.plan.label} would have saved you about ${money(mine.cost - best.cost)}`
  if (best.plan.mult > cur.mult) return `${saves}: you went past the limits of ${cur.label} ${times(hits(mine))}.`
  return hits(best)
    ? `${saves}, with ${times(hits(best))} past its limits (about ${money(best.over)} of extra usage).`
    : `${saves}, and you would not have gone past its limits.`
}

// The most recent whole week and month the record covers.
export function lastWeek(now = Date.now()) { return addDays(weekOf(dayKey(now)), -7) }
export function lastMonth(now = Date.now()) { const d = new Date(now); d.setDate(0); return dayKey(d.getTime()).slice(0, 7) }
export const prevWeek = (k: string) => addDays(k, -7)
export const prevMonth = (k: string) => { const d = new Date(+k.slice(0, 4), +k.slice(5, 7) - 1, 0); return dayKey(d.getTime()).slice(0, 7) }

// Totals over any run of days, for the "now" figures: this week, this month, the last 30 days.
export function totals(c: CostsReply, from: string, to: string) {
  const ds = daysIn(from, to).map((k) => c.days[k]).filter(Boolean) as CostDay[]
  return { usd: ds.reduce((s, d) => s + d.usd, 0), prompts: ds.reduce((s, d) => s + d.prompts, 0), days: daysIn(from, to).length }
}
export const today = () => dayKey(Date.now())
export const daysAgo = (n: number) => addDays(dayKey(Date.now()), -n)

export function fmtDay(k: string) { return new Date(parse(k)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }
export function money(x: number) { return x >= 100 ? `$${Math.round(x).toLocaleString()}` : `$${x.toFixed(2)}` }
export function cents(x: number) { return x < 1 ? `${+(x * 100).toPrecision(2)}¢` : money(x) }
