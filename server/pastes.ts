// A paste too long to send in a message (a whole chat log, a big export) would fill
// Claude's context, or go past its limit so the message fails. Such a paste goes to a
// file in .codinger/pastes in the session's folder (kept out of git), and Claude gets a
// note with the file's path and the paste's start. The transcript keeps the whole paste,
// so the field shows it as before, also after the file is deleted.

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DATA } from './store.ts'

// For a session folder that Codinger cannot write to. Each session can read it (--add-dir).
export const PASTES = path.join(DATA, 'pastes')

// About 10,000 tokens: longer than that goes to a file.
const MAX_INLINE = 40_000
// The start of the paste that the note shows, so Claude knows what the file holds.
const HEAD = 1_000

function pasteDir(cwd: string): string {
  const dir = path.join(cwd, '.codinger', 'pastes')
  try {
    fs.mkdirSync(dir, { recursive: true })
    const ignore = path.join(dir, '.gitignore')
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n')
    return dir
  } catch {
    fs.mkdirSync(PASTES, { recursive: true })
    return PASTES
  }
}

export function pasteForClaude(text: string, cwd: string): string {
  if (text.length <= MAX_INLINE) return text
  const file = path.join(pasteDir(cwd), `${createHash('sha256').update(text).digest('hex').slice(0, 24)}.txt`)
  if (!fs.existsSync(file)) fs.writeFileSync(file, text)
  const lines = text.split('\n').length
  const head = text.slice(0, HEAD)
  return `[Pasted text: ${lines.toLocaleString('en-US')} lines, ${text.length.toLocaleString('en-US')} characters (about ${Math.round(text.length / 4).toLocaleString('en-US')} tokens). ` +
    `It is too long to put in this message, so Codinger saved it to a file: ${file}\n` +
    `Read the parts you need, or search it (Grep, or a subagent for a summary). Do not read the whole file into your context at once. It starts:]\n` +
    `${head}${text.length > HEAD ? '\n[…]' : ''}`
}
