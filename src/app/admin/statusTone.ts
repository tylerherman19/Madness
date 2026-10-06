// Admin forms report the outcome of a sync, a grade, a broadcast. The tone of
// that outcome used to ride along inside the message text as an emoji prefix,
// which meant the colour of the line was decided by matching the first
// character of the string — and the product shipped emoji. The tone is data,
// so it travels as data.

export type StatusTone = 'ok' | 'info' | 'error'

export interface StatusMessage {
  tone: StatusTone
  text: string
}

export const TONE_TEXT_CLASS: Record<StatusTone, string> = {
  ok: 'text-success',
  info: 'text-ink',
  error: 'text-danger',
}

// Errors interrupt; everything else waits its turn.
export const TONE_ROLE: Record<StatusTone, 'alert' | 'status'> = {
  ok: 'status',
  info: 'status',
  error: 'alert',
}
