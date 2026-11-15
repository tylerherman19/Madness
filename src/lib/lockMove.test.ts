// REL-04: a lock that moves earlier is always audited, and becomes an
// organizer incident only when players can act on it (Fable red-team #4).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'

function loadSlates(audits: unknown[]) {
  const exports: Record<string, unknown> = {}
  const code = ts.transpileModule(readFileSync(new URL('./slates.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const deps: Record<string, unknown> = { 'server-only': {}, 'node:crypto': { randomUUID }, './audit': { logAudit: async (_db: unknown, entry: unknown) => { audits.push(entry) } } }
  new Function('require', 'exports', code)((name: string) => { assert.ok(name in deps, `Unexpected dependency ${name}`); return deps[name] }, exports)
  return exports as { refreshLockTime: (db: unknown, id: string) => Promise<void> }
}

function fakeDb({ previous, tip, active, picks }: { previous: string; tip: string; active: boolean; picks: number }) {
  const incidents: unknown[] = []
  const chain = (table: string) => {
    const q: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'order', 'limit']) q[m] = () => q
    q.single = async () => ({ data: { locks_at: previous, is_active: active }, error: null })
    q.update = () => ({ eq: async () => ({ error: null }) })
    q.then = (resolve: (v: unknown) => void) => resolve(table === 'games' ? { data: [{ tip_time: tip }], error: null } : { count: picks, data: null, error: null })
    return q
  }
  return { incidents, db: { from: chain, rpc: async (_name: string, args: unknown) => { incidents.push(args); return {} } } }
}

const hours = (n: number) => new Date(Date.now() + n * 3600_000).toISOString()

test('a far-off day with no picks: audited, no incident', async () => {
  const audits: unknown[] = []
  const { db, incidents } = fakeDb({ previous: hours(24 * 10), tip: hours(24 * 9), active: false, picks: 0 })
  await loadSlates(audits).refreshLockTime(db, 's')
  assert.equal(audits.length, 1); assert.equal(incidents.length, 0)
})
test('the active day, a lock within 48 hours, or a picked day: incident', async () => {
  for (const c of [
    { previous: hours(30), tip: hours(20), active: true, picks: 0 },
    { previous: hours(40), tip: hours(30), active: false, picks: 0 },
    { previous: hours(24 * 10), tip: hours(24 * 9), active: false, picks: 3 },
  ]) {
    const audits: unknown[] = []
    const { db, incidents } = fakeDb(c)
    await loadSlates(audits).refreshLockTime(db, 's')
    assert.equal(audits.length, 1); assert.equal(incidents.length, 1, JSON.stringify(c))
  }
})
test('a lock that does not move earlier is not reported', async () => {
  const audits: unknown[] = []
  const { db, incidents } = fakeDb({ previous: hours(5), tip: hours(6), active: true, picks: 1 })
  await loadSlates(audits).refreshLockTime(db, 's')
  assert.equal(audits.length, 0); assert.equal(incidents.length, 0)
})
