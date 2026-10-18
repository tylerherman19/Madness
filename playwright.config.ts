import {defineConfig} from '@playwright/test'
import {resolve} from 'node:path'
export default defineConfig({
 testDir:'./tests',fullyParallel:false,workers:1,timeout:60000,
 use:{baseURL:'http://127.0.0.1:3017',trace:'retain-on-failure'},
 webServer:[
  {command:'node tests/support/database.mjs',url:'http://127.0.0.1:54329/ready',reuseExistingServer:false,timeout:60000},
  {command:'npm run dev -- --hostname 127.0.0.1 --port 3017',url:'http://127.0.0.1:3017/login',timeout:120000,reuseExistingServer:false,
   env:{SUPABASE_URL:'http://127.0.0.1:54329',SUPABASE_SERVICE_ROLE_KEY:'fixture-only',SESSION_SECRET:'fixture-only-signing-secret-at-least-32-characters',EMAILS_ENABLED:'false',RESEND_WEBHOOK_SECRET:'whsec_'+Buffer.alloc(32,7).toString('base64'),RESEND_API_KEY:'re_fixture_only',AUTOMATION_V2_ENABLED:'false',NEXT_PUBLIC_APP_URL:'http://127.0.0.1:3017',NODE_OPTIONS:`--import ${resolve('tests/support/upstream.mjs')}`}},
 ],
})
