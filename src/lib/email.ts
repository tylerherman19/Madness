// Shared compatibility helpers. All outbound requests are owned by notificationWorker.
export {FROM_EMAIL,esc} from './delivery'
export const SEND_DELAY_MS=650
export async function sleep(ms:number){await new Promise(resolve=>setTimeout(resolve,ms))}
export function isDeliverable(email:string){return !email.endsWith('@nflsurvivor.internal')}
