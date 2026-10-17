 'use client'
import {useState} from 'react'
import {useRouter} from 'next/navigation'
export default function Controls({action,id}:{action:string;id?:string}) {
 const [reason,setReason]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false)
 const router=useRouter()
 async function run(){setBusy(true);try{const response=await fetch('/api/admin/operations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,id,reason})});const body=await response.json();setMessage(response.ok?(body.result?JSON.stringify(body.result):'Queued for retry.'):body.error);if(response.ok)router.refresh()}catch{setMessage('Request failed. Please try again.')}finally{setBusy(false)}}
 return <div>{id&&<label>Reason for retry <input value={reason} onChange={event=>setReason(event.target.value)} maxLength={500}/></label>}<button className="btn-secondary" onClick={run} disabled={busy||Boolean(id&&!reason.trim())}>{id?'Retry':'Preview retention cleanup'}</button><p role="status">{message}</p></div>
}
