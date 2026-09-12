'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { brandFor, type TeamBrandDirectory } from '@/lib/teamBrand'
import { roundDisplay, type CompetitionMode } from '@/lib/competition'
import { Logo, Arrow, Ball } from '@/app/components/Sports'
import s from '@/app/components/sports.module.css'
export interface GameSide {
  team: string
  used: boolean
  /** "JAN 18" — when this team was spent. Null if it's still available. */
  usedOn: string | null
  /** Tournament seed. Null outside the bracket. */
  seed: number | null
  /** AP poll position. Null inside the bracket, where seed replaces it. */
  rank: number | null
  record: string | null
}

export interface GameRow {
  gameId: string
  kickoff: string // ISO UTC
  timeTbd: boolean
  round: string | null
  region: string | null
  venue: string | null
  tv: string | null
  away: GameSide
  home: GameSide
  deadline: string // ISO UTC
  locked: boolean
}

interface CurrentPick { team: string; deadline: string | null }
interface Props {
  slateId: string
  periodLabel: string
  pickHeading: string
  mode: CompetitionMode
  gameRows: GameRow[]
  usedTeams: string[]
  currentPick?: CurrentPick | null
  teamBrands: TeamBrandDirectory
}


export default function PickForm({slateId,periodLabel,gameRows,usedTeams,currentPick,teamBrands}:Props){
 const router=useRouter()
 const [selected,setSelected]=useState<string|null>(null)
 const [confirmed,setConfirmed]=useState(false)
 const [submitting,setSubmitting]=useState(false)
 const [error,setError]=useState('')
 const [saved,setSaved]=useState<string|null>(currentPick?.team??null)
 const [query,setQuery]=useState('')
 const [filter,setFilter]=useState('All games')
 const active=selected??saved
 const name=(team:string)=>brandFor(team,teamBrands).shortName
 const row=gameRows.find(g=>g.home.team===active||g.away.team===active)
 const deadline=row?.deadline??gameRows[0]?.deadline
 const time=(iso:string)=>new Date(iso).toLocaleString('en-US',{timeZone:'America/Chicago',hour:'numeric',minute:'2-digit'})+' CT'
 const filters=['All games','Available',...(gameRows.some(g=>g.away.rank||g.home.rank||g.away.seed||g.home.seed)?['Ranked']:[]),...(usedTeams.length?['Used teams']:[])]
 const shown=gameRows.filter(g=>[g.away,g.home].some(t=>(name(t.team)+' '+t.team).toLowerCase().includes(query.toLowerCase()))&&(filter==='Available'?!g.locked&&(!g.away.used||!g.home.used):filter==='Used teams'?g.away.used||g.home.used:filter==='Ranked'?g.away.rank||g.home.rank||g.away.seed||g.home.seed:true)).sort((a,b)=>Number(a.timeTbd)-Number(b.timeTbd)||new Date(a.kickoff).getTime()-new Date(b.kickoff).getTime())
 async function submit(){
  if(!selected||!confirmed||submitting)return
  setSubmitting(true);setError('')
  try{
   const response=await fetch('/api/picks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slate_id:slateId,team:selected})})
   const result=await response.json()
   if(!response.ok){setError(result.error||'Could not save your pick. Try again.');return}
   setSaved(selected);setConfirmed(false);router.refresh()
  }catch{setError('Could not save your pick. Check your connection and try again.')}finally{setSubmitting(false)}
 }
 return <div className={s.root} style={{minHeight:0}}><div className={s.pageHeading}><div><p className={s.context}>{periodLabel}</p><h1>One team. Your daily pick.</h1><p>Choose one team from the entire slate. A new pick replaces your previous one.</p></div></div>
 <div className={s.pickLayout}><section className={s.pickList}><div className={s.pickToolbar}><label className={s.search}><input type="search" aria-label="Find a team" placeholder="Find a team" value={query} onChange={e=>setQuery(e.target.value)}/></label><span>{shown.length} games · All times CT</span></div><div className={s.pickFilters} aria-label="Filter games">{filters.map(f=><button key={f} aria-pressed={filter===f} onClick={()=>setFilter(f)}>{f}</button>)}</div>
 <div role="radiogroup" aria-label="Your one team for the day" className={s.selectionGames}>{shown.map(game=><article className={s.selectionGame} key={game.gameId}><div className={s.selectionMeta}><b>{game.timeTbd?'Time TBD':time(game.kickoff)}</b><span>{game.tv}</span></div>{game.round&&<p className={s.venue}>{roundDisplay(game.round)} {game.region}</p>}
 {[game.away,game.home].map((side,index)=><button key={side.team} type="button" role="radio" aria-checked={active===side.team} disabled={game.locked||side.used||submitting} className={s.teamOption+' '+(active===side.team?s.teamSelected:'')} onClick={()=>{setSelected(side.team);setConfirmed(false);setError('')}}><Logo team={side.team} brands={teamBrands} size={40}/><span className={s.optionName}><strong>{side.seed?'('+side.seed+') ':side.rank?'#'+side.rank+' ':''}{name(side.team)}</strong><small>{side.record}<span>{index===0?'Away':'Home'}</span></small></span><span className={s.optionState}>{side.used?'Used'+(side.usedOn?' · '+side.usedOn:''):game.locked?'Locked':active===side.team?'Your pick':''}</span><span className={s.radioMark} aria-hidden="true">{active===side.team?'✓':''}</span></button>)}<p className={s.venue}>{game.venue??'Venue to be announced'}</p></article>)}</div>
 {!shown.length&&<div className={s.empty}><h2>No matching games</h2><p>Try another team or filter.</p><button className={s.secondary} onClick={()=>{setQuery('');setFilter('All games')}}>Reset filters</button></div>}</section>
 <aside className={s.selectionDesk+' '+(active?s.deskActive:'')}><div className={s.deskHeading}><h2>Your daily pick</h2><span>{active?'1':'0'} / 1</span></div><p className={s.deskDate}>{periodLabel}</p><div className={s.selectedTeam} aria-live="polite">{active?<><Logo team={active} brands={teamBrands} size={66}/><strong>{name(active)}</strong><span>{saved===active?'Pick saved':'Ready to confirm'}</span></>:<><span className={s.emptyBall}><Ball/></span><strong>The choice is yours.</strong><span>Select one available team.</span></>}</div>
 <div className={s.deadline}><div><span>All picks lock at the first tip</span><b>{deadline?new Date(deadline).toLocaleString('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}):'Deadline pending'}</b></div></div>
 {selected&&selected!==saved&&<label className={s.confirmation}><input type="checkbox" checked={confirmed} disabled={submitting} onChange={e=>setConfirmed(e.target.checked)}/><span>Confirm {name(selected)} as my one pick for this day.</span></label>}
 {error&&<p role="alert" className={s.privacyNotice}>{error}</p>}
 <button className={s.primary} disabled={!selected||selected===saved||!confirmed||submitting||row?.locked} onClick={submit}>{submitting?'Saving…':active&&saved===active?'Pick saved':saved?'Replace daily pick':'Confirm daily pick'}<Arrow/></button><p className={s.deskNote}>You can change your pick until the deadline. You still have just one pick for the day.</p></aside></div></div>
}
