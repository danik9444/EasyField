import { useEffect, useState } from 'react'
import { RELEASES_URL } from '@/content'

type ReleaseState =
  | { status: 'checking'; url: string; version: null }
  | { status: 'available'; url: string; version: string | null }
  | { status: 'unavailable'; url: string; version: null }

interface GitHubAsset {
  browser_download_url?: string
}

interface GitHubRelease {
  draft?: boolean
  assets?: GitHubAsset[]
}

const API_URL = 'https://api.github.com/repos/danik9444/EasyField/releases/latest'
const RELEASE_ASSET_PATH = /^\/danik9444\/EasyField\/releases\/download\/v(\d+\.\d+\.\d+)\/EasyField-\1-macOS-universal\.pkg$/

function parseReleaseAssetUrl(value: string | undefined): { url: string; version: string } | null {
  if (!value) return null

  try {
    const url = new URL(value.trim())
    const pathMatch = url.pathname.match(RELEASE_ASSET_PATH)

    if (
      url.protocol !== 'https:'
      || url.hostname !== 'github.com'
      || url.port
      || url.username
      || url.password
      || url.search
      || url.hash
      || !pathMatch
    ) {
      return null
    }

    return { url: url.href, version: pathMatch[1] }
  } catch {
    return null
  }
}

export function useRelease(): ReleaseState {
  const environment = typeof import.meta.env === 'object' ? import.meta.env : undefined
  const configuredValue = environment?.VITE_EASYFIELD_DOWNLOAD_URL?.trim()
  const configuredAsset = parseReleaseAssetUrl(configuredValue)
  const hasConfiguredValue = Boolean(configuredValue)
  const canCheckRelease = window.location.protocol === 'http:' || window.location.protocol === 'https:'
  const [release, setRelease] = useState<ReleaseState>(() => {
    if (configuredAsset) {
      return { status: 'available', url: configuredAsset.url, version: null }
    }

    return canCheckRelease && !hasConfiguredValue
      ? { status: 'checking', url: RELEASES_URL, version: null }
      : { status: 'unavailable', url: RELEASES_URL, version: null }
  })

  useEffect(() => {
    if (hasConfiguredValue || !canCheckRelease) return

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

        const installer = result.assets
          ?.map((asset) => parseReleaseAssetUrl(asset.browser_download_url))
          .find((asset) => asset !== null)

        if (!installer) {
          setRelease({ status: 'unavailable', url: RELEASES_URL, version: null })
          return
        }

        setRelease({ status: 'available', url: installer.url, version: installer.version })
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
  }, [canCheckRelease, hasConfiguredValue])

  return release
}
