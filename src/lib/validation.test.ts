import test from 'node:test'
import assert from 'node:assert/strict'
import { isClockTime, isIsoDate, isTeamCode, normalizeEmail, parseCsv } from './validation.ts'

test('isIsoDate accepts real calendar dates only', () => {
  for (const ok of ['2026-02-28', '2028-02-29', '2026-12-31']) assert.equal(isIsoDate(ok), true, ok)
  for (const bad of ['2026-02-31', '2026-02-29', '2026-13-01', '2026-00-10', '2026-1-01', '20260101', '', null, 20260101]) {
    assert.equal(isIsoDate(bad), false, String(bad))
  }
})

test('isClockTime accepts 24-hour HH:MM', () => {
  for (const ok of ['00:00', '09:30', '23:59']) assert.equal(isClockTime(ok), true)
  for (const bad of ['24:00', '9:30', '12:60', '12:00:00', '']) assert.equal(isClockTime(bad), false)
})

test('isTeamCode accepts ESPN-style abbreviations', () => {
  for (const ok of ['UNC', 'TA&M', 'MIA-FL', "SMC"]) assert.equal(isTeamCode(ok), true)
  for (const bad of ['', '<script>', 'A'.repeat(13), 7]) assert.equal(isTeamCode(bad), false)
})

test('normalizeEmail trims and lower-cases', () => {
  assert.equal(normalizeEmail('  Player@Example.COM '), 'player@example.com')
  assert.equal(normalizeEmail('not-an-email'), null)
  assert.equal(normalizeEmail(`${'a'.repeat(250)}@x.co`), null)
})

test('parseCsv handles quotes, commas, CRLF and blank lines', () => {
  const rows = parseCsv('Name,Email\r\n"O\'Brien, Pat",pat@example.com\r\n\r\n"Say ""hi""",x@y.z\n')
  assert.deepEqual(rows, [
    ['Name', 'Email'],
    ["O'Brien, Pat", 'pat@example.com'],
    ['Say "hi"', 'x@y.z'],
  ])
})
