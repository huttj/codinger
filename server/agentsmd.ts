// The user's global AGENTS.md: instructions for every Codinger session, workers
// and lead alike. It is read each time a claude process starts, so an edit
// reaches a session the next time it wakes (sessions sleep when idle).

import fs from 'node:fs'
import path from 'node:path'
import { DATA } from './store.ts'

export const AGENTS_FILE = path.join(DATA, 'AGENTS.md')

const DEFAULT = `# AGENTS.md

These instructions apply to every Codinger session.

## Write in ASD-STE100 Simplified Technical English

Write all text for the user in ASD-STE100. Code, code comments and commit messages follow
the conventions of the repository.

- Use one word for one meaning. Use the same term for the same thing each time.
- Use simple, common words: "use", not "utilize"; "start", not "initiate"; "show", not "indicate".
- Write instructions in sentences of 20 words or fewer. Write descriptions in sentences of
  25 words or fewer.
- Write one instruction in each sentence. Use the imperative ("Run the tests.").
- Use the active voice. Use the passive voice only when you do not know who does the action.
- Use the simple tenses: present, past and future.
- For an action that you are about to do, use "I will" or "Let me": "I will deploy the relay
  now", "Let me read the tracking code". Never use the present tense for it: "I deploy the
  relay now" and "I read the tracking code" are wrong English. This rule is stronger than the
  STE preference for the present tense. Use the present tense only for facts and for what is
  true now.
- Do not use "-ing" words as nouns or adjectives.
- Do not use more than three nouns in a cluster. Write "the speed of the build cache", not
  "the build cache speed setting".
- Do not leave out "a", "an" and "the" to make a sentence shorter.
- Write paragraphs of six sentences or fewer, with one topic in each paragraph.
- Use a vertical list for steps and for three or more items.
- Do not use slang or idioms.
- Keep technical names exact: commands, file names, identifiers, product names.
`

export function readAgentsMd(): string {
  try { return fs.readFileSync(AGENTS_FILE, 'utf8') } catch { /* first run */ }
  fs.mkdirSync(DATA, { recursive: true })
  fs.writeFileSync(AGENTS_FILE, DEFAULT)
  return DEFAULT
}

export function writeAgentsMd(text: string) {
  fs.mkdirSync(DATA, { recursive: true })
  fs.writeFileSync(AGENTS_FILE, text)
}

// What goes after Codinger's own prompt.
export function agentsPrompt(): string {
  const text = readAgentsMd().trim()
  return text ? `\n\n# The user's instructions (${AGENTS_FILE})\n\n${text}\n` : ''
}
