'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { brandFor, type TeamBrandDirectory } from '@/lib/teamBrand'
import type { SweatResponse } from '@/app/api/sweat/route'
import { Logo, Arrow } from '@/app/components/Sports'
import s from '@/app/components/sports.module.css'
export default function SweatBoard({teamBrands}:{teamBrands:TeamBrandDirectory}){
 const [data,setData]=useState<SweatResponse|null>(null)
 const [updated,setUpdated]=useState<Date|null>(null)
 const [error,setError]=useState(false)
 const [filter,setFilter]=useState('All games')
 const [retry,setRetry]=useState(0)
 const live=data?.hasLiveGames??false
 useEffect(()=>{
  let cancelled=false
  async function load(){try{const res=await fetch('/api/sweat',{cache:'no-store'});if(!res.ok)throw new Error();const body=await res.json();if(!cancelled){setData(body);setUpdated(new Date());setError(false)}}catch{if(!cancelled)setError(true)}}
  load();const timer=setInterval(load,live?30000:300000)
  return()=>{cancelled=true;clearInterval(timer)}
 },[live,retry])
 const name=(team:string)=>brandFor(team,teamBrands).shortName
 const summary=data?.summary
 const field=data?.players.length??0
 const visible=data?.allRevealed??false
 const stateLabels={in:'Live',pre:'Upcoming',post:'Final'}
 const ordered=[...(data?.games??[])].sort((a,b)=>({in:0,pre:1,post:2}[a.state]-{in:0,pre:1,post:2}[b.state])||new Date(a.kickoff).getTime()-new Date(b.kickoff).getTime())
 const games=ordered.filter(g=>filter==='All games'||stateLabels[g.state]===filter)
 return <div className={s.root} style={{minHeight:0}}><div className={s.pageHeading}><div><p className={s.context}>{data?.periodLabel??'College basketball survivor'}</p><h1>Sweatboard.</h1><p>Every score matters. See what it means for your pool.</p></div>{live&&<span className={s.sweatLive}><i/>{data?.games.filter(g=>g.state==='in').length} live</span>}</div>
 {error&&<p role="alert" className={s.privacyNotice}>{data?'Updates are unavailable. Showing the last received scores.':'Could not load the Sweatboard.'} <button className={s.textButton} onClick={()=>setRetry(retry+1)}>Try again</button></p>}
 {!data&&!error&&<p role="status" className={s.empty}>Loading the Sweatboard…</p>}
 {data&&<><div className={s.sweatControls}><div className={s.pills}>{['All games','Live','Final','Upcoming'].map(f=><button key={f} aria-pressed={filter===f} onClick={()=>setFilter(f)}>{f}</button>)}</div>{updated&&<span className={s.muted} style={{fontSize:11}}>Updated {updated.toLocaleTimeString('en-US',{timeZone:'America/Chicago',hour:'numeric',minute:'2-digit',timeZoneName:'short'})}</span>}</div>
 {!visible&&<p className={s.privacyNotice}>Team choices stay private until the daily deadline. {summary?.hidden??0} picks submitted; {summary?.pending??0} still to come.</p>}
 <dl className={s.sweatSummary} style={{gridTemplateColumns:'repeat(6,1fr)'}}>{[['Safe',summary?.safe],['Winning',summary?.winning],['Losing / tied',summary?.losing],['Out today',summary?.out],['Not started',summary?.notStarted],['No pick',summary?.noPick]].map(([label,value],index)=><div key={label} data-tone={index}><dt>{label}</dt><dd>{visible?value:'—'}</dd></div>)}</dl>
 <div className={s.sweatLayout}><section className={s.sweatGames} aria-label="Games affecting the pool">{games.map(game=>{
 const total=game.awayPlayers.length+game.homePlayers.length
 const risk=game.awayScore<game.homeScore?game.awayPlayers.length:game.homeScore<game.awayScore?game.homePlayers.length:total
 return <article className={s.sweatGame} key={game.id}><header><span className={game.state==='in'?s.sweatLive:s.muted}>{game.state==='in'&&<i/>}{game.state==='pre'?(game.statusText.toLowerCase().includes('tbd')?'Time TBD':new Date(game.kickoff).toLocaleString('en-US',{timeZone:'America/Chicago',weekday:'short',hour:'numeric',minute:'2-digit',timeZoneName:'short'})):game.statusText}</span><span>{[game.round,game.region].filter(Boolean).join(' · ')}</span></header>
 {(['away','home'] as const).map(side=>{
 const team=side==='away'?game.awayTeam:game.homeTeam
 const score=side==='away'?game.awayScore:game.homeScore
 const other=side==='away'?game.homeScore:game.awayScore
 const names=side==='away'?game.awayPlayers:game.homePlayers
 const seed=side==='away'?game.awaySeed:game.homeSeed
 const result=game.state==='pre'?'Waiting':game.state==='post'?(score>other?'Safe':'Out'):(score>other?'Winning':score===other?'Tied':'At risk')
 return <div key={side}><div className={s.sweatTeam}><Logo team={team} brands={teamBrands} size={40}/><div className={s.sweatTeamName}><strong>{seed?seed+' ':''}{name(team)}</strong><span>{visible?names.length+' entries'+(field?' · '+Math.round(names.length/field*100)+'% of field':''):'Picks hidden'}</span></div><span className={s.sweatResult} data-result={result}>{visible?result:'—'}</span><b className={s.sweatScore}>{game.state==='pre'?'—':score}</b></div>{visible&&names.length>0&&<details className="sweat-pickers"><summary>See {names.length} {names.length===1?'entry':'entries'} on {team}</summary><p>{names.join(' · ')}</p></details>}</div>
 })}
 {visible&&total>0&&<div className={s.exposureBar} aria-label={game.awayPlayers.length+' picks on '+game.awayTeam+', '+game.homePlayers.length+' on '+game.homeTeam}><span style={{flex:game.awayPlayers.length,background:brandFor(game.awayTeam,teamBrands).primary}}/><span style={{flex:game.homePlayers.length,background:brandFor(game.homeTeam,teamBrands).primary}}/></div>}
 <footer>{visible?(game.state==='in'?risk+' entries currently at risk.':game.state==='pre'?'Waiting for tip-off.':'Result final.'):'Picks reveal at the daily deadline.'}{visible&&<span>{total} picks</span>}</footer></article>
 })}{!games.length&&<div className={s.empty}><h2>{data.games.length?'No '+filter.toLowerCase()+' games':'No games yet'}</h2><p>{data.games.length?'Choose another filter.':'The Sweatboard will fill in when the next slate is available.'}</p></div>}</section>
 <aside className={s.poolPulse}><h2>The pool today</h2><div className={s.poolCount}><strong>{field}</strong><span>entries on this game day</span></div>{visible?<><div className={s.poolProgress}><span style={{width:(field?(summary?.safe??0)/field*100:0)+'%'}}/></div><p><b>{summary?.safe} are through.</b> {(summary?.winning??0)+(summary?.losing??0)+(summary?.notStarted??0)} await a game result.</p>{!!summary?.losing&&<div className={s.riskNote}><strong>{summary.losing} on the edge</strong><span>Their teams are behind or tied. A final win is needed to advance.</span></div>}{!!summary?.noPick&&<p>{summary.noPick} missed the deadline. Auto-assignment uses the day’s last game; entries with no unused team are eliminated.</p>}</>:<p>See where the field stands after picks lock.</p>}<Link className={s.textButton} href="/standings">View standings <Arrow/></Link></aside></div></>}
 </div>
}
