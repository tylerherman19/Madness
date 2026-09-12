import Link from 'next/link'
import SiteHeader from './components/SiteHeader'
import LiveTicker from './components/LiveTicker'
import { Arrow, Ball, Logo, Footer } from './components/Sports'
import s from './components/sports.module.css'
import { getDashboardData } from '@/lib/dashboard'
import { brandFor } from '@/lib/teamBrand'
import { formatPeriodDate } from '@/lib/competition'
import { haveSignupsClosed } from '@/lib/season'
import { fetchDayScoreboard } from '@/lib/espn'
export const revalidate=60
const CT='America/Chicago'
export default async function Home(){
 const [data,closed]=await Promise.all([getDashboardData(),haveSignupsClosed()])
 const brands=data?.teamBrands??{}
 const name=(team:string)=>brandFor(team,brands).shortName
 const games=(data?.slateGames??[]).slice().sort((a,b)=>Number(a.time_tbd)-Number(b.time_tbd)||new Date(a.tip_time).getTime()-new Date(b.tip_time).getTime())
 const first=games[0]
 const label=data?.currentPeriod?formatPeriodDate(data.currentPeriod.date):'The next game day'
 const records:Record<string,string>={}
 if(data?.slate) {try{const {events}=await fetchDayScoreboard(String(data.slate.slate_date).slice(0,10).replaceAll('-',''),3600);for(const event of events)for(const c of event.competitions?.[0]?.competitors??[])if(c.team?.abbreviation&&c.records?.[0]?.summary)records[c.team.abbreviation]=c.records[0].summary}catch{/* Records are optional; never invent them. */}}
 const tip=(game:typeof first)=>game.time_tbd?'Time TBD':new Date(game.tip_time).toLocaleTimeString('en-US',{timeZone:CT,hour:'numeric',minute:'2-digit'})+' CT'
 return <div className={s.root}><SiteHeader signupsClosed={closed}/><LiveTicker label={label}/>
 <main className={s.main}><div className={s.pageHeading}><div><p className={s.context}>College basketball survivor</p><h1>Your pool. Your next move.</h1></div><Link className={s.textButton} href="/standings#rules">How to play ↗</Link></div>
 <section className={s.welcome}><div className={s.welcomeCopy}><span className={s.status}><i/>{data?.slate?'Game day '+data.slate.slate_number:'Season ahead'} · {data?.nextDeadline?'Picks open':data?.picksRevealed?'Picks locked':'Schedule pending'}</span><h2>Stay in the game.</h2><p>One team. One pick for the whole day.<br/>Choose your winner and keep your run alive.</p><Link href="/pick" className={s.primary}>{data?.picksRevealed?'View your daily pick':'Make your daily pick'}<Arrow/></Link><small>{data?.nextDeadlineFormatted?'Picks close '+data.nextDeadlineFormatted:data?.picksRevealed?'Picks have locked for this game day.':'All picks lock at the first tip of the day.'}</small></div>
 <div className={s.ticketStage}><div className={s.courtDrawing} aria-hidden="true"><svg viewBox="0 0 400 270" fill="none" stroke="currentColor"><rect x="12" y="12" width="376" height="246" rx="6"/><path d="M200 12v246"/><circle cx="200" cy="135" r="44"/><path d="M12 55h80v160H12m376-160h-80v160h80"/><path d="M12 32a107 107 0 0 1 0 206m376-206a107 107 0 0 0 0 206"/></svg></div>
 <div className={s.dayTicket}><div className={s.ticketTop}><Ball/><span>{label}</span><b>{data?.slate?String(data.slate.slate_number).padStart(2,'0'):'—'}</b></div><div className={s.ticketBody}><span className={s.ticketCaption}>{first?.time_tbd?'On the next slate':'First tip of the day'}</span>{first?<><div className={s.ticketTeams}><div><Logo team={first.away_team} brands={brands} size={65}/><strong>{name(first.away_team)}</strong>{records[first.away_team]&&<small>{records[first.away_team]}</small>}</div><span className={s.versus}>at</span><div><Logo team={first.home_team} brands={brands} size={65}/><strong>{name(first.home_team)}</strong>{records[first.home_team]&&<small>{records[first.home_team]}</small>}</div></div><div className={s.ticketTip}><b>{tip(first)}</b>{first.tv&&<span>{first.tv}</span>}</div>{first.venue&&<p>{first.venue}</p>}</>:<div className={s.empty}><Ball/><strong>Next matchup coming soon.</strong></div>}</div><div className={s.ticketStub}><span>{games.length} games on the slate</span><span className={s.barcode} aria-hidden="true"/></div></div></div></section>
 {!data&&<p role="status" className={s.privacyNotice}>Pool data is unavailable. Refresh to try again.</p>}
 <dl className={s.stats}><div><dt>Prize pool</dt><dd>{data?'$'+data.potSize.toLocaleString():'—'}<small>{data?.totalPlayers??'—'} entries</small></dd></div><div><dt>Still standing</dt><dd>{data?.aliveCount??'—'}<small>{data?.eliminatedCount??'—'} eliminated</small></dd></div><div><dt>Game day</dt><dd>{data?.slate?.slate_number??'—'}<small>{data?.slate?.season_year??''} season</small></dd></div><div><dt>Picks submitted</dt><dd>{data?.picksMade??'—'}<small>of {data?.aliveCount??'—'} survivors</small></dd></div></dl>
 <div className={s.overviewColumns}><section><div className={s.sectionTitle}><h2>On the court</h2><Link className={s.textButton} href="/schedule">All games <Arrow/></Link></div><div className={s.compactGames}>{games.slice(0,3).map(game=><div className={s.compactGame} key={game.id}><div className={s.timeColumn}><b>{tip(game)}</b><small>{game.tv}</small></div><div className={s.miniMatchup}><span><Logo team={game.away_team} brands={brands} size={30}/><b>{name(game.away_team)}</b></span><span><Logo team={game.home_team} brands={brands} size={30}/><b>{name(game.home_team)}</b></span></div><span className={s.gameSoon}>{game.status_state==='post'?'Final':game.status_state==='in'?'Live':'Upcoming'}</span></div>)}</div>{games.length===0&&<p className={s.empty}>Games will appear once the schedule is available.</p>}</section>
 <section><div className={s.sectionTitle}><h2>Follow the field</h2><Link className={s.textButton} href="/standings">Standings <Arrow/></Link></div><div className={s.seasonPanel}><div><span className={s.alive}><i/>The Sweatboard</span><strong>Every score.<br/>Every survivor.</strong></div><p>See which teams the pool needs, who is through, and who needs a comeback. Picks stay private until lock.</p><Link className={s.primary} href="/live">Open Sweatboard <Arrow/></Link></div></section></div>
 </main><Footer/></div>
}
