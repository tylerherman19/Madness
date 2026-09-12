'use client'
import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import LogoutButton from './LogoutButton'
import { Ball } from './Sports'
import type { CompetitionMode } from '@/lib/competition'
import s from './sports.module.css'

const links = [
 {href:'/',label:'Overview',icon:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z'},
 {href:'/pick',label:'Daily pick',icon:'m5 12 4 4L19 6 M4 3h16v18H4z'},
 {href:'/schedule',label:'Scores',icon:'M3 12h4l3-7 4 14 3-7h4'},
 {href:'/live',label:'Sweatboard',icon:'M3 17 8 7l4 7 4-11 5 14 M3 21h18'},
 {href:'/standings',label:'Standings',icon:'M5 20V10h4v10 M10 20V4h4v16 M15 20v-7h4v7'},
]
export default function SiteHeader({signupsClosed=false,account}:{signupsClosed?:boolean;mode?:CompetitionMode;account?:string}) {
 const path=usePathname()
 const [open,setOpen]=useState(false)
 return <><header className={s.header}><div className={s.headerInner}>
 <Link className={s.wordmark} href="/" aria-label="Madness overview"><span className={s.brandIcon}><Ball/></span>madness<span className={s.brandDot}>.</span></Link>
 <nav className={s.desktopNav} aria-label="Main navigation">{links.map(link=><Link key={link.href} href={link.href} aria-current={path===link.href?'page':undefined}>{link.label}</Link>)}</nav>
 <div className="account-menu"><button className={s.profile} aria-expanded={open} aria-controls="account-links" onClick={()=>setOpen(!open)}>My entry<span className={s.avatar}>{account?account.split(' ').map(n=>n[0]).slice(0,2).join(''):'↗'}</span></button>
 {open&&<nav id="account-links" className="account-links" aria-label="Your entry"><Link href="/pick">Your daily pick</Link><Link href="/history">Pick history & alerts</Link><Link href="/grid">Full pick grid</Link><Link href="/standings#rules">Pool rules</Link>{account?<LogoutButton/>:<><Link href="/login">Log in</Link>{!signupsClosed&&<Link href="/signup">Join pool</Link>}</>}</nav>}</div>
 </div></header><nav className={s.mobileNav} aria-label="Mobile navigation">{links.map(link=><Link href={link.href} key={link.href} aria-current={path===link.href?'page':undefined}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d={link.icon}/></svg>{link.label}</Link>)}</nav></>
}
