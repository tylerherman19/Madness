'use client'
import {useEffect,useRef,useState} from 'react'
import type {LiveScoresResponse} from '@/app/api/live-scores/route'
import s from './sports.module.css'
const SPEED=35,RESUME_AFTER=2600
export default function LiveTicker({label}:{slateNumber?:number|null;season?:number|null;label?:string|null}){
 const [data,setData]=useState<LiveScoresResponse|null>(null),[paused,setPaused]=useState(false)
 const viewport=useRef<HTMLDivElement>(null),raf=useRef(0),last=useRef(0),idle=useRef(0),interacting=useRef(false),mouseDrag=useRef({active:false,x:0,left:0})
 const hasLive=data?.hasLiveGames??false
 useEffect(()=>{let dead=false;const load=async()=>{try{const r=await fetch('/api/live-scores',{cache:'no-store'});if(r.ok&&!dead)setData(await r.json())}catch{}};load();const id=setInterval(load,hasLive?30000:300000);return()=>{dead=true;clearInterval(id)}},[hasLive])
 useEffect(()=>{const el=viewport.current;if(!el||paused)return;const tick=(now:number)=>{if(!last.current)last.current=now;const dt=Math.min(40,now-last.current);last.current=now;if(!interacting.current&&now>idle.current){el.scrollLeft+=SPEED*dt/1000;const half=el.scrollWidth/2;if(el.scrollLeft>=half)el.scrollLeft-=half}raf.current=requestAnimationFrame(tick)};raf.current=requestAnimationFrame(tick);return()=>{cancelAnimationFrame(raf.current);last.current=0}},[paused,data])
 useEffect(()=>{const el=viewport.current;if(!el)return
  const stop=()=>{interacting.current=true;idle.current=Infinity}
  const resume=()=>{interacting.current=false;idle.current=performance.now()+3000}
  const wheel=()=>{stop();window.setTimeout(resume,140)}
  el.addEventListener('touchstart',stop,{passive:true})
  el.addEventListener('touchend',resume,{passive:true})
  el.addEventListener('touchcancel',resume,{passive:true})
  el.addEventListener('wheel',wheel,{passive:true})
  return()=>{el.removeEventListener('touchstart',stop);el.removeEventListener('touchend',resume);el.removeEventListener('touchcancel',resume);el.removeEventListener('wheel',wheel)}
 },[])
 if(!data?.games.length)return null
 const games=[...data.games,...data.games]
 return <section className={s.ticker} aria-label="Live score scroll"><div className={s.tickerLabel}><span>Scoreboard</span><small>{hasLive?'Games in progress':'College basketball'}</small><button onClick={()=>setPaused(!paused)}>{paused?'Resume':'Pause'}</button></div><div ref={viewport} className={s.tickerViewport} tabIndex={0} aria-label={label??'Game scores'} onPointerDown={e=>{if(e.pointerType==='mouse'){e.currentTarget.setPointerCapture(e.pointerId);mouseDrag.current={active:true,x:e.clientX,left:e.currentTarget.scrollLeft};interacting.current=true;idle.current=Infinity}}} onPointerMove={e=>{if(mouseDrag.current.active)e.currentTarget.scrollLeft=mouseDrag.current.left+mouseDrag.current.x-e.clientX}} onPointerUp={()=>{mouseDrag.current.active=false;interacting.current=false;idle.current=performance.now()+3000}} onPointerCancel={()=>{mouseDrag.current.active=false;interacting.current=false;idle.current=performance.now()+3000}}><div className={s.tickerTrack}>{games.map((g,i)=><div className={s.tickerGame} key={g.id+'-'+i} aria-hidden={i>=data.games.length||undefined}><span className={s.tickerStatus} style={g.state==='in'?{color:'#b7443e'}:undefined}>{g.state==='pre'?(g.timeTbd?'Time TBD':new Date(g.kickoff).toLocaleString('en-US',{timeZone:'America/Chicago',hour:'numeric',minute:'2-digit'})+' CT'):g.statusText}</span>{(['away','home'] as const).map(side=><div key={side}><span className={s.logo} style={{width:20,height:20}}>{g[side+'Logo' as 'awayLogo'|'homeLogo']&&<img src={g[side+'Logo' as 'awayLogo'|'homeLogo']!} width={20} height={20} alt=""/>}</span><b>{side==='away'?g.awayTeam:g.homeTeam}</b><strong>{g.state!=='pre'&&g.scoresKnown!==false?(side==='away'?g.awayScore:g.homeScore):'-'}</strong></div>)}</div>)}</div></div></section>
}
