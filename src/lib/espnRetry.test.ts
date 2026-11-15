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

function withFetch(failures: Record<string, number>) {
  const calls: Record<string, number> = {}
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string) => {
    const group = new URL(url).searchParams.get('groups')!
    calls[group] = (calls[group] ?? 0) + 1
    if (calls[group] <= (failures[group] ?? 0)) return new Response('busy', { status: 503 })
    return Response.json({ events: [{ id: `e${group}`, date: '2099-01-01T18:00:00Z' }] })
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

test('one failed group request is retried and the feed is complete', async () => {
  const f = withFetch({ '23': 1 })
  try {
    const { failedGroups, events } = await loadEspn().fetchDayScoreboard('20990101')
    assert.deepEqual(failedGroups, [])
    assert.ok(events.some((e) => e.id === 'e23'))
    assert.equal(f.calls['23'], 2)
  } finally { f.restore() }
})

test('a group that fails twice is still reported as missing', async () => {
  const f = withFetch({ '23': 2 })
  try {
    const { failedGroups } = await loadEspn().fetchDayScoreboard('20990101')
    assert.deepEqual(failedGroups, ['SEC'])
    assert.equal(f.calls['23'], 2)
  } finally { f.restore() }
})
