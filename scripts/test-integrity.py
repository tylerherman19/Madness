"""Real concurrent PostgreSQL regression checks against the isolated Docker fixture.
Never points at Supabase; container name and test-only database are fixed.
Start with: docker run --name madness-audit-postgres -e POSTGRES_PASSWORD=local-test-only -d postgres:17
"""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import subprocess

BASE = ['docker', '--host=unix:///var/run/docker.sock', 'exec', '-i', 'madness-audit-postgres', 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At']
def sql(statement, check=True):
    result = subprocess.run(BASE, input=statement, capture_output=True, text=True)
    if check and result.returncode:
        raise RuntimeError(result.stderr)
    return result

sql("drop database if exists madness_integrity_test;")
sql("create database madness_integrity_test;")
BASE.extend(['-d', 'madness_integrity_test'])
sql("create role anon;", check=False)
sql("create role authenticated;", check=False)
sql("create role service_role;", check=False)
sql("create role authenticator;", check=False)
for migration in sorted(Path('supabase/migrations').glob('*.sql')):
    sql(migration.read_text())
player = '00000000-0000-4000-8000-000000000001'
slate = '00000000-0000-4000-8000-000000000002'
slate2 = '00000000-0000-4000-8000-000000000003'
player2 = '00000000-0000-4000-8000-000000000004'
sql(f"""
insert into players(id, full_name, email, pin_hash) values ('{player}', 'Duplicate Name', 'test1@example.test', 'local'), ('{player2}', 'Duplicate Name', 'test2@example.test', 'local');
insert into slates(id, slate_number, slate_date, season_year, locks_at, is_active) values
 ('{slate}', 1, current_date+1, 2027, now()+interval '1 day', true),
 ('{slate2}', 2, current_date+2, 2027, now()+interval '2 days', false);
insert into games(slate_id, espn_event_id, home_team, away_team, tip_time, round_label) values
 ('{slate}', 'test1', 'A', 'B', now()+interval '1 day', 'Elite 8'),
 ('{slate}', 'test2', 'C', 'D', now()+interval '1 day', 'Elite 8'),
 ('{slate2}', 'test3', 'E', 'F', now()+interval '2 days', 'Elite Eight');
""")
def race(teams, owner=player, day=slate):
    with ThreadPoolExecutor(max_workers=len(teams)) as pool:
        return list(pool.map(lambda team: sql(f"insert into picks(player_id, slate_id, team) values ('{owner}', '{day}', '{team}');", check=False), teams))
results = race(['A', 'B'])
assert sum(r.returncode == 0 for r in results) == 1, results
assert sql(f"select count(*) from picks where player_id='{player}';").stdout.strip() == '1'
print('PASS daily concurrent quota: exactly one accepted')
assert sql(f"select count(*) from audit_log where player_id='{player}';").stdout.strip() == '1'
print('PASS durable pick audit')
sql("update pools set competition_mode='march-madness', pick_frequency='tournament-round';")
results = race(['C', 'D'])
assert sum(r.returncode == 0 for r in results) == 1
result = sql(f"insert into picks(player_id, slate_id, team) values ('{player}', '{slate2}', 'E');", check=False)
assert result.returncode != 0 and 'quota' in result.stderr.lower()
print('PASS shared-round quota spans multiple days')
sql(f"select activate_slate('{slate2}');")
result = sql("select activate_slate('00000000-0000-4000-8000-000000000099');", check=False)
assert result.returncode != 0
assert sql(f"select id from slates where is_active;").stdout.strip() == slate2
print('PASS activation failure preserves prior active slate')
# A stored later lock cannot overrule an earlier actual tip.
sql(f"update games set tip_time=now()-interval '1 minute' where slate_id='{slate}';")
assert sql(f"insert into picks(player_id, slate_id, team) values ('{player2}', '{slate}', 'A');", check=False).returncode != 0
print('PASS database deadline recheck')
before = sql(f"select assignment_schedule::text from slates where id='{slate}';").stdout
sql(f"update slates set locks_at=now()-interval '1 minute' where id='{slate}';")
sql(f"update games set result='home_win', tip_time=now()+interval '4 days' where slate_id='{slate}';")
after = sql(f"select assignment_schedule::text from slates where id='{slate}';").stdout
assert before == after
print('PASS lock-time snapshot survives later schedule/results updates')
# Independent notification event, duplicated state write is a no-op.
sql(f"update players set status='eliminated', elimination_slate=1 where id='{player}'; update players set status='eliminated' where id='{player}';")
assert sql('select count(*) from notification_outbox;').stdout.strip() == '1'
print('PASS idempotent elimination outbox')
