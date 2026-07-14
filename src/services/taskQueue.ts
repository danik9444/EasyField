// Concurrency and start-rate limiters for kie.ai's request budget
// (20 new generation requests / 10s). Everything funnels through these:
//  - jobLimit    caps concurrent generation jobs (fan-out of N images/clips)
//  - generationStartLimit spaces provider task creation across the rolling window
//  - uploadLimit caps concurrent file uploads (a model can take up to ~14 refs)
// Combined with the transport's retry-on-429, bursts are smoothed, not dropped.

export function createLimiter(max: number) {
  const limit = Math.max(1, Math.floor(max))
  let active = 0
  interface WaitingTicket {
    start: () => void
    cancel: () => void
    signal?: AbortSignal
  }
  const waiting: WaitingTicket[] = []
  const drain = () => {
    while (active < limit && waiting.length) {
      const ticket = waiting.shift()!
      ticket.signal?.removeEventListener('abort', ticket.cancel)
      ticket.start()
    }
  }
  const release = () => {
    active--
    drain()
  }
  return function run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let queued = false
      let settled = false
      let ticket: WaitingTicket
      const cancel = () => {
        if (!queued || settled) return
        const index = waiting.indexOf(ticket)
        if (index >= 0) waiting.splice(index, 1)
        queued = false
        settled = true
        reject(new Error('Cancelled'))
        drain()
      }
      const start = () => {
        if (settled) return
        queued = false
        if (signal?.aborted) {
          settled = true
          reject(new Error('Cancelled'))
          drain()
          return
        }
        active++
        fn().then(resolve, reject).finally(() => {
          settled = true
          release()
        })
      }
      ticket = { start, cancel, signal }
      if (signal?.aborted) {
        settled = true
        reject(new Error('Cancelled'))
      } else if (active < limit) {
        start()
      } else {
        queued = true
        waiting.push(ticket)
        signal?.addEventListener('abort', cancel, { once: true })
      }
    })
  }
}

// Run `fn` over items with at most `limit` in flight; preserves input order.
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const run = createLimiter(Math.max(1, limit))
  return Promise.all(items.map((item, i) => run(() => fn(item, i))))
}

function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('Cancelled'))
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    const abort = () => {
      clearTimeout(timer)
      reject(new Error('Cancelled'))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/** Reserve starts in a strict rolling window without limiting total batch size. */
export function createStartRateLimiter(maxStarts: number, windowMs: number) {
  const starts: number[] = []
  let reservationTail: Promise<void> = Promise.resolve()

  const reserve = async (signal?: AbortSignal) => {
    const limit = Math.max(1, Math.floor(maxStarts))
    const window = Math.max(1, Math.floor(windowMs))
    while (true) {
      if (signal?.aborted) throw new Error('Cancelled')
      const now = Date.now()
      while (starts.length && starts[0] <= now - window) starts.shift()
      if (starts.length < limit) {
        starts.push(now)
        return
      }
      await waitFor(Math.max(1, starts[0] + window - now), signal)
    }
  }

  return function run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const reservation = reservationTail.then(() => reserve(signal))
    reservationTail = reservation.catch(() => { /* a cancelled ticket must not block later work */ })
    return reservation.then(fn)
  }
}

export const jobLimit = createLimiter(6)
export const uploadLimit = createLimiter(4)
export const generationStartLimit = createStartRateLimiter(20, 10_000)
