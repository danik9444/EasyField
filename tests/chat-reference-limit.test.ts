import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_CHAT_REFERENCE_ATTACHMENTS,
  buildEnhanceUserMessage,
  limitChatReferences,
  type EnhanceReference,
} from '../src/services/chat.ts'

test('chat prompt preparation preserves every reference allowed by the largest image-model quota', () => {
  const references: EnhanceReference[] = Array.from({ length: 18 }, (_, index) => ({
    role: 'reference image',
    label: `Reference ${index + 1}`,
  }))

  const selected = limitChatReferences(references)

  assert.equal(MAX_CHAT_REFERENCE_ATTACHMENTS, 16)
  assert.equal(selected.length, 16)
  assert.equal(selected[15].label, 'Reference 16')
  assert.equal(references.length, 18, 'limiting must not mutate the workspace reference list')
})

test('enhancer message preserves complete supporting context and reference manifest', () => {
  const finalSentinel = 'FINAL_SCENE_CONTEXT_SENTINEL'
  const context = `${'Earlier scene context. '.repeat(600)}${finalSentinel}`
  const message = buildEnhanceUserMessage({
    rough: 'Improve only this scene prompt.',
    targetModel: 'Seedream 5 Pro',
    mediaKind: 'image',
    supportingContext: {
      label: 'complete storyboard context',
      text: context,
    },
  }, [
    '- story reference image "Character front" [image attached]',
    '- story reference image "Location wide" [image attached]',
  ], 2)

  assert.match(message, /PRIMARY TEXT TO IMPROVE/)
  assert.match(message, /Improve only this scene prompt/)
  assert.match(message, /READ-ONLY COMPLETE STORYBOARD CONTEXT/)
  assert.match(message, new RegExp(finalSentinel), 'supporting context must not be clipped before the final scene')
  assert.match(message, /Character front/)
  assert.match(message, /Location wide/)
  assert.match(message, /2 visual reference frame\(s\) are attached/)
})

test('reference-led transition manifest preserves ordered endpoints without an empty primary prompt', () => {
  const message = buildEnhanceUserMessage({
    rough: '',
    targetModel: 'Veo 3.1 Quality',
    mediaKind: 'video',
    purpose: 'transition',
  }, [
    '- outgoing shot end frame "outgoing.png" [image attached]',
    '- incoming shot start frame "incoming.png" [image attached]',
  ], 2)
  assert.ok(message.indexOf('outgoing shot end frame') < message.indexOf('incoming shot start frame'))
  assert.match(message, /REFERENCE-LED AUTO DRAFT/)
  assert.doesNotMatch(message, /PRIMARY TEXT TO IMPROVE/)
})
