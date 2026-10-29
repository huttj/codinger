// Each session's critter as a small PNG data URL, for its push notifications. The page draws it
// (web/src/critterIcon.tsx) and sends it here; ~/.codinger/icons/<session>.txt keeps it.

import fs from 'node:fs'
import path from 'node:path'
import { DATA } from './store.ts'

const DIR = path.join(DATA, 'icons')
const MAX = 2600
const cache = new Map<string, string | null>()
const file = (sid: string) => path.join(DIR, `${sid.replace(/[^\w-]/g, '')}.txt`)

export function setIcon(sid: string, png: string): boolean {
  if (!png.startsWith('data:image/png;base64,') || png.length > MAX) return false
  if (cache.get(sid) === png) return true
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(file(sid), png)
  cache.set(sid, png)
  return true
}

export function iconOf(sid: string): string | undefined {
  if (!cache.has(sid)) { try { cache.set(sid, fs.readFileSync(file(sid), 'utf8')) } catch { cache.set(sid, null) } }
  return cache.get(sid) ?? undefined
}

export function forgetIcon(sid: string) {
  cache.delete(sid)
  fs.rmSync(file(sid), { force: true })
}
