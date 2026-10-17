import { redirect } from 'next/navigation'
import { getAdminSession } from '@/lib/session'
import { getDb } from '@/lib/testMode'
import Controls from './Controls'
export default async function OperationsPage() {
 if(!await getAdminSession()) redirect('/admin/login')
 const db=await getDb()
 const [jobs,notices]=await Promise.all([
  db.from('operation_runs').select('key,status,attempts,updated_at,last_error').order('updated_at',{ascending:false}).limit(100),
  db.from('notification_outbox').select('id,kind,status,attempts,created_at,last_error').eq('status','review').order('created_at',{ascending:false}).limit(100),
 ])
 return <section className="mx-auto max-w-5xl p-6"><h1>Operations</h1><p>Turnover: 3 a.m. Central. Automatic worker: {process.env.AUTOMATION_V2_ENABLED==='true'?'enabled':'awaiting activation'}. Outbound queue: {process.env.OUTBOX_DELIVERY_ENABLED==='true'?'enabled':'off'}.</p>{jobs.error||notices.error?<p>Operational state is unavailable. Verify migration 024 and database access before activation.</p>:<><h2>Recent jobs</h2><ul>{(jobs.data??[]).map(job=><li key={job.key}>{job.key}: {job.status} ({job.attempts} attempts){job.status==='review'&&<Controls action="retry-job" id={job.key}/>}</li>)}</ul><h2>Notifications needing review</h2><ul>{(notices.data??[]).map(notice=><li key={notice.id}>{notice.kind}: {notice.status} ({notice.attempts} attempts)<Controls action="retry-notification" id={notice.id}/></li>)}</ul><Controls action="retention-preview"/></>}</section>
}
