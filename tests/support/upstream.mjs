// Test-process preload only. Keep browser tests independent of external provider uptime.
const original=globalThis.fetch
globalThis.fetch=(input,init)=>{
 const url=String(input instanceof Request?input.url:input)
 if(url.includes('espn.com')||url.includes('espncdn.com'))return Promise.resolve(Response.json(url.includes('/teams')?{sports:[]}:{events:[],sports:[],leagues:[]}))
 if(url.includes('the-odds-api.com'))return Promise.resolve(Response.json([]))
 return original(input,init)
}
