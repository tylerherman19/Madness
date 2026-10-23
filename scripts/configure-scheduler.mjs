// One-time manual configuration only. Never log credentials or response bodies.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ORIGIN = 'https://ugyimdqnyanmxayhdvje.supabase.co'
const APP_ORIGIN = 'https://madness-cyan.vercel.app'
const JOB_NAMES = ['madness-independent-workers', 'madness-schedule-sync', 'madness-retention']
class ConfigurationError extends Error {}

export async function configureScheduler({ supabaseUrl, serviceKey, cronSecret, enable = false }, request = fetch) {
 let target
 try { target = new URL(supabaseUrl) } catch { throw new ConfigurationError('Configure the verified Madness Supabase project') }
 if (target.origin !== PROJECT_ORIGIN || target.pathname !== '/' || target.search || target.hash || target.username || target.password)
  throw new ConfigurationError('Scheduler configuration is restricted to the verified Madness project')
 if (typeof serviceKey !== 'string' || !serviceKey || typeof cronSecret !== 'string' || Buffer.byteLength(cronSecret) < 16 || Buffer.byteLength(cronSecret) > 512 || /[\x00-\x1f\x7f]/.test(cronSecret))
  throw new ConfigurationError('Existing service-role and cron authorization must be configured')
 if (typeof enable !== 'boolean') throw new ConfigurationError('Scheduler enable must be a boolean')
 let response
 try {
  response = await request(`${PROJECT_ORIGIN}/rest/v1/rpc/bootstrap_madness_scheduler`, {
   method: 'POST',
   redirect: 'error',
   headers: {
    apikey: serviceKey,
    ...(serviceKey.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${serviceKey}` }),
    'Content-Type': 'application/json',
    'Content-Profile': 'public',
   },
   body: JSON.stringify({ p_cron_secret: cronSecret, p_enable: enable }),
   signal: AbortSignal.timeout(60000),
  })
 } catch { throw new ConfigurationError('Scheduler configuration request failed') }
 if (!response.ok) throw new ConfigurationError(`Scheduler configuration failed (HTTP ${response.status})`)
 let result
 try { result = await response.json() } catch { throw new ConfigurationError('Scheduler configuration result could not be verified') }
 if (result?.ok !== true || result.enabled !== enable || result.configured !== 3 || result.base_url !== APP_ORIGIN || JSON.stringify(result.job_names) !== JSON.stringify(JOB_NAMES))
  throw new ConfigurationError('Scheduler configuration result could not be verified')
 // Return only fixed allowlisted fields, regardless of extra response content.
 return { ok: true, enabled: enable, configured: 3, base_url: APP_ORIGIN, job_names: JOB_NAMES }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 try {
  const flag = process.env.SCHEDULER_ENABLE ?? 'false'
  if (!['false', 'true'].includes(flag)) throw new ConfigurationError('SCHEDULER_ENABLE must be false or true')
  const result = await configureScheduler({
   supabaseUrl: process.env.SUPABASE_URL,
   serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
   cronSecret: process.env.CRON_SECRET,
   enable: flag === 'true',
  })
  console.log(JSON.stringify(result))
 } catch (error) {
  console.error(error instanceof ConfigurationError ? error.message : 'Scheduler configuration failed')
  process.exitCode = 1
 }
}
