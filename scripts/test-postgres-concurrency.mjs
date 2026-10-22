// Requires an EMPTY, disposable PostgreSQL database. Never points to production by default.
import pg from 'pg'
import { readFile, readdir } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
const url = process.env.STAGING_DATABASE_URL
if (!url || process.env.CONCURRENCY_TEST_ACK !== 'EMPTY_DISPOSABLE_DATABASE')
  throw new Error(
    'Provide an empty disposable database and acknowledge it explicitly',
  )
const setup = new pg.Client({ connectionString: url })
await setup.connect()
if (
  (
    await setup.query(
      "select count(*)::int n from information_schema.tables where table_schema='public' and table_type='BASE TABLE'",
    )
  ).rows[0].n
)
  throw new Error('Database must be empty; refusing to reset existing data')
for (const role of ['anon', 'authenticated', 'service_role', 'authenticator'])
  await setup.query(
    `do $$ begin create role ${role};exception when duplicate_object then null;end $$`,
  )
for (const file of (await readdir('supabase/migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort())
  await setup.query(await readFile(`supabase/migrations/${file}`, 'utf8'))
const players = Array.from({ length: 50 }, () => randomUUID()),
  slate = randomUUID()
await setup
  .query(
    "update pools set season_year=2099;insert into slates(id,slate_number,slate_date,season_year,is_active,locks_at)values($1,1,'2099-03-19',2099,true,clock_timestamp()+interval '1 hour')",
    [slate],
  )
  .catch(async () => {
    await setup.query('update pools set season_year=2099')
    await setup.query(
      "insert into slates(id,slate_number,slate_date,season_year,is_active,locks_at)values($1,1,'2099-03-19',2099,true,clock_timestamp()+interval '1 hour')",
      [slate],
    )
  })
await setup.query(
  "insert into games(slate_id,espn_event_id,home_team,away_team,tip_time)values($1,'fixture','A','B',clock_timestamp()+interval '1 hour')",
  [slate],
)
for (const id of players)
  await setup.query(
    "insert into players(id,full_name,email,pin_hash)values($1,'Fixture',$2,'fixture')",
    [id, `${id}@example.test`],
  )
const clients = await Promise.all(
  players.map(async () => {
    const c = new pg.Client({ connectionString: url })
    await c.connect()
    await c.query("set statement_timeout='10s';set deadlock_timeout='100ms'")
    return c
  }),
)
try {
  const request = randomUUID(),
    same = await Promise.all(
      clients.map((c) =>
        c.query("select save_pick($1,$2,'A',$3) receipt", [
          players[0],
          slate,
          request,
        ]),
      ),
    )
  assert.equal(new Set(same.map((r) => r.rows[0].receipt.pick.id)).size, 1)
  const edits = await Promise.allSettled(
    clients
      .slice(0, 2)
      .map((c, index) =>
        c.query('select save_pick($1,$2,$3,$4,$5,$6)', [
          players[0],
          slate,
          index ? 'B' : 'B',
          randomUUID(),
          same[0].rows[0].receipt.pick.id,
          same[0].rows[0].receipt.pick.updated_at,
        ]),
      ),
  )
  assert.equal(edits.filter((r) => r.status === 'fulfilled').length, 1)
  await Promise.all(
    clients
      .slice(1)
      .map((c, i) =>
        c.query("select save_pick($1,$2,'A',$3)", [
          players[i + 1],
          slate,
          randomUUID(),
        ]),
      ),
  )
  // Authoritative clock must be read AFTER a player lock wait that crosses lock.
  await setup.query(
    "update slates set locks_at=clock_timestamp()+interval '500 milliseconds' where id=$1",
    [slate],
  )
  await setup.query('begin')
  await setup.query('select id from players where id=$1 for update', [
    players[1],
  ])
  const late = clients[1]
    .query("select save_pick($1,$2,'B',$3,$4,$5)", [
      players[1],
      slate,
      randomUUID(),
      (
        await clients[2].query('select id from picks where player_id=$1', [
          players[1],
        ])
      ).rows[0].id,
      (
        await clients[2].query(
          'select updated_at::text from picks where player_id=$1',
          [players[1]],
        )
      ).rows[0].updated_at,
    ])
    .then(
      () => false,
      (error) => /locked/i.test(error.message),
    )
  await new Promise((resolve) => setTimeout(resolve, 800))
  await setup.query('commit')
  assert.equal(await late, true)
  console.log(
    'PASS real PostgreSQL: 50 simultaneous duplicate retries, stale edit race, independent player submissions and lock wait crossing deadline; no deadlocks observed',
  )
} finally {
  await Promise.all(clients.map((c) => c.end()))
  await setup.end()
}
