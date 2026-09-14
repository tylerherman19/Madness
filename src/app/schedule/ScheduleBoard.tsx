'use client'
import { useEffect,useState } from 'react'
import Link from 'next/link'
import type {ScheduleDay} from './page'
import type {LiveScoresResponse} from '@/app/api/live-scores/route'
import {brandFor,type TeamBrandDirectory} from '@/lib/teamBrand'
import {Logo,Arrow} from '@/app/components/Sports'
import s from '@/app/components/sports.module.css'
import {american,point} from '@/lib/oddsFormat'
export default function ScheduleBoard({days,season,brands}:{days:ScheduleDay[];season:number;brands:TeamBrandDirectory}){
 const [date,setDate]=useState(days.find(d=>d.games.length)?.date??days[0]?.date??'')
 const [query,setQuery]=useState('')
 const [live,setLive]=useState<LiveScoresResponse|null>(null)
 useEffect(()=>{let cancelled=false;async function load(){try{const res=await fetch('/api/live-scores',{cache:'no-store'});if(res.ok){const json=await res.json();if(!cancelled)setLive(json)}}catch{/* scheduled games stay available */}}load();const timer=setInterval(load,30000);return()=>{cancelled=true;clearInterval(timer)}},[])
 const day=days.find(d=>d.date===date)
 const name=(team:string)=>brandFor(team,brands).shortName
 const games=(day?.games??[]).filter(g=>(name(g.awayAbbr)+' '+name(g.homeAbbr)+' '+g.awayAbbr+' '+g.homeAbbr).toLowerCase().includes(query.toLowerCase()))
 return <><div className={s.pageHeading}><div><p className={s.context}>College basketball · {season} season</p><h1>Every game, at a glance.</h1><p>Scores, the next slate, and your path through the season.</p></div><Link href="/pick" className={s.secondary}>Make daily pick <Arrow/></Link></div>
 <div className={s.dateBar} style={{overflowX:'auto'}}>{days.map(d=><button key={d.date} aria-pressed={date===d.date} onClick={()=>setDate(d.date)} style={{flexShrink:0}}><small>{new Date(d.date+'T12:00:00').toLocaleDateString('en-US',{weekday:'short'})}</small><strong>{Number(d.date.slice(-2))}</strong><span>{new Date(d.date+'T12:00:00').toLocaleDateString('en-US',{month:'short'})}</span></button>)}</div>
 <div className={s.sectionTitle}><h2>{day?.label??'Schedule'}</h2><label className={s.search}><input type="search" aria-label="Find a team" placeholder="Find a team" value={query} onChange={e=>setQuery(e.target.value)}/></label></div>
 {!games.length?<div className={s.empty}><h2>{query?'No matching teams':'No games scheduled'}</h2><p>{query?'Try another team name.':'Check another day for upcoming matchups.'}</p></div>:<div className={s.scoreGrid}>{games.map((game,index)=>{
 const result=live?.games.find(g=>g.homeTeam===game.homeAbbr&&g.awayTeam===game.awayAbbr&&g.kickoff.slice(0,10)===game.kickoff.slice(0,10))
 return <article className={s.scoreCard} key={game.awayAbbr+game.homeAbbr+index}><div className={s.scoreMeta}><span>{result&&result.state!=='pre'?result.statusText:game.timeTbd?'Time TBD':new Date(game.kickoff).toLocaleTimeString('en-US',{timeZone:'America/Chicago',hour:'numeric',minute:'2-digit'})+' CT'}</span><small>{game.tv}</small></div>{[game.awayAbbr,game.homeAbbr].map((team,i)=><div className={s.scoreTeam} key={team}><Logo team={team} brands={brands} size={38}/><div><strong>{name(team)}</strong><small>{game.round?[(i===0?game.awaySeed:game.homeSeed)&&'Seed '+(i===0?game.awaySeed:game.homeSeed),game.region].filter(Boolean).join(' · '):i===0?'Away':'Home'}</small></div><b>{result&&result.state!=='pre'&&result.scoresKnown!==false?(i===0?result.awayScore:result.homeScore):game.odds?american(i===0?game.odds.awayMoneyline:game.odds.homeMoneyline):'—'}</b></div>)}<p>{game.odds?`Spread ${point(game.odds.spreadHome)} · O/U ${game.odds.total??'—'} · ${game.odds.bookmaker}`:(game.round??'College basketball')} · All times Central</p></article>
 })}</div>}<p className={s.tableNote}>Live scores refresh automatically when available. Unannounced tip times remain TBD.</p></>
}
