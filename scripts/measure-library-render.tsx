import { renderToString } from 'react-dom/server'
import { Library } from '../src/screens/Library.tsx'
import { addCreations, getCreations } from '../src/data/creations.ts'

const requestedCount = Number.parseInt(process.argv[2] ?? '1000', 10)
const count = Number.isFinite(requestedCount) && requestedCount > 0 ? requestedCount : 1000
const creations = Array.from({ length: count }, (_, index) => ({
  kind: index % 2 === 0 ? 'video' as const : 'audio' as const,
  url: `asset:library-measure-${index}`,
  prompt: `Measured asset ${index}`,
  durability: 'local' as const,
}))

addCreations(creations)

const markup = renderToString(
  <Library
    onBack={() => {}}
    onOpenCreate={() => {}}
    toast={() => {}}
    onSendToEdit={() => {}}
  />,
)

console.log(JSON.stringify({
  requestedItems: count,
  retainedItems: getCreations().length,
  videoElements: (markup.match(/<video/g) ?? []).length,
  audioElements: (markup.match(/<audio/g) ?? []).length,
  markupBytes: Buffer.byteLength(markup),
}))
