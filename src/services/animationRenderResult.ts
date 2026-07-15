const MANAGED_ARTIFACT_URL = /^\/artifacts\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Normalizes both render transports without trusting a renderer-supplied path.
 * Packaged builds return an opaque Main-owned artifact receipt; Vite development
 * returns the MP4 bytes directly and keeps a temporary object URL for preview.
 */
export async function readAnimationRenderResult(res: Response): Promise<{ url: string; managed: boolean }> {
  const responseType = res.headers.get('content-type')?.toLowerCase() ?? ''
  if (responseType.includes('application/json')) {
    const receipt = await res.json() as { artifactUrl?: unknown }
    const artifactUrl = typeof receipt.artifactUrl === 'string' ? receipt.artifactUrl : null
    if (!artifactUrl || !MANAGED_ARTIFACT_URL.test(artifactUrl)) {
      throw new Error('Render server returned an invalid local artifact receipt')
    }
    return { url: artifactUrl, managed: true }
  }

  const blob = await res.blob()
  if (!blob.size || !blob.type.toLowerCase().startsWith('video/mp4')) {
    throw new Error('Render server returned an invalid MP4')
  }
  return { url: URL.createObjectURL(blob), managed: false }
}
