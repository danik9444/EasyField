import { useEffect, useState } from 'react'
import { RELEASES_URL } from '@/content'

type ReleaseState =
  | { status: 'checking'; url: string; version: null }
  | { status: 'available'; url: string; version: string | null }
  | { status: 'unavailable'; url: string; version: null }

interface GitHubAsset {
  name?: string
  browser_download_url?: string
}

interface GitHubRelease {
  tag_name?: string
  html_url?: string
  draft?: boolean
  assets?: GitHubAsset[]
}

const API_URL = 'https://api.github.com/repos/danik9444/EasyField/releases/latest'

export function useRelease(): ReleaseState {
  const environment = typeof import.meta.env === 'object' ? import.meta.env : undefined
  const configuredUrl = environment?.VITE_EASYFIELD_DOWNLOAD_URL?.trim()
  const canCheckRelease = window.location.protocol === 'http:' || window.location.protocol === 'https:'
  const [release, setRelease] = useState<ReleaseState>(() => configuredUrl
    ? { status: 'available', url: configuredUrl, version: null }
    : canCheckRelease
      ? { status: 'checking', url: RELEASES_URL, version: null }
      : { status: 'unavailable', url: RELEASES_URL, version: null })

  useEffect(() => {
    if (configuredUrl || !canCheckRelease) return

    const controller = new AbortController()
    let active = true
    const timeout = window.setTimeout(() => controller.abort(), 4_500)

    fetch(API_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json' },
    })
      .then(async (response) => {
        if (response.status === 404) return null
        if (!response.ok) throw new Error(`GitHub release check failed (${response.status})`)
        return response.json() as Promise<GitHubRelease>
      })
      .then((result) => {
        if (!active) return

        if (!result || result.draft) {
          setRelease({ status: 'unavailable', url: RELEASES_URL, version: null })
          return
        }

        const installer = result.assets?.find((asset) => /macos-universal.*\.pkg$/i.test(asset.name ?? ''))

        if (!installer?.browser_download_url) {
          setRelease({ status: 'unavailable', url: result.html_url ?? RELEASES_URL, version: null })
          return
        }

        const version = (result.tag_name ?? 'latest').replace(/^v/i, '')
        setRelease({ status: 'available', url: installer.browser_download_url, version })
      })
      .catch(() => {
        if (active) {
          setRelease({ status: 'unavailable', url: RELEASES_URL, version: null })
        }
      })
      .finally(() => window.clearTimeout(timeout))

    return () => {
      active = false
      window.clearTimeout(timeout)
      controller.abort()
    }
  }, [canCheckRelease, configuredUrl])

  return release
}
