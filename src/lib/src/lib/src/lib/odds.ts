import 'server-only'
import type {GameOdds} from './oddsFormat'
export type {GameOdds} from './oddsFormat'
type Outcome={name:string;price:number;point?:number}
type Market={key:string;outcomes:Outcome[]}
type Bookmaker={title:string;last_update:string;markets:Market[]}
type OddsEvent={home_team:string;away_team:string;commence_time:string;bookmakers:Bookmaker[]}
const norm=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]/g,'').replace(/university|college/g,'')
export async function fetchNcaabOdds():Promise<GameOdds[]>{
 const key=process.env.ODDS_API_KEY
 if(!key)return []
 try{
  const url=`https://api.the-odds-api.com/v4/sports/basketball_ncaab/odds/?apiKey=${encodeURIComponent(key)}&regions=us&markets=h2h,spreads,totals&oddsFormat=american`
  const res=await fetch(url,{next:{revalidate:21600}})
  if(!res.ok)return []
  const events=await res.json() as OddsEvent[]
  return events.map(e=>{const b=e.bookmakers[0];const markets=b?.markets??[];const find=(market:string,team:string)=>markets.find(m=>m.key===market)?.outcomes.find(o=>norm(o.name)===norm(team));const total=markets.find(m=>m.key==='totals')?.outcomes.find(o=>o.name==='Over')?.point??null;return{homeTeam:e.home_team,awayTeam:e.away_team,commenceTime:e.commence_time,spreadHome:find('spreads',e.home_team)?.point??null,spreadAway:find('spreads',e.away_team)?.point??null,total,homeMoneyline:find('h2h',e.home_team)?.price??null,awayMoneyline:find('h2h',e.away_team)?.price??null,bookmaker:b?.title??null,updatedAt:b?.last_update??null}})
 }catch{return []}
}
export function matchOdds(odds:GameOdds[],homeNames:string[],awayNames:string[],tip:string){const ht=homeNames.map(norm),at=awayNames.map(norm),t=new Date(tip).getTime();return odds.find(o=>Math.abs(new Date(o.commenceTime).getTime()-t)<12*3600000&&ht.some(n=>n&&norm(o.homeTeam).includes(n)||n&&n.includes(norm(o.homeTeam)))&&at.some(n=>n&&norm(o.awayTeam).includes(n)||n&&n.includes(norm(o.awayTeam))))??null}
