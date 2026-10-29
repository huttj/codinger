// Each session's critter as a small PNG, for the push notifications of that session: the page
// draws it and sends it to the session's machine, which adds it to each push (server/icons.ts).
// Chrome shows it; an iPhone shows the app's icon in its place.

import { useEffect } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SessionMeta } from '../../shared/types.ts'
import { Mascot } from './components/Mascot.tsx'
import { localId, machineOf, state, urlOf } from './store.ts'

const MAX = 2600  // characters of the data URL, so the push stays under the 4 KB that push services take

function png(meta: SessionMeta, size: number): Promise<string> {
  const svg = renderToStaticMarkup(<Mascot status="idle" fatigue={0} alert="idle" look={meta.look} size={size} />)
    .replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"')
    .replace(/viewBox="[^"]*"/, 'viewBox="0 -5 18 18"')
    .replace(/height="[^"]*"/, `height="${size}"`)
    .replace(/width="[^"]*"/, `width="${size}"`)
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = c.height = size
      const g = c.getContext('2d')!
      g.imageSmoothingEnabled = false
      g.drawImage(img, 0, 0, size, size)
      resolve(c.toDataURL('image/png'))
    }
    img.onerror = reject
    img.src = 'data:image/svg+xml,' + encodeURIComponent(svg)
  })
}

// What this page sent: a session's look changes its icon.
const sent = new Map<string, string>()

export function useCritterIcons(sessions: SessionMeta[]) {
  const connected = Object.values(state.machines).filter((m) => m.connected).map((m) => m.name).join('|')
  const key = sessions.filter((s) => s.kind === 'worker' && !s.archived).map((s) => `${s.id}=${JSON.stringify(s.look ?? {})}`).join('|')
  useEffect(() => {
    for (const s of sessions) {
      if (s.kind !== 'worker' || s.archived) continue
      // A machine that is off keeps its sessions in the sidebar: send its icons when it is back.
      const machine = machineOf(s.id)
      if (!state.machines[machine]?.connected) continue
      const look = JSON.stringify(s.look ?? {})
      if (sent.get(s.id) === look) continue
      sent.set(s.id, look)
      void (async () => {
        let url = await png(s, 64)
        if (url.length > MAX) url = await png(s, 40)
        if (url.length > MAX) return
        // No toast when it fails: a server older than this page has no icon route, and a push
        // without the icon still works.
        const r = await fetch(urlOf(`/api/sessions/${localId(s.id)}/icon`, machine), {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ png: url }),
        })
        if (!r.ok) sent.delete(s.id)
      })().catch(() => sent.delete(s.id))
    }
  }, [key, connected])
}
