'use client'
import {useEffect,useRef,useState} from 'react'
import type {LiveScoresResponse} from '@/app/api/live-scores/route'
import s from './sports.module.css'
const TICKER_PX_PER_SECOND=35
export default function LiveTicker({
  label,
}: {
  slateNumber?: number | null
  season?: number | null
  label?: string | null
}) {
  const [data, setData] = useState<LiveScoresResponse | null>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const [duration, setDuration] = useState(30)
  const [paused, setPaused] = useState(false)

  const hasLive = data?.hasLiveGames ?? false

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        const res = await fetch('/api/live-scores', { cache: 'no-store' })
        if (!res.ok) return
        const json = await res.json()
        if (cancelled) return
        setData(json)
      } catch {
        // silently fail — scores are non-critical
      }
    }

    load()
    const timer = setInterval(load, hasLive ? 30_000 : 5 * 60_000)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [hasLive])

  // Track is rendered as two back-to-back copies of the games list so the
  // scroll can loop seamlessly (translateX(-50%) lands exactly back at the
  // start of the second copy). Duration is derived from the measured width
  // of one copy so the scroll speed stays constant no matter how many games
  // are in the ticker.
  useEffect(() => {
    const track = trackRef.current
    if (!track) return
    const singleSetWidth = track.scrollWidth / 2
    if (singleSetWidth > 0) setDuration(singleSetWidth / TICKER_PX_PER_SECOND)
  }, [data?.games])

  // Don't render if no active slate or no games
  if (!data || data.games.length === 0) return null


 return <section className={s.ticker} aria-label="Live score scroll"><div className={s.tickerLabel}><span>Scoreboard</span><small>{data.hasLiveGames?'Games in progress':'College basketball'}</small><button onClick={()=>setPaused(!paused)} aria-label={paused?'Resume score scroll':'Pause score scroll'}>{paused?'Resume':'Pause'}</button></div><div className={s.tickerViewport} tabIndex={0} aria-label={label??'Game scores'}><div ref={trackRef} className={s.tickerTrack} style={{animationDuration:duration+'s',animationPlayState:paused?'paused':'running'}}>
 {[...data.games,...data.games].map((game,index)=><div className={s.tickerGame} key={game.id+'-'+index} aria-hidden={index>=data.games.length?true:undefined}><span className={s.tickerStatus} style={game.state==='in'?{color:'#b7443e'}:undefined}>{game.state==='pre'?(game.timeTbd?'Time TBD':new Date(game.kickoff).toLocaleString('en-US',{timeZone:'America/Chicago',hour:'numeric',minute:'2-digit'})+' CT'):game.statusText}</span>{(['away','home'] as const).map(side=><div key={side}><span className={s.logo} style={{width:20,height:20}}>
 {game[side+'Logo' as 'awayLogo'|'homeLogo']?(
 // eslint-disable-next-line @next/next/no-img-element
 <img src={game[side+'Logo' as 'awayLogo'|'homeLogo']!} width={20} height={20} alt=""/>
 ):null}</span><b>{side==='away'?game.awayTeam:game.homeTeam}</b><strong>{game.state!=='pre'&&game.scoresKnown!==false?(side==='away'?game.awayScore:game.homeScore):'—'}</strong></div>)}</div>)}
 </div></div></section>
}
