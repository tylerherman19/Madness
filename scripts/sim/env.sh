# Source from the repo root: environment for the local simulation stack (127.0.0.1 only).
export SIM_APP_PORT=${SIM_APP_PORT:-3917}
export SIM_DB_PORT=${SIM_DB_PORT:-55231}
export E2E_DB_PORT=$SIM_DB_PORT
export FIXTURE_DB_ENGINE=postgres
export FIXTURE_NO_SEED=true
export FIXTURE_PG_URL=postgres://postgres:postgres@127.0.0.1:55470/sim
export SUPABASE_URL=http://127.0.0.1:$SIM_DB_PORT
export SUPABASE_SERVICE_ROLE_KEY=fixture-only
export SESSION_SECRET=fixture-only-signing-secret-at-least-32-characters
export EMAILS_ENABLED=false
export RESEND_WEBHOOK_SECRET=whsec_$(printf 'a%.0s' {1..43})=
export RESEND_API_KEY=re_fixture_only
export CRON_SECRET=sim-cron-secret-local-only
export TOURNAMENT_RELIABILITY_ENABLED=true
export AUTOMATION_V2_ENABLED=true
export NEXT_PUBLIC_APP_URL=http://127.0.0.1:$SIM_APP_PORT
# bcrypt of "SimAdminPass1!" (cost 4), local only
export ADMIN_PASSWORD_HASH='$2b$04$'$(node -e "process.stdout.write(require('bcryptjs').hashSync('SimAdminPass1!',4).slice(7))")
export SIM_NODE_OPTIONS="--import $(node -e "process.stdout.write(require('url').pathToFileURL(require('path').resolve('tests/support/upstream.mjs')).href)")"
