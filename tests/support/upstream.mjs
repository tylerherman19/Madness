// Test-process preload only. Keep browser tests independent of external provider uptime.
// A test may script ESPN's scoreboard by writing { "YYYYMMDD": [events] } to a
// file named after the fixture database port (see tests/support/espn.ts).
import {readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
const original=globalThis.fetch
const scripted=()=>{
 try{return JSON.parse(readFileSync(join(tmpdir(),`madness-fake-espn-${new URL(process.env.SUPABASE_URL??'http://x:0').port}.json`),'utf8'))}catch{return {}}
}
globalThis.fetch=(input,init)=>{
 const url=String(input instanceof Request?input.url:input)
 if(url.includes('espn.com')||url.includes('espncdn.com')){
  if(url.includes('/scoreboard')){
   const events=scripted()[new URL(url).searchParams.get('dates')]
   if(events)return Promise.resolve(Response.json({events,sports:[],leagues:[]}))
  }
  // A test may also script the AP poll: { "rankings": { "ABBR": 3, ... } }.
  if(url.includes('/rankings')){
   const ranks=scripted().rankings
   if(ranks)return Promise.resolve(Response.json({rankings:[{name:'AP Top 25',type:'ap',ranks:Object.entries(ranks).map(([abbreviation,current])=>({current,team:{abbreviation}}))}]}))
  }
  return Promise.resolve(Response.json(url.includes('/teams')?{sports:[]}:{events:[],sports:[],leagues:[]}))
 }
 if(url.includes('the-odds-api.com'))return Promise.resolve(Response.json([]))
 return original(input,init)
}
