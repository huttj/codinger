// Estimates and what the work took (server/estimates.ts), for the Estimates page in Settings.

export type EstimateRow = {
  id: string; t: number; sid: string; title?: string; task: string; minutes: number; usd?: number; humanHours?: number
  // minutes: the time of the session's turns (wall for a pair whose transcript was gone); wall: the time on the clock.
  actual?: { t: number; minutes: number; wall: number; usd: number; calls: number; note?: string }
}
// The medians the prompt quotes, over n pairs: actual over estimate, and per human hour.
export type EstimatesFound = { n: number; time?: number; cost?: number; perHour?: number; usdPerHour?: number }
export type EstimatesReply = { rows: EstimateRow[]; found: EstimatesFound }
