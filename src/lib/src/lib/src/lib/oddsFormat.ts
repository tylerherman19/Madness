export type GameOdds={homeTeam:string;awayTeam:string;commenceTime:string;spreadHome:number|null;spreadAway:number|null;total:number|null;homeMoneyline:number|null;awayMoneyline:number|null;bookmaker:string|null;updatedAt:string|null}
export const american=(n:number|null)=>n==null?'—':n>0?`+${n}`:`${n}`
export const point=(n:number|null)=>n==null?'—':n>0?`+${n}`:`${n}`
