import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isAdvanceWindow } from './advanceSchedule.ts'

test('turnover starts at 3 AM Central and allows same-day recovery across DST', () => {
  for (const [date, expectedUtcHour] of [
    ['2026-01-15', 9], ['2026-07-15', 8],
    ['2026-03-08', 8], ['2026-11-01', 9],
  ] as const) {
    for (const hour of [8, 9, 11, 12]) {
      assert.equal(isAdvanceWindow(new Date(`${date}T${String(hour).padStart(2, '0')}:00:00Z`)),
        hour >= expectedUtcHour, `${date} ${hour}:00 UTC`)
    }
    const start = new Date(`${date}T${String(expectedUtcHour).padStart(2, '0')}:00:00Z`)
    assert.equal(isAdvanceWindow(new Date(start.getTime() - 1)), false)
    assert.equal(isAdvanceWindow(new Date(start.getTime() + 59 * 60 * 1000)), true)
    assert.equal(isAdvanceWindow(new Date(start.getTime() + 60 * 60 * 1000)), true)
  }
})

test('scheduled overnight backstops precede both turnover entries', () => {
  const { crons } = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'))
  const schedules = (path: string) => crons.filter((job: { path: string }) => job.path === path)
    .map((job: { schedule: string }) => job.schedule)
  assert.deepEqual(schedules('/api/cron/auto-assign'), ['0 6 * * *'])
  assert.deepEqual(schedules('/api/cron/sync-results'), ['0 7 * * *'])
  assert.deepEqual(schedules('/api/cron/auto-advance'), ['0 8 * * *', '0 9 * * *'])
})
