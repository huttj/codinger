// The model families a session can run and the versions of each, newest first.
// An alias (opus, sonnet...) runs the version Claude Code picks for it; a full
// ID runs that version. Add a version here when Anthropic releases one.

export const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'] as const

export const VERSIONS: Record<string, { id: string; version: string }[]> = {
  opus: [
    { id: 'claude-opus-5-5', version: '5.5' },
    { id: 'claude-opus-5', version: '5' },
    { id: 'claude-opus-4-8', version: '4.8' },
    { id: 'claude-opus-4-7', version: '4.7' },
    { id: 'claude-opus-4-6', version: '4.6' },
  ],
  sonnet: [
    { id: 'claude-sonnet-5-5', version: '5.5' },
    { id: 'claude-sonnet-5', version: '5' },
    { id: 'claude-sonnet-4-6', version: '4.6' },
  ],
  haiku: [
    { id: 'claude-haiku-5-5', version: '5.5' },
    { id: 'claude-haiku-4-5', version: '4.5' },
  ],
  fable: [
    { id: 'claude-fable-5-1', version: '5.1' },
    { id: 'claude-fable-5', version: '5' },
  ],
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1)

// claude-opus-4-8 → { family: 'opus', version: '4.8' }; an alias → its family, no version.
export function parseModel(model: string): { family: string; version: string | null } {
  if (!model.includes('-')) return { family: model, version: null }
  const m = /^claude-([a-z]+)-(\d+(?:-\d+)?)/.exec(model)
  return m ? { family: m[1], version: m[2].replace('-', '.') } : { family: model, version: null }
}

// "Opus 4.8", or "Opus" for an alias.
export function modelLabel(model: string): string {
  const { family, version } = parseModel(model)
  return version ? `${cap(family)} ${version}` : cap(family)
}
