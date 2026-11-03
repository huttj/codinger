// Messages between sessions (server/mail.ts): the text Claude receives for one.

import type { Part } from './types.ts'

type MailPart = Extract<Part, { kind: 'mail' }>

// Messages in a row from one sender, with no word from you in either session, before one waits for your OK.
export const MAX_RUN = 20

export function formatMail(p: MailPart): string {
  const who = `session \`${p.from}\` ("${p.title}"${p.relation ? `, your ${p.relation}` : ''})`
  if (p.idle) return `[Codinger] Your child ${who} ended its turn and is idle.${p.text ? ` ${p.text}` : ''}`
  if (p.decided) return `[Codinger] ${p.text}`
  const head = p.replyTo
    ? `Reply \`${p.id}\` from ${who} to your message \`${p.replyTo.id}\` ("${p.replyTo.text}")`
    : `Message \`${p.id}\` from ${who}`
  // A child's last word before it ended its turn: one message, not a message and an idle note.
  return `[${head}${p.endTurn ? '. It then ended its turn and is idle' : ''}]\n${p.text}`
}

// The start of a message, to quote it in a reply.
export const excerpt = (text: string, n = 120) => {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}
