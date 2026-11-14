import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeIncident, incidentSentence, needsHuman, recoveryKeysForWorkload, summarize } from './incidentText.ts'

const later = '2026-11-12T10:00:00Z'
const earlier = '2026-11-10T10:00:00Z'
const inc = (key: string, latest_at = earlier, occurrences = 42) => ({ key, occurrences, latest_at })

test('a delayed job that has succeeded since is recovered, named in plain words, and not counted', () => {
  const card = describeIncident(inc('api/cron/worker/results'), [{ id: 'results', lastSuccessAt: later }])
  assert.equal(card.recovered, true)
  assert.equal(incidentSentence(card, 'Nov 10'), 'Updating scores was delayed 42 times, last on Nov 10. It has been running normally since.')
  const s = summarize([inc('api/cron/worker/results')], [{ id: 'results', lastSuccessAt: later }], [{ id: 'results', state: 'ok' }], false)
  assert.equal(s.needs, 0); assert.equal(s.headline, 'Everything is running'); assert.equal(s.recovered.length, 1)
})
test('a job incident newer than the last success is still a problem', () => {
  const s = summarize([inc('api/cron/worker/grading', later)], [{ id: 'grading', lastSuccessAt: earlier }], [{ id: 'grading', state: 'ok' }], false)
  assert.equal(s.needs, 1); assert.equal(s.headline, '1 thing needs your attention')
})
test('human-decision incidents never count as recovered and are never auto-resolved', () => {
  for (const key of ['turnover-missed:2026-11-13', 'result-review:abc', 'wrongly-eliminated:p:3', 'schedule-sync:2026-11-12', 'schedule-change:g', 'team-identity:2026-11-12']) {
    assert.equal(needsHuman(key), true)
    assert.equal(describeIncident(inc(key), [{ id: 'results', lastSuccessAt: later }]).recovered, false)
    for (const w of ['results', 'advance', 'grading', 'schedule', 'assignment']) assert.equal(recoveryKeysForWorkload(w).includes(key), false)
  }
  const s = summarize([inc('turnover-missed:2026-11-13'), inc('result-review:x')], [], [], false)
  assert.equal(s.needs, 2); assert.equal(s.headline, '2 things need your attention')
})
test('recovery keys cover the workload key and its older route', () => {
  assert.deepEqual(recoveryKeysForWorkload('results').sort(), ['api/cron/sync-results', 'api/cron/worker/results'].sort())
  assert.ok(recoveryKeysForWorkload('advance').includes('api/cron/auto-advance'))
})
test('a failing job and its incident count once; a stale day with its incident counts once', () => {
  const s = summarize([inc('api/cron/worker/advance', later)], [], [{ id: 'advance', state: 'failing' }], false)
  assert.equal(s.needs, 1)
  assert.equal(summarize([inc('turnover-missed:2026-11-13')], [], [], true).needs, 1)
  assert.equal(summarize([], [], [], true).needs, 1)
})
test('unknown keys get a generic fallback with no raw key in the title', () => {
  const card = describeIncident(inc('api/admin/whatever'))
  assert.equal(card.title, 'Something went wrong')
})
