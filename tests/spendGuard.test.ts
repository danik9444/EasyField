import assert from 'node:assert/strict'
import test from 'node:test'
import { assertSpendApproved, getSpendApproval } from '../src/services/spendGuard.ts'

test('known estimates remain informational even above a legacy ceiling', () => {
  assert.deepEqual(getSpendApproval({ credits: 500, perSecond: false }, 1), {
    approved: true,
    estimatedCredits: 500,
    ceiling: Number.POSITIVE_INFINITY,
  })
})

test('unknown and per-second prices never block generation', () => {
  assert.equal(getSpendApproval({ credits: null, perSecond: false }, 0).approved, true)
  assert.equal(getSpendApproval({ credits: 14, perSecond: true }, 0).approved, true)
})

test('legacy service assertions are non-blocking compatibility calls', () => {
  assert.doesNotThrow(() => assertSpendApproved({ credits: null, perSecond: false }, 'Music generation', 0))
})
