// How much you use each reaction emoji: a score that each use adds 1 to and that halves each
// two weeks: 2 uses today weigh about as much as 10 uses a month ago.
// s: the score at time t (ms); t: the last use.

export type EmojiUse = Record<string, { s: number; t: number }>

const HALF_LIFE = 14 * 24 * 3600e3

export const emojiScore = (u: { s: number; t: number }, now = Date.now()) => u.s * 2 ** (-(now - u.t) / HALF_LIFE)

// A copy of `use` with one more use of `e`, less the emoji whose score fell to almost nothing.
export function bumpEmoji(use: EmojiUse, e: string, now = Date.now()): EmojiUse {
  const out: EmojiUse = {}
  for (const [k, u] of Object.entries(use)) if (k !== e && emojiScore(u, now) >= 0.05) out[k] = u
  out[e] = { s: (use[e] ? emojiScore(use[e], now) : 0) + 1, t: now }
  return out
}

// Only entries of the right shape, from a request or an old file.
export function cleanEmojiUse(v: unknown): EmojiUse {
  const out: EmojiUse = {}
  if (v && typeof v === 'object') for (const [k, u] of Object.entries(v as Record<string, any>)) {
    if (k.length <= 32 && u && Number.isFinite(u.s) && u.s > 0 && Number.isFinite(u.t)) out[k] = { s: u.s, t: u.t }
  }
  return out
}
