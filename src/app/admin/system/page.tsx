import SystemView from './[view]/page'
export default function SystemOverview() {
  return (
    <SystemView
      params={Promise.resolve({ view: 'overview' })}
      searchParams={Promise.resolve({})}
    />
  )
}
