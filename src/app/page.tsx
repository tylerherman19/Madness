import { pageMetadata } from '@/lib/site'
import Link from 'next/link'
import SiteHeader from './components/SiteHeader'
import LiveTicker from './components/LiveTicker'
import { Arrow, Ball, Logo, Footer } from './components/Sports'
import Countdown from './components/Countdown'
import s from './components/sports.module.css'
import { getDashboardData } from '@/lib/dashboard'
import { brandFor } from '@/lib/teamBrand'
import { formatPeriodDate } from '@/lib/competition'
import { haveSignupsClosed } from '@/lib/season'
import {fetchNcaabOdds,matchOdds} from '@/lib/odds'
import {point} from '@/lib/oddsFormat'
export const revalidate=60
const CT='America/Chicago'
export const metadata = pageMetadata('College Basketball Survivor', 'Pick a college basketball winner each game day. Win, advance, and follow the Madness survivor pool.', '/', true)

export default async function Home(){
 const [data,closed,odds]=await Promise.all([getDashboardData(),haveSignupsClosed(),fetchNcaabOdds()])
 const brands=data?.teamBrands??{}
 const games=(data?.slateGames??[]).slice().sort((a,b)=>new Date(a.tip_time).getTime()-new Date(b.tip_time).getTime())
 const label=data?.currentPeriod?formatPeriodDate(data.currentPeriod.date):'Next game day'
 const tip=(iso:string)=>new Date(iso).toLocaleTimeString('en-US',{timeZone:CT,hour:'numeric',minute:'2-digit'})
 return <div className={s.root}><SiteHeader mode={data?.mode} signupsClosed={closed}/><LiveTicker label={label}/>
 <main id="main" className={s.main}>
  <section className={s.welcome}>
   <div className={s.welcomeCopy}><h1>One team<br/>{data?.mode === 'march-madness' ? 'each round.' : 'each game day.'}<br/>Stay alive.</h1><div className={s.heroActions}><Link href="/pick" className={s.primary}>Make your pick <Arrow/></Link><Link href="/login" className={s.heroSecondary}>Sign in</Link>{!closed && <Link href="/signup" className={s.heroSecondary}>Join pool · $25</Link>}</div></div>
   <div className={s.heroArt} aria-hidden="true"><span>SAME<br/>GAMES.<br/><b>BIGGER<br/>STAKES.</b></span></div>
  </section>
  {!closed && data?.slate && !data.slateIsToday && <p className={s.privacyNotice}>Registration open — next game day: {label}. $25 entry via Venmo to @griffinsell. Picks lock at the first tip; teams cannot be reused.</p>}
  {!data&&<p role="status" className={s.privacyNotice}>Pool data is unavailable. Refresh to try again.</p>}
  <dl className={s.stats}><div><dt>Still alive</dt><dd>{data?.aliveCount??'-'}<small>{data?.totalPlayers?Math.round((data.aliveCount/data.totalPlayers)*100):0}% of field</small></dd></div><div><dt>Eliminated</dt><dd>{data?.eliminatedCount??'-'}<small>{data?.totalPlayers??0} total entries</small></dd></div><div><dt>Paid entry estimate</dt><dd>{data?'$'+data.potSize.toLocaleString():'-'}<small>{data?.paidEntries ?? 0} paid · {data?.pendingEntries ?? 0} pending</small></dd></div><div><dt>Picks in</dt><dd>{data?.picksMade??'-'}<small>of {data?.aliveCount??'-'} survivors</small></dd></div></dl>
  <div className={s.dashboardGrid}>
   <section className={s.gamesCard}>
    <div className={s.sectionTitle}>
     <h2>{data?.slateIsToday ? "Today's games" : label + ' games'}</h2>
     <Link href="/schedule">View all games <Arrow/></Link>
    </div>
    <div className={s.gameTable} role="region" aria-label="Today's games" tabIndex={0}>
     <div className={s.gameHead}><span>Time (CT)</span><span>Matchup</span><span>Line / status</span></div>
     {games.map(g=>{
      const o=matchOdds(odds,[brandFor(g.home_team,brands).name,brandFor(g.home_team,brands).shortName,g.home_team],[brandFor(g.away_team,brands).name,brandFor(g.away_team,brands).shortName,g.away_team],g.tip_time)
      return <Link href="/schedule" className={s.gameRow} key={g.id}>
       <time>{g.time_tbd?'TBD':tip(g.tip_time)}</time>
       <span className={s.gameTeams}>
        <i><Logo team={g.away_team} brands={brands} size={30}/>{brandFor(g.away_team,brands).shortName}</i>
        <small>vs</small>
        <i><Logo team={g.home_team} brands={brands} size={30}/>{brandFor(g.home_team,brands).shortName}</i>
       </span>
       <b>{o?`${point(o.spreadHome)} / ${o.total??'-'}`:(g.status_state==='post'?'Final':g.status_state==='in'?'Live':'—')}</b>
      </Link>
     })}
     {games.length===0&&<p className={s.empty}>The next slate will appear here when it is set.</p>}
    </div>
   </section>
   <section className={s.deadlineCard}>
    <div className={s.deadlineIcon}><Ball/></div>
    <div><span>Next pick deadline</span>{data?.nextDeadline?<Countdown deadline={data.nextDeadline}/>:<b>Deadline pending</b>}<small>{data?.nextDeadlineFormatted??'All picks lock at the first tip'}</small></div>
    <div className={s.roundTrack}><span>Current game day</span><strong>{label}</strong></div>
   </section>
   <section id="rules" className={s.howCard}>
    <div className={s.sectionTitle}><h2>How it works</h2><Link href="/standings#rules">Full rules <Arrow/></Link></div>
    <div className={s.steps}>{[['1','Join','Create an account and enter the pool.'],['2','Pick',data?.mode === 'march-madness' ? 'Complete the picks required each round.' : 'Choose one team each game day.'],['3','Survive','A win keeps your run alive.'],['4','Win','Last player standing takes the pot.']].map(x=><div key={x[0]}><b>{x[0]}</b><span><strong>{x[1]}</strong><small>{x[2]}</small></span></div>)}</div>
   </section>
  </div>
 </main><Footer/></div>
}
