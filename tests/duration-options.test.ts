import test from 'node:test'
import assert from 'node:assert/strict'
import {
  durationOptionAt,
  durationOptionIndex,
  formatDurationAriaValue,
  formatDurationValue,
  uniqueDurationOptions,
} from '../src/data/durationOptions.ts'

test('duration options preserve sparse model-supported values', () => {
  const options = ['4', '6', '8', '10']
  assert.equal(durationOptionIndex(options, '8'), 2)
  assert.equal(durationOptionAt(options, 1), '6')
  assert.equal(durationOptionAt(options, 99), '10')
})

test('duration options preserve Full as a semantic source-length value', () => {
  const options = ['Full', '2s', '3s', '4s']
  assert.equal(durationOptionIndex(options, 'Full'), 0)
  assert.equal(durationOptionAt(options, 0), 'Full')
  assert.equal(formatDurationValue('Full'), 'Full source')
  assert.equal(formatDurationAriaValue('Full'), 'Full source duration')
})

test('duration formatting is compact visually and explicit for assistive technology', () => {
  assert.equal(formatDurationValue('1'), '1s')
  assert.equal(formatDurationValue('15s'), '15s')
  assert.equal(formatDurationAriaValue('1'), '1 second')
  assert.equal(formatDurationAriaValue('15s'), '15 seconds')
})

test('duration helpers safely normalize duplicates, invalid values and empty lists', () => {
  assert.deepEqual(uniqueDurationOptions(['5', '5', '', '10']), ['5', '10'])
  assert.equal(durationOptionIndex(['5', '10'], '12'), 0)
  assert.equal(durationOptionAt([], 0), undefined)
  assert.equal(durationOptionAt(['6'], 0), '6')
})
