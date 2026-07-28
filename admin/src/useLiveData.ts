import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Near-real-time data for one panel.
 *
 * Supabase Realtime is deliberately not used here. Every client RLS policy in
 * this schema is select-own, and the schema states outright that a platform
 * role never bypasses RLS from the client — so an operator subscribing directly
 * would receive only their own rows. Making Realtime work would mean granting
 * broad admin read policies across thirteen tables, which would replace one
 * audited server path with thirteen silent ones.
 *
 * So the console polls the trusted server instead, and says so on screen. The
 * freshness indicator exists because "real time" that is quietly ten minutes
 * stale is worse than a number with a timestamp next to it.
 */

export type LiveState<T> =
  | { status: 'loading'; data: null; error: null; updatedAt: null }
  | { status: 'ready'; data: T; error: null; updatedAt: number }
  // A failed refresh keeps the last good value. An operator triaging an
  // incident should not lose the screen because one poll timed out.
  | { status: 'stale'; data: T | null; error: string; updatedAt: number | null }

export interface LiveResult<T> {
  readonly state: LiveState<T>
  readonly refresh: () => void
  readonly paused: boolean
}

export function useLiveData<T>(
  load: () => Promise<T>,
  intervalMs: number,
  dependencies: readonly unknown[] = [],
): LiveResult<T> {
  const [state, setState] = useState<LiveState<T>>({
    status: 'loading',
    data: null,
    error: null,
    updatedAt: null,
  })
  const [paused, setPaused] = useState(() => document.visibilityState === 'hidden')

  // Held in a ref so changing the loader between renders cannot leave an older
  // closure scheduled, and so the interval effect does not restart on every
  // render just because the caller passed a fresh arrow function.
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  })

  const generation = useRef(0)
  const latest = useRef<LiveState<T>>(state)
  latest.current = state

  const run = useCallback(async () => {
    const ticket = ++generation.current
    try {
      const data = await loadRef.current()
      // A response that arrives after a newer request started is discarded.
      // Without this a slow poll can overwrite a fresh one and the screen goes
      // backwards in time.
      if (ticket !== generation.current) return
      setState({ status: 'ready', data, error: null, updatedAt: Date.now() })
    } catch (error) {
      if (ticket !== generation.current) return
      const message = error instanceof Error ? error.message : 'Request failed'
      const previous = latest.current
      setState({
        status: 'stale',
        data: previous.data,
        error: message,
        updatedAt: previous.updatedAt,
      })
    }
  }, [])

  useEffect(() => {
    const onVisibility = () => {
      const hidden = document.visibilityState === 'hidden'
      setPaused(hidden)
      // Refresh immediately on return rather than waiting out the interval,
      // so a console left in the background is current the moment it is read.
      if (!hidden) void run()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [run])

  useEffect(() => {
    setState({ status: 'loading', data: null, error: null, updatedAt: null })
    void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies)

  useEffect(() => {
    if (paused) return
    const timer = setInterval(() => void run(), intervalMs)
    return () => clearInterval(timer)
  }, [paused, intervalMs, run])

  // Invalidate any in-flight response on unmount so a late resolution cannot
  // call setState on a gone component.
  useEffect(() => () => {
    generation.current += 1
  }, [])

  return { state, refresh: run, paused }
}

/**
 * Poll cadences, chosen by how quickly staleness would mislead rather than by
 * how interesting the data is. Money movement and stuck work are checked often;
 * catalogues and history barely change.
 */
export const POLL = {
  fast: 4_000,
  medium: 20_000,
  slow: 60_000,
} as const
