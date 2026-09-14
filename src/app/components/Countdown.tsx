'use client'
import { useEffect,useState } from 'react'
export default function Countdown({deadline}:{deadline:string}){const [v,setV]=useState('00:00:00');useEffect(()=>{const f=()=>{const d=Math.max(0,new Date(deadline).getTime()-Date.now());const h=Math.floor(d/36e5);const m=Math.floor(d%36e5/6e4);const s=Math.floor(d%6e4/1e3);setV([h,m,s].map(n=>String(n).padStart(2,'0')).join(':'))};f();const id=setInterval(f,1000);return()=>clearInterval(id)},[deadline]);return <b>{v}</b>}
