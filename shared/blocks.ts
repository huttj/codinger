// Sections Claude marks in its text, as XML tags on their own lines:
//
//   <answer> … </answer>                the direct answer; the UI marks it
//   <details title="…"> … </details>    supporting detail, shown closed
//   <consider title="…"> … </consider>  an item that wants the user's reply or dismissal;
//                                       with `done`, something to do, marked done when it is
//   <ask id="…"> … </ask>               a question: its text, then "- " lines as choices
//   <run title="…"> … </run>            a command for the user to run; the UI offers a button
//   <draft id="…" title="…"> … </draft> text for the user to edit and send back (a commit
//                                       message, an email); an item, answered like an <ask>
//   <review title="…"> … </review>      files the agent asks you to approve or reject, one
//                                       path on each line (the Files tab, web/src/review.ts)
//
//   <autopilot-stop reason="…"/>       Claude ends autopilot (server/autopilot.ts); not shown
//
// Markdown works inside, and sections nest. Lines inside code fences are left
// alone. A section still open at the end (a reply still streaming) holds what
// has arrived so far. The older forms still parse: ```ask fences (asks.ts), and
// `:::summary` / `:::more Title` / `:::consider Title` … `:::`.

import { parseAskBody, parseAsks, type Ask } from './asks.ts'

export type SectionKind = 'answer' | 'details' | 'consider' | 'ask' | 'run' | 'draft' | 'review'
export type Section = { kind: SectionKind; title: string; attrs: Record<string, string>; body: Segment[]; closed: boolean }
export type Segment = { text: string } | Section

const TAGS = 'answer|details|consider|ask|run|draft|review'
const OPEN = new RegExp(`^\\s*<(${TAGS})((?:\\s+[\\w-]+(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))?)*)\\s*>(.*)$`)
const CLOSE = new RegExp(`^(.*?)</(${TAGS})>\\s*$`)
const LEGACY = /^:::\s*(summary|more|consider)\b\s*(.*)$/
const STOP = /^\s*<autopilot-stop((?:\s+[\w-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>/]+))?)*)\s*\/?>\s*(?:<\/autopilot-stop>\s*)?$/
const LEGACY_KIND: Record<string, SectionKind> = { summary: 'answer', more: 'details', consider: 'consider' }

function attrsOf(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of s.matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) out[m[1]] = m[2] ?? m[3] ?? m[4] ?? ''
  return out
}

export function segmentsOf(text: string): Segment[] {
  const root: Segment[] = []
  const stack: { body: Segment[]; sec?: Section; legacy?: boolean }[] = [{ body: root }]
  let buf: string[] = []
  let fence = ''
  const top = () => stack.at(-1)!
  const flush = () => { if (buf.length) top().body.push({ text: buf.join('\n') }); buf = [] }
  const open = (kind: SectionKind, attrs: Record<string, string>, legacy = false) => {
    flush()
    const sec: Section = { kind, title: attrs.title ?? '', attrs, body: [], closed: false }
    top().body.push(sec)
    stack.push({ body: sec.body, sec, legacy })
  }
  const close = () => { flush(); const s = stack.pop()!; s.sec!.closed = true }
  for (const line of text.split('\n')) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (f && (!fence || (f[0] === fence[0] && f.length >= fence.length && !line.trim().slice(f.length)))) {
      fence = fence ? '' : f
      buf.push(line)
      continue
    }
    if (fence) { buf.push(line); continue }
    let m: RegExpExecArray | null
    if (STOP.test(line)) continue
    if ((m = OPEN.exec(line))) {
      open(m[1] as SectionKind, attrsOf(m[2]))
      let rest = m[3]
      const c = CLOSE.exec(rest)
      if (c && c[2] === m[1]) { if (c[1].trim()) buf.push(c[1]); close(); continue }
      if (rest.trim()) buf.push(rest)
    } else if ((m = CLOSE.exec(line)) && stack.length > 1 && top().sec!.kind === m[2]) {
      if (m[1].trim()) buf.push(m[1])
      close()
    } else if ((m = LEGACY.exec(line))) {
      open(LEGACY_KIND[m[1]], { title: m[2].trim() }, true)
    } else if (/^:::\s*$/.test(line) && stack.length > 1 && top().legacy) {
      close()
    } else buf.push(line)
  }
  flush()
  // <details> written the HTML way: a <summary> line gives the title.
  const fix = (segs: Segment[]) => {
    for (const s of segs) {
      if ('text' in s) continue
      const first = s.body[0]
      if (s.kind === 'details' && !s.title && first && 'text' in first) {
        const t = /^\s*<summary>(.*?)<\/summary>\s*\n?/.exec(first.text)
        if (t) { s.title = t[1].trim(); first.text = first.text.slice(t[0].length) }
      }
      fix(s.body)
    }
  }
  fix(root)
  return root
}

// Claude's reason to end autopilot, when the text has an <autopilot-stop> line
// outside code fences ('' without a reason); null when it has none.
export function autopilotStop(text: string): string | null {
  let fence = ''
  for (const line of text.split('\n')) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (f && (!fence || (f[0] === fence[0] && f.length >= fence.length && !line.trim().slice(f.length)))) { fence = fence ? '' : f; continue }
    const m = fence ? null : STOP.exec(line)
    if (m) return attrsOf(m[1]).reason?.trim() ?? ''
  }
  return null
}

// An <ask> section as an Ask. `index` counts the asks before it in the message.
export function askOf(sec: Section, index: number): Ask {
  const body = sec.body.map((s) => ('text' in s ? s.text : '')).join('\n')
  return parseAskBody(sec.attrs.id ? `id=${sec.attrs.id}` : '', body, index)
}

// A <draft> section as an Ask: the title is the question, the body the text to edit.
// `index` counts the drafts before it in the message (they number d1, d2…).
export function draftOf(sec: Section, index: number): Ask {
  const body = sec.body.map((s) => ('text' in s ? s.text : '')).join('\n').replace(/^\n+|\s+$/g, '')
  const id = /^[\w.-]+$/.test(sec.attrs.id ?? '') ? sec.attrs.id : `d${index + 1}`
  return { id, question: sec.title || 'Draft', options: [], draft: body }
}

// The command in a <run> section, without a code fence around it.
export function commandOf(sec: Section): string {
  const body = sec.body.map((s) => ('text' in s ? s.text : '')).join('\n').trim()
  return (/^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1\s*$/.exec(body)?.[2] ?? body).trim()
}

// A <review> section holds the agent's text (what changed, its state, what to test, what it needs from
// you) and its files: each line that is only a path (maybe in a list, in backticks, with :line).
const PATH_LINE = /^\s*(?:[-*+]\s+)?`?([^\s`]+?)`?(?::\d+(?:[-:]\d+)?)?\s*$/
const isPath = (p: string) => /[\\/]/.test(p) || /\.[A-Za-z0-9]{1,8}$/.test(p)
const bodyOf = (sec: Section) => sec.body.map((s) => ('text' in s ? s.text : '')).join('\n')

export function reviewFilesOf(sec: Section): string[] {
  const out: string[] = []
  for (const line of bodyOf(sec).split('\n')) {
    const p = PATH_LINE.exec(line)?.[1]
    if (p && isPath(p) && !out.includes(p)) out.push(p)
  }
  return out
}

// The text of a <review> section without its lines of paths. Each line of it is a paragraph of its
// own (the agent writes them one under the other), outside code blocks and lists.
const paragraphs = (t: string) => t.split(/(^```[\s\S]*?^```)/m).map((x, i) => i % 2 ? x : x.replace(/([^\n])\n(?![\n\s]|[-*+] |[>#|]|\d+\. )/g, '$1\n\n')).join('')
export const reviewTextOf = (sec: Section): string =>
  paragraphs(bodyOf(sec).split('\n').filter((l) => { const p = PATH_LINE.exec(l)?.[1]; return !(p && isPath(p)) }).join('\n').replace(/^\s+|\s+$/g, ''))

// The <review> sections of a message, in order.
export function reviewsOf(text: string): { title: string; text: string; files: string[] }[] {
  const out: { title: string; text: string; files: string[] }[] = []
  const walk = (segs: Segment[]) => { for (const s of segs) if (!('text' in s)) { if (s.kind === 'review') out.push({ title: s.title, text: reviewTextOf(s), files: reviewFilesOf(s) }); else walk(s.body) } }
  walk(segmentsOf(text))
  return out
}

// Things in a message that want a response: questions and items to consider.
// Ids match what the UI renders: asks by their id (or q1, q2…), items c1, c2…
// done: the item is something to do, so it can be marked done (`done`, or it holds a <run>).
// critical: the agent marked the item a big deal (`critical`), shown in red.
// parent: the item to consider it sits in, if any.
// A <review> is an item too (r1, r2…): it waits for your decision (web/src/review.ts).
// again: the key of the earlier item that this one raises again (raiseItems).
export type Item = ({ kind: 'ask'; id: string; label: string; ask: Ask } | { kind: 'consider'; id: string; label: string; done: boolean; critical: boolean } | { kind: 'review'; id: string; label: string }) & { parent?: string; again?: string }

export const isCritical = (sec: Section): boolean => 'critical' in sec.attrs

export const isTask = (sec: Section): boolean => 'done' in sec.attrs || sec.body.some((s) => !('text' in s) && (s.kind === 'run' || isTask(s)))

export const itemsOf = (text: string): Item[] => walkItems(text).map((x) => x.item)

// Each item with its section (none for an ask in the older ```ask form).
function walkItems(text: string): { item: Item; sec?: Section }[] {
  const out: { item: Item; sec?: Section }[] = []
  let asks = 0, considers = 0, drafts = 0, reviews = 0
  const walk = (segs: Segment[], parent?: string) => {
    const under = parent ? { parent } : {}
    for (const s of segs) {
      if ('text' in s) {
        const found = parseAsks(s.text, asks)
        asks += found.length
        for (const a of found) out.push({ item: { kind: 'ask', id: a.id, label: a.question.split('\n')[0], ask: a, ...under } })
        continue
      }
      const again = s.attrs.again ? { again: s.attrs.again } : {}
      if (s.kind === 'ask' || s.kind === 'draft') {
        const a = s.kind === 'ask' ? askOf(s, asks++) : draftOf(s, drafts++)
        out.push({ item: { kind: 'ask', id: a.id, label: a.question.split('\n')[0], ask: a, ...under, ...again }, sec: s })
      } else if (s.kind === 'consider') {
        const id = `c${++considers}`
        out.push({ item: { kind: 'consider', id, label: s.title || 'Item', done: isTask(s), critical: isCritical(s), ...under, ...again }, sec: s })
        walk(s.body, id)
      } else if (s.kind === 'review') {
        out.push({ item: { kind: 'review', id: `r${++reviews}`, label: s.title || 'Review', ...under, ...again }, sec: s })
      } else walk(s.body, parent)
    }
  }
  walk(segmentsOf(text))
  return out
}

// The text Claude receives for items the user marked done.
export function formatDone(items: { key: string; label: string; text?: string; result?: string }[]): string {
  const one = (i: (typeof items)[number]) => `\`${i.key.split(':').pop()}\` (${i.label.slice(0, 120)})${i.text?.trim() ? `, with a problem: ${i.text.trim()}` : ''}`
  const results = items.filter((i) => i.result).map((i) => `\n\nResult for \`${i.key.split(':').pop()}\`:\n\`\`\`\n${i.result}\n\`\`\``).join('')
  return `**Marked done:** ${items.map(one).join('; ')}${results}`
}

// The text Claude receives for items the user saw and set aside with Dismiss. Full keys, so it can
// raise one again (<raise item="…"/>, raiseItems).
const listed = (items: { key: string; label: string }[]) => items.map((i) => `\`${i.key}\` (${i.label.slice(0, 120)})`).join('; ')
export function formatDismissed(items: { key: string; label: string }[]): string {
  return `**Dismissed, no reply:** ${listed(items)}`
}

// The text Claude receives for items still open when the user sent the message: not set aside.
export function formatPending(items: { key: string; label: string }[]): string {
  return `**Left open, no reply yet:** ${listed(items)}`
}

// An item of an earlier message, as the markup it had, with again="<key>" on it.
function sectionText(s: Section): string {
  const attrs = Object.entries(s.attrs).map(([k, v]) => ` ${k}=${v.includes('"') ? `'${v.replace(/'/g, '’')}'` : `"${v}"`}`).join('')
  return `<${s.kind}${attrs}>\n${s.body.map((b) => 'text' in b ? b.text : sectionText(b)).join('\n')}\n</${s.kind}>`
}
export function itemSource(text: string, id: string, key: string): string | null {
  const hit = walkItems(text).find((x) => x.item.id === id)
  if (!hit) return null
  if (hit.sec) return sectionText({ ...hit.sec, attrs: { ...hit.sec.attrs, again: key } })
  // An ask in the older ```ask form: its text as an <ask>.
  const a = hit.item.kind === 'ask' ? hit.item.ask : null
  return a ? `<ask id="${a.id}" again="${key}">\n${a.question}\n${a.options.map((o) => `- ${o}`).join('\n')}\n</ask>` : null
}

// <raise item="<msg>:<id>"/> on a line of its own (outside code fences) shows an item of an earlier
// message again: the server puts the item's markup in its place (server/session.ts). The key can be
// only the id too (the id of an <ask>, or c1): then the newest earlier item with that id.
// find gives the text of a message by its "<seq>.<block>"; recent gives the messages, newest first.
// For a key it cannot find, the line says so.
const RAISE = /^\s*<raise\s+item\s*=\s*["']?([\w.:-]+)["']?\s*\/?>\s*(?:<\/raise>\s*)?$/
export function raiseItems(text: string, find: (msg: string) => string | undefined, recent: () => Iterable<{ msg: string; text: string }>): string {
  if (!text.includes('<raise')) return text
  const source = (ref: string): string | null => {
    const at = ref.indexOf(':')
    if (at > 0) { const src = find(ref.slice(0, at)); return src == null ? null : itemSource(src, ref.slice(at + 1), ref) }
    for (const m of recent()) if (m.text.includes(ref)) { const out = itemSource(m.text, ref, `${m.msg}:${ref}`); if (out) return out }
    return null
  }
  let fence = ''
  return text.split('\n').map((line) => {
    const f = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (f && (!fence || (f[0] === fence[0] && f.length >= fence.length && !line.trim().slice(f.length)))) { fence = fence ? '' : f; return line }
    const m = fence ? null : RAISE.exec(line)
    return !m ? line : source(m[1]) ?? `*(Codinger found no item \`${m[1]}\` to raise again.)*`
  }).join('\n')
}
