import Link from 'next/link'
import { brandFor, type TeamBrandDirectory } from '@/lib/teamBrand'
import s from './sports.module.css'
export function Ball(){return <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="20" cy="20" r="17"/><path d="M3 20h34M20 3v34M8 8c15 7 15 17 24 24M32 8C17 15 17 25 8 32"/></svg>}
export function Arrow(){return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>}
export function Logo({team,brands,size=34}:{team:string;brands:TeamBrandDirectory;size?:number}){
 const brand=brandFor(team,brands)
 return <span className={s.logo} style={{width:size,height:size,color:brand.primary}}>{brand.logo?(
 // eslint-disable-next-line @next/next/no-img-element
 <img src={brand.logo} alt="" width={size} height={size}/>
 ):<b>{team.slice(0,3)}</b>}</span>
}
export function Footer(){return <footer className={s.footer}><span>madness. <small>One pick. Every game day.</small></span><Link href="/standings#rules">Pool rules</Link><Link href="/grid">Pick grid</Link><Link href="/history">My picks & alerts</Link><Link href="/admin/login">Admin</Link></footer>}
