import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const promptCard = read('../src/components/PromptCard.tsx')
const storyboard = read('../src/screens/Storyboard.tsx')
const sceneCard = read('../src/components/StoryboardSceneCard.tsx')
const workspace = read('../src/screens/ToolWorkspace.tsx')
const animation = read('../src/screens/Animation.tsx')
const createVideo = read('../src/screens/CreateVideo.tsx')

test('shared prompt control enables reference-led Auto and labels the mode', () => {
  assert.match(promptCard, /if \(enhancing \|\| !canEnhancePrompt\(prompt, references\)\) return/)
  assert.match(promptCard, /disabled=\{enhancing \|\| !canEnhancePrompt\(prompt, references\)/)
  assert.match(promptCard, /Auto · \{references!\.length\} attached/)
})

test('Storyboard custom enhancers accept blank fields when a story reference exists', () => {
  assert.match(storyboard, /canEnhancePrompt\(briefSnapshot, promptReferences, SCENE_PROMPT_MIN_LENGTH\)/)
  assert.match(storyboard, /canEnhancePrompt\(scene\.prompt, promptReferences, SCENE_PROMPT_MIN_LENGTH\)/)
  assert.match(storyboard, /canEnhanceFromReferences=\{referenceImages\.length > 0\}/)
  assert.match(sceneCard, /prompt\.trim\(\)\.length < 3 && !canEnhanceFromReferences/)
})

test('generic and Animation workspaces expose every attached source as enhancement context', () => {
  assert.match(workspace, /const enhancementReferences = useMemo<EnhanceReference\[\]>/)
  assert.match(workspace, /imageUrl: source\.kind === 'image'/)
  assert.match(workspace, /videoUrl: source\.kind === 'video'/)
  assert.match(workspace, /references=\{enhancementReferences\}/)
  assert.match(animation, /role: 'animation document reference'/)
  assert.match(animation, /role: 'animation website reference'/)
})

test('Transition requires the reviewed Auto or written prompt before generation', () => {
  assert.match(createVideo, /if \(!prompt\.trim\(\)\) return 'Describe the transition, or use Enhance to create an Auto prompt from both frames\.'/)
})
