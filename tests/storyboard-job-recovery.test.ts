import assert from 'node:assert/strict'
import test from 'node:test'
import {
  STORYBOARD_BOARD_JOB_NAMESPACE,
  createStoryboardBoardJobMetadata,
  parseStoryboardBoardJobMetadata,
} from '../src/data/storyboardJobRecovery.ts'

const DRAFT_KEY = 'default:storyboard-v1'

test('complete-board recovery metadata round-trips the exact generation snapshot', () => {
  const metadata = createStoryboardBoardJobMetadata(DRAFT_KEY, {
    requestedVersions: 3,
    promptSnapshot: 'One complete board with three ordered scenes.',
    inputFingerprint: 'storyboard-board-v1-0123456789abcdef',
    model: 'Seedream 5 Pro',
    aspect: '16:9',
    resolution: '1K',
    extras: { format: 'PNG' },
  })

  assert.equal(metadata.namespace, STORYBOARD_BOARD_JOB_NAMESPACE)
  assert.equal(metadata.key, DRAFT_KEY)
  assert.deepEqual(parseStoryboardBoardJobMetadata(metadata, DRAFT_KEY), {
    requestedVersions: 3,
    promptSnapshot: 'One complete board with three ordered scenes.',
    inputFingerprint: 'storyboard-board-v1-0123456789abcdef',
    model: 'Seedream 5 Pro',
    aspect: '16:9',
    resolution: '1K',
    extras: { format: 'PNG' },
  })
})

test('complete-board recovery ignores another draft, malformed data, and future payloads', () => {
  const metadata = createStoryboardBoardJobMetadata(DRAFT_KEY, {
    requestedVersions: 1,
    promptSnapshot: 'Board',
    inputFingerprint: 'storyboard-board-v1-fedcba9876543210',
    model: 'Seedream 5 Pro',
    aspect: '16:9',
    resolution: '1K',
    extras: { format: 'PNG' },
  })

  assert.equal(parseStoryboardBoardJobMetadata(metadata, 'another-draft'), null)
  assert.equal(parseStoryboardBoardJobMetadata({ ...metadata, payload: '{' }, DRAFT_KEY), null)
  assert.equal(parseStoryboardBoardJobMetadata({
    ...metadata,
    payload: JSON.stringify({ ...JSON.parse(metadata.payload), version: 2 }),
  }, DRAFT_KEY), null)
  assert.equal(parseStoryboardBoardJobMetadata({
    ...metadata,
    payload: JSON.stringify({ ...JSON.parse(metadata.payload), model: 'Unknown model' }),
  }, DRAFT_KEY), null)
})
