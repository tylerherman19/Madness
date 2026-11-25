// A single dropped ESPN group response is retried once; a group that fails
// twice is still reported, so a genuinely incomplete feed stays incomplete.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

function loadEspn() {
  const exports: Record<string, unknown> = {}
  const code = ts.transpileModule(readFileSync(new URL('./espn.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  new Function('require', 'exports', code)((name: string) => { if (name === 'server-only') return {}; throw new Error(`Unexpected dependency ${name}`) }, exports)
  return exports as { fetchDayScoreboard: (d: string) => Promise<{ events: { id: string }[]; failedGroups: string[] }> }
}

type FeedEvent = { id: string; date: string; competitions?: { timeValid: boolean }[] }

function withFetch(failures: Record<string, number>, feeds?: Record<string, FeedEvent[]>) {
  const calls: Record<string, number> = {}
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string) => {
    const params = new URL(url).searchParams
    const group = params.get('groups')!
    const date = params.get('dates')!
    const key = `${date}:${group}`
    calls[key] = (calls[key] ?? 0) + 1
    if (calls[key] <= (failures[key] ?? 0)) return new Response('busy', { status: 503 })
    const events = feeds ? feeds[key] ?? [] : [{ id: `e${group}`, date: '2099-01-01T18:00:00Z' }]
    return Response.json({ events })
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

test('one failed group request is retried and the feed is complete', async () => {
  const f = withFetch({ '20990101:23': 1 })
  try {
    const { failedGroups, events } = await loadEspn().fetchDayScoreboard('20990101')
    assert.deepEqual(failedGroups, [])
    assert.ok(events.some((e) => e.id === 'e23'))
    assert.equal(f.calls['20990101:23'], 2)
  } finally { f.restore() }
})

test('a missing previous Pacific day leaves coverage incomplete', async () => {
  const f = withFetch({ '20981231:23': 2 })
  try {
    const { failedGroups } = await loadEspn().fetchDayScoreboard('20990101')
    assert.deepEqual(failedGroups, ['SEC'])
    assert.equal(f.calls['20981231:23'], 2)
  } finally { f.restore() }
})

test('Pacific scoreboards split correctly across Central midnight', async () => {
  const midnight = { id: '401909763', date: '2026-11-25T06:00Z' }
  const f = withFetch({}, {
    '20261124:2': [
      { id: 'late-but-before-midnight', date: '2026-11-25T05:49Z' },
      midnight,
      { id: 'tbd', date: '2026-11-25T05:00Z', competitions: [{ timeValid: false }] },
      { id: 'updated', date: '2026-11-25T06:20Z' },
    ],
    '20261124:8': [midnight],
    '20261125:2': [
      { id: 'updated', date: '2026-11-25T20:00Z' },
      { id: 'unexpected-date', date: '2026-11-27T18:00Z' },
    ],
  })
  try {
    const espn = loadEspn()
    const nov24 = await espn.fetchDayScoreboard('20261124')
    const nov25 = await espn.fetchDayScoreboard('20261125')
    assert.deepEqual(nov24.events.map(event => event.id), ['late-but-before-midnight'])
    assert.deepEqual(nov25.events, [
      { id: 'tbd', date: '2026-11-25T05:00Z', competitions: [{ timeValid: false }] },
      midnight,
      { id: 'updated', date: '2026-11-25T20:00Z' },
      { id: 'unexpected-date', date: '2026-11-27T18:00Z' },
    ])
    assert.deepEqual(nov25.failedGroups, [])
  } finally { f.restore() }
})
