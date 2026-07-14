import type { Creation } from '../data/creations'
import { copyLibraryCreationToFile, libraryCreationDisplayName } from '../data/librarySelection'
import { host } from './host'

// Screens receive a fresh, workspace-owned File. If a provider URL cannot be
// read by the renderer, Main first localizes it into EasyField's artifact
// store; the Library record and its current URL remain untouched.
export async function copyLibraryCreationForWorkspace(creation: Creation): Promise<File> {
  return copyLibraryCreationToFile(creation, {
    localizeUrl: async (url, selected) => {
      const artifact = await host.ingestArtifact({
        url,
        name: libraryCreationDisplayName(selected),
        kind: selected.kind,
      })
      return artifact?.url
    },
  })
}
