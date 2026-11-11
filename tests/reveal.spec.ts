import {test,expect} from '@playwright/test'
const FIXTURE_DB=`http://127.0.0.1:${process.env.E2E_DB_PORT??'54329'}`
const slate='00000000-0000-4000-8000-000000000001'
test.beforeEach(async({request})=>{expect((await request.post(`${FIXTURE_DB}/__test/reset`)).ok()).toBeTruthy()})
type SweatPlayer={name:string,team:string|null,status:string}
test('public feeds hide picks until the stored lock, for anonymous and signed-in visitors alike',async({request,playwright,baseURL})=>{
 expect((await request.post('/api/auth/login',{data:{email:'player+test@example.test',password:'FixturePass123!'}})).ok()).toBeTruthy()
 expect((await request.post('/api/picks',{data:{slate_id:slate,team:'A'}})).ok()).toBeTruthy()
 const anonymous=await playwright.request.newContext({baseURL})
 for(const client of [anonymous,request]){
  const sweat=await client.get('/api/sweat')
  expect(sweat.ok()).toBeTruthy()
  const body=await sweat.json()
  expect(body.allRevealed).toBe(false)
  expect(body.players.every((player:SweatPlayer)=>player.team===null)).toBe(true)
  expect(JSON.stringify(body.players)).not.toContain('"A"')
  expect(sweat.headers()['cache-control']).toMatch(/^public, max-age=5, s-maxage=\d+/)
  const live=await client.get('/api/live-scores')
  const ticker=await live.json()
  expect(ticker.picksVisible).toBe(false)
  expect(ticker.games.every((game:{homePicks?:number,awayPicks?:number})=>game.homePicks===undefined&&game.awayPicks===undefined)).toBe(true)
 }
 // The viewer still sees their own pick before lock (from the page, not the shared feed).
 const page=await (await playwright.chromium.launch()).newPage({baseURL,storageState:await request.storageState()})
 await page.goto('/sweat')
 await expect(page.getByLabel('Your status')).toContainText('You:')
 const anonymousPage=await (await playwright.chromium.launch()).newPage({baseURL})
 await anonymousPage.goto('/sweat')
 await expect(anonymousPage.getByLabel('Your status')).toContainText('Picks are hidden until')
 await page.context().browser()?.close();await anonymousPage.context().browser()?.close()
 // Outside test mode the sandbox parameter cannot be used to skip the CDN.
 for(const path of ['/api/sweat?sandbox=1','/api/live-scores?sandbox=1']){
  const bypass=await anonymous.get(path,{maxRedirects:0})
  expect(bypass.status()).toBe(307)
  expect(bypass.headers()['cache-control']).toBe('private, no-store')
  expect(new URL(bypass.headers()['location'],baseURL).search).toBe('')
 }
 expect((await request.post(`${FIXTURE_DB}/__test/lock`)).ok()).toBeTruthy()
 const revealed=await (await anonymous.get('/api/sweat')).json()
 expect(revealed.allRevealed).toBe(true)
 expect(revealed.players.find((player:SweatPlayer)=>player.team==='A')).toBeTruthy()
 // ESPN reports nothing for the fixture game, so it is shown as not started, never lost.
 expect(revealed.players.every((player:SweatPlayer)=>player.status!=='lost')).toBe(true)
 const ticker=await (await anonymous.get('/api/live-scores')).json()
 expect(ticker.picksVisible).toBe(true)
 await anonymous.dispose()
})
