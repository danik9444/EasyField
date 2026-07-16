import assert from 'node:assert/strict'
import test from 'node:test'
import { appendRuntimePackagesToSpdx } from '../scripts/release-runtime-sbom.mjs'

function catalog(releaseReady = true) {
  return {
    releaseReady,
    architectures: ['arm64', 'x64'],
    components: [{
      id: 'ffmpeg',
      spdx: releaseReady ? {
        name: 'Synthetic FFmpeg',
        supplier: 'Organization: Synthetic Test',
        licenseDeclared: 'MIT',
        downloadLocation: 'https://downloads.synthetic-runtime.dev/ffmpeg',
        copyrightText: 'Copyright Synthetic Test',
      } : null,
      targets: releaseReady ? {
        arm64: { version: '1.0.0' },
        x64: { version: '1.0.0' },
      } : { arm64: null, x64: null },
    }],
  }
}

test('release-ready runtime targets become explicit SPDX dependencies', () => {
  const sbom = {
    packages: [{ SPDXID: 'SPDXRef-Package-easyfield', name: 'easyfield', versionInfo: '1.2.0' }],
    relationships: [],
  }
  const result = appendRuntimePackagesToSpdx(sbom, catalog(), 'easyfield', '1.2.0')
  assert.equal(result.added, 2)
  assert.equal(sbom.packages.length, 3)
  assert.deepEqual(
    sbom.packages.slice(1).map((entry) => entry.SPDXID),
    ['SPDXRef-EasyField-Runtime-ffmpeg-arm64', 'SPDXRef-EasyField-Runtime-ffmpeg-x64'],
  )
  assert.equal(sbom.relationships.every((entry) => entry.relationshipType === 'DEPENDS_ON'), true)
  assert.equal(sbom.packages[1].filesAnalyzed, false)
})

test('non-distributable CI catalog adds no runtime package claims', () => {
  const sbom = { packages: [], relationships: [] }
  assert.deepEqual(appendRuntimePackagesToSpdx(sbom, catalog(false), 'easyfield', '1.2.0'), { added: 0 })
  assert.deepEqual(sbom, { packages: [], relationships: [] })
})
