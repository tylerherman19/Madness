import SiteHeader from './SiteHeader'
import TrustFooter from './TrustFooter'
import s from './sports.module.css'

export default function InfoPage({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className={s.root}>
    <SiteHeader />
    <main id="main" className="info-page"><p className="eyebrow">MADNESS · College Basketball Survivor</p><h1>{title}</h1>{children}</main>
    <TrustFooter />
  </div>
}
