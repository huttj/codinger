// A long text pasted into a field sits in the message, where it was pasted, as a fence of
// backticks named "paste", one backtick longer than any run of backticks in the
// text, so nothing in it can close the fence early. Fields and sent messages show
// it as one pill that opens the whole text; Claude gets the text as it was pasted.

const TOKEN = /(`{3,})paste\n([\s\S]*?)\n\1/g

const fence = (text: string) => '`'.repeat(Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length)) + 1)

// Each paste in the text: where its token starts and ends, and its text. A
// backtick typed on both sides of a pill looks like part of a longer fence; the
// fence of a paste has the length that its text gives, so the rest is text.
function* pastes(text: string) {
  for (const m of text.matchAll(TOKEN)) {
    const extra = Math.max(0, m[1].length - fence(m[2]).length)
    yield { start: m.index! + extra, end: m.index! + m[0].length - extra, body: m[2] }
  }
}

// A paste longer than this (about 10,000 tokens) goes into the session's folder as a file in
// .codinger/pastes, and the message names the file as it names an attached file. Claude then
// reads only the parts it needs, and the message shows what Claude got.
export const isFilePaste = (text: string) => text.length > 40_000

// A paste this long or longer becomes a pill.
export const isLongPaste = (text: string) => text.length >= 1500 || text.split('\n').length > 20

export function pasteToken(text: string): string {
  const f = fence(text)
  return `${f}paste\n${text}\n${f}`
}

// The text cut into runs of text and pastes, in order.
export function splitPastes(text: string): ({ text: string } | { paste: string })[] {
  const out: ({ text: string } | { paste: string })[] = []
  let last = 0
  for (const p of pastes(text)) {
    if (p.start > last) out.push({ text: text.slice(last, p.start) })
    out.push({ paste: p.body })
    last = p.end
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

// For places that show text only.
export const withoutPastes = (text: string) => splitPastes(text).map((c) => 'paste' in c ? `[${pasteLabel(c.paste)}]` : c.text).join('')

export function pasteLabel(text: string): string {
  const lines = text.split('\n').length
  return lines > 1 ? `Pasted text · ${lines.toLocaleString()} lines` : `Pasted text · ${text.length.toLocaleString()} characters`
}
