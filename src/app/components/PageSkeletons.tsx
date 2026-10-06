import { Bone, SkeletonRegion, times } from './Skeleton'
import s from './sports.module.css'

// Route-level loading layouts. Each mirrors its page's real structure so the
// page fills in place instead of jumping when data arrives.

export function TickerSkeleton() {
  return (
    <div className={s.ticker} aria-hidden="true">
      <div className={s.tickerLabel}>
        <Bone w={78} h={12} />
        <Bone w={54} h={10} style={{ marginTop: 10 }} />
      </div>
      <div className="flex flex-1 gap-6 overflow-hidden px-4 py-4">
        {times(6, (i) => (
          <div key={i} className="flex w-36 shrink-0 flex-col gap-2">
            <Bone w={58} h={9} />
            <Bone w="100%" h={14} />
            <Bone w="100%" h={14} />
          </div>
        ))}
      </div>
    </div>
  )
}

function HeadingSkeleton({ action = false }: { action?: boolean }) {
  return (
    <div className="flex items-end justify-between gap-4 pb-6 pt-2">
      <div className="flex flex-col gap-3">
        <Bone w={120} h={12} />
        <Bone w={280} h={34} />
      </div>
      {action && <Bone w={150} h={44} className="hidden sm:block" />}
    </div>
  )
}

function GameCardSkeleton() {
  return (
    <div className="skeleton-card flex flex-col gap-4 p-4">
      <div className="flex justify-between"><Bone w={70} h={10} /><Bone w={40} h={10} /></div>
      {times(2, (i) => (
        <div key={i} className="flex items-center gap-3">
          <Bone w={36} h={36} round />
          <div className="flex flex-1 flex-col gap-2"><Bone w="55%" h={13} /><Bone w="25%" h={9} /></div>
          <Bone w={18} h={14} />
        </div>
      ))}
    </div>
  )
}

export function HomeSkeleton() {
  return (
    <SkeletonRegion label="Loading the pool">
      <Bone w="100%" h="clamp(230px, 34vw, 372px)" style={{ borderRadius: 10 }} />
      <div className="skeleton-card mt-4 grid grid-cols-2 gap-6 p-5 sm:grid-cols-4">
        {times(4, (i) => (
          <div key={i} className="flex flex-col gap-3"><Bone w={80} h={11} /><Bone w={64} h={28} /></div>
        ))}
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="skeleton-card min-w-0 p-5">
          <div className="mb-5 flex justify-between"><Bone w={140} h={20} /><Bone w={100} h={14} /></div>
          {times(5, (i) => (
            <div key={i} className="flex items-center justify-between gap-4 border-t py-5" style={{ borderColor: 'var(--line)' }}>
              <Bone w={56} h={13} />
              <div className="flex min-w-0 flex-1 items-center justify-center gap-3"><Bone w={28} h={28} round /><Bone w="30%" h={13} /><Bone w={28} h={28} round /><Bone w="30%" h={13} /></div>
              <Bone w={24} h={13} />
            </div>
          ))}
        </div>
        <div className="skeleton-card flex h-fit flex-col gap-4 p-6">
          <Bone w={110} h={11} />
          <Bone w={150} h={30} />
          <Bone w={160} h={12} />
          <Bone w="100%" h={1} />
          <Bone w={120} h={11} />
          <Bone w={170} h={16} />
        </div>
      </div>
    </SkeletonRegion>
  )
}

export function ScheduleSkeleton() {
  return (
    <SkeletonRegion label="Loading the schedule">
      <HeadingSkeleton action />
      <div className="flex gap-2 overflow-hidden pb-6">
        {times(7, (i) => <Bone key={i} w={80} h={84} style={{ borderRadius: 8 }} />)}
      </div>
      <div className="mb-4 flex items-center justify-between"><Bone w={90} h={16} /><Bone w={185} h={40} /></div>
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{times(6, (i) => <GameCardSkeleton key={i} />)}</div>
    </SkeletonRegion>
  )
}

export function StandingsSkeleton() {
  return (
    <SkeletonRegion label="Loading standings">
      <div className="workspace-heading"><Bone w={220} h={36} /><Bone w={130} h={44} /></div>
      <div className="mt-6 flex justify-end"><Bone w={160} h={34} round /></div>
      <div className="skeleton-card mt-3 overflow-hidden">
        <div className="flex justify-between px-4 py-3" style={{ background: 'var(--surface-sunken)' }}>
          <Bone w={60} h={11} /><Bone w={140} h={11} />
        </div>
        {times(8, (i) => (
          <div key={i} className="flex items-center justify-between border-t px-4 py-3.5" style={{ borderColor: 'var(--line)' }}>
            <Bone w={`${30 + ((i * 17) % 25)}%`} h={14} />
            <div className="flex gap-6"><Bone w={56} h={22} round /><Bone w={56} h={22} round /></div>
          </div>
        ))}
      </div>
    </SkeletonRegion>
  )
}

export function GridSkeleton() {
  return (
    <SkeletonRegion label="Loading the pick grid">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div className="flex flex-col gap-3"><Bone w={200} h={44} /><Bone w={260} h={13} /></div>
        <Bone w={140} h={40} />
      </div>
      <div className="skeleton-card overflow-hidden p-1">
        {times(10, (i) => (
          <div key={i} className="flex items-center gap-2 border-b px-2 py-2" style={{ borderColor: 'var(--line)' }}>
            <Bone w={140} h={13} />
            {times(8, (j) => <Bone key={j} w={44} h={24} />)}
          </div>
        ))}
      </div>
    </SkeletonRegion>
  )
}

export function PickSkeleton() {
  return (
    <SkeletonRegion label="Loading your pick">
      <div className="flex flex-col gap-3 pb-6"><Bone w={130} h={12} /><Bone w={360} h={40} /></div>
      <div className="skeleton-card mb-5 flex items-center justify-between p-4">
        <div className="flex flex-col gap-2"><Bone w={70} h={13} /><Bone w={50} h={10} /></div>
        <Bone w={150} h={44} />
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_310px]">
        <div>
          <div className="mb-4 flex gap-2">{times(3, (i) => <Bone key={i} w={96} h={36} round />)}</div>
          <div className="grid gap-4 sm:grid-cols-2">{times(6, (i) => <GameCardSkeleton key={i} />)}</div>
        </div>
        <div className="skeleton-card flex h-fit flex-col items-center gap-4 p-6">
          <Bone w="60%" h={18} style={{ alignSelf: 'flex-start' }} />
          <Bone w={56} h={56} round />
          <Bone w="70%" h={18} />
          <Bone w="100%" h={1} />
          <Bone w="100%" h={50} />
          <Bone w="100%" h={46} />
        </div>
      </div>
    </SkeletonRegion>
  )
}

export function LiveBoardSkeleton({ label = 'Loading the Sweatboard', heading = true }: { label?: string; heading?: boolean }) {
  return (
    <SkeletonRegion label={label}>
      {heading && <div className="flex flex-col gap-3 pb-6"><Bone w={130} h={12} /><Bone w={240} h={36} /></div>}
      <div className="mb-5 flex gap-2">{times(4, (i) => <Bone key={i} w={80} h={36} round />)}</div>
      <div className="mb-6 grid grid-cols-3 gap-4 sm:grid-cols-6">
        {times(6, (i) => <div key={i} className="flex flex-col gap-3"><Bone w={70} h={11} /><Bone w={28} h={22} /></div>)}
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="grid gap-4">{times(3, (i) => <GameCardSkeleton key={i} />)}</div>
        <div className="skeleton-card flex h-fit flex-col gap-4 p-6"><Bone w={130} h={18} /><Bone w={60} h={36} /><Bone w="100%" h={8} round /><Bone w="80%" h={12} /></div>
      </div>
    </SkeletonRegion>
  )
}

export function HistorySkeleton() {
  return (
    <SkeletonRegion label="Loading your pick history">
      <Bone w={260} h={48} style={{ marginBottom: 32 }} />
      <div className="skeleton-card mb-8 grid grid-cols-3">
        {times(3, (i) => <div key={i} className="flex flex-col items-center gap-2 p-4"><Bone w={60} h={30} /><Bone w={50} h={10} /></div>)}
      </div>
      <div className="flex flex-col gap-2">
        {times(5, (i) => (
          <div key={i} className="skeleton-card flex items-center justify-between gap-4 px-4 py-4">
            <div className="flex items-center gap-3"><Bone w={28} h={28} round /><div className="flex flex-col gap-2"><Bone w={80} h={10} /><Bone w={120} h={14} /></div></div>
            <Bone w={50} h={12} />
          </div>
        ))}
      </div>
    </SkeletonRegion>
  )
}

export function AdminSkeleton() {
  return (
    <SkeletonRegion label="Loading" className="mx-auto max-w-4xl px-4 py-8">
      <Bone w={240} h={30} />
      <Bone w={180} h={14} style={{ marginTop: 10 }} />
      <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {times(4, (i) => <div key={i} className="skeleton-card flex flex-col items-center gap-3 p-4"><Bone w={80} h={10} /><Bone w={44} h={24} /></div>)}
      </div>
      <div className="skeleton-card mt-8 overflow-hidden">
        {times(7, (i) => (
          <div key={i} className="flex items-center justify-between gap-4 border-b px-4 py-3.5" style={{ borderColor: 'var(--line)' }}>
            <Bone w={`${28 + ((i * 13) % 30)}%`} h={13} /><Bone w={60} h={13} />
          </div>
        ))}
      </div>
    </SkeletonRegion>
  )
}
