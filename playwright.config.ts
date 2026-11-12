import {defineConfig} from '@playwright/test'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
// Ports are overridable so several checkouts can run the browser suite at once.
const APP=`http://127.0.0.1:${process.env.E2E_APP_PORT??'3017'}`
const DB=`http://127.0.0.1:${process.env.E2E_DB_PORT??'54329'}`
export default defineConfig({
 testDir:'./tests',fullyParallel:false,workers:1,timeout:60000,
 use:{baseURL:APP,trace:'retain-on-failure'},
 webServer:[
  {command:'node tests/support/database.mjs',url:`${DB}/ready`,reuseExistingServer:false,timeout:60000},
  {command:`npm run dev -- --hostname 127.0.0.1 --port ${new URL(APP).port}`,url:`${APP}/login`,timeout:120000,reuseExistingServer:false,
   env:{SUPABASE_URL:DB,SUPABASE_SERVICE_ROLE_KEY:'fixture-only',SESSION_SECRET:'fixture-only-signing-secret-at-least-32-characters',EMAILS_ENABLED:'false',RESEND_WEBHOOK_SECRET:'whsec_'+Buffer.alloc(32,7).toString('base64'),RESEND_API_KEY:'re_fixture_only',AUTOMATION_V2_ENABLED:'false',TOURNAMENT_RELIABILITY_ENABLED:process.env.TOURNAMENT_RELIABILITY_TEST_MODE??'true',NEXT_PUBLIC_APP_URL:APP,NODE_OPTIONS:`--import ${pathToFileURL(resolve('tests/support/upstream.mjs')).href}`}},
 ],
})
