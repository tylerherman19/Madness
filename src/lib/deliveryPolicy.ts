export function deliveryFailure(
  status: number,
  name: string,
  attempt: number,
  retryAfter?: string | null,
) {
  const retry = Math.min(3600, 30 * 2 ** Math.min(attempt, 7))
  if (
    status === 401 ||
    status === 403 ||
    /quota|credit|daily|monthly/i.test(name)
  )
    return {
      state: 'review',
      code: 'provider-configuration-or-quota',
      delay: 3600,
      pause: true,
    }
  if (status === 429)
    return {
      state: 'pending',
      code: 'provider-rate-limit',
      delay: Math.max(retry, Number(retryAfter) || (retryAfter?Math.max(0,Math.ceil((Date.parse(retryAfter)-Date.now())/1000)):0) || 0),
      pause: true,
    }
  if (status >= 400 && status < 500 && status !== 408 && status !== 409)
    return {
      state: 'review',
      code: 'permanent-provider-rejection',
      delay: 0,
      pause: false,
    }
  return {
    state: 'pending',
    code: 'provider-outcome-uncertain',
    delay: retry,
    pause: false,
  }
}
