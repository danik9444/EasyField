function runtimeSpdxId(componentId, architecture) {
  const safe = `${componentId}-${architecture}`.replace(/[^A-Za-z0-9.-]/g, '-')
  return `SPDXRef-EasyField-Runtime-${safe}`
}

export function appendRuntimePackagesToSpdx(sbom, catalog, rootPackageName, rootVersion) {
  if (!catalog?.releaseReady) return Object.freeze({ added: 0 })
  if (!Array.isArray(sbom?.packages) || !Array.isArray(sbom?.relationships)) {
    throw new Error('Cannot add runtime packages to an invalid SPDX document')
  }
  const root = sbom.packages.find((entry) => entry?.name === rootPackageName && entry?.versionInfo === rootVersion)
    || sbom.packages.find((entry) => entry?.name === rootPackageName)
  if (!root?.SPDXID) throw new Error('SPDX document does not identify the EasyField root package')

  const existingIds = new Set(sbom.packages.map((entry) => entry?.SPDXID).filter(Boolean))
  let added = 0
  for (const component of catalog.components) {
    if (!component.spdx) throw new Error(`Runtime component ${component.id} has no SPDX metadata`)
    for (const architecture of catalog.architectures) {
      const target = component.targets[architecture]
      if (!target) throw new Error(`Runtime component ${component.id}.${architecture} is missing`)
      const SPDXID = runtimeSpdxId(component.id, architecture)
      if (existingIds.has(SPDXID)) throw new Error(`Duplicate runtime SPDX identifier: ${SPDXID}`)
      existingIds.add(SPDXID)
      sbom.packages.push({
        SPDXID,
        name: `${component.spdx.name} (${architecture})`,
        versionInfo: target.version,
        supplier: component.spdx.supplier,
        downloadLocation: component.spdx.downloadLocation,
        filesAnalyzed: false,
        licenseConcluded: component.spdx.licenseDeclared,
        licenseDeclared: component.spdx.licenseDeclared,
        copyrightText: component.spdx.copyrightText,
        comment: `EasyField checksum-pinned ${architecture} runtime payload; exact files are authenticated by plugin/update-manifest.json.`,
      })
      sbom.relationships.push({
        spdxElementId: root.SPDXID,
        relationshipType: 'DEPENDS_ON',
        relatedSpdxElement: SPDXID,
      })
      added += 1
    }
  }
  return Object.freeze({ added })
}
