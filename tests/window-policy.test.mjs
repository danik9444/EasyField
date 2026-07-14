import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  applyWindowMode,
  clampWindowToWorkArea,
  createResolveAwareFloatingController,
  frontmostBundleIdFromInfo,
  isResolveBundleId,
  windowBoundsForMode,
} = require('../plugin/window-policy.cjs')

test('compact and expanded profiles have distinct portrait and landscape bounds', () => {
  const workArea = { x: 0, y: 25, width: 1440, height: 875 }
  assert.deepEqual(windowBoundsForMode('compact', workArea), {
    x: 1024,
    y: 41,
    width: 400,
    height: 820,
  })
  assert.deepEqual(windowBoundsForMode('expanded', workArea), {
    x: 464,
    y: 41,
    width: 960,
    height: 800,
  })
})

test('window bounds stay inside small and negative-coordinate display work areas', () => {
  const small = { x: 0, y: 24, width: 800, height: 600 }
  const compact = windowBoundsForMode('compact', small)
  const expanded = windowBoundsForMode('expanded', small)
  assert.deepEqual(compact, { x: 384, y: 40, width: 400, height: 568 })
  assert.deepEqual(expanded, { x: 16, y: 40, width: 768, height: 568 })

  const leftDisplay = { x: -1280, y: 0, width: 1280, height: 800 }
  const resized = windowBoundsForMode('expanded', leftDisplay, {
    x: -416,
    y: 16,
    width: 400,
    height: 720,
  })
  assert.deepEqual(resized, { x: -976, y: 16, width: 960, height: 768 })
})

test('mode application uses the window display, atomically replaces constraints and preserves its edge', () => {
  const calls = []
  const browserWindow = {
    isDestroyed: () => false,
    getBounds: () => ({ x: -416, y: 16, width: 400, height: 720 }),
    setMinimumSize: (width, height) => calls.push(['minimum', width, height]),
    setMaximumSize: (width, height) => calls.push(['maximum', width, height]),
    setBounds: (bounds, animate) => calls.push(['bounds', bounds, animate]),
  }
  const electronScreen = {
    getDisplayMatching: () => ({ id: 22, workArea: { x: -1280, y: 0, width: 1280, height: 800 } }),
    getPrimaryDisplay: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
  }

  const result = applyWindowMode(browserWindow, electronScreen, 'expanded', { animate: true })
  assert.equal(result.displayId, 22)
  assert.deepEqual(result.bounds, { x: -976, y: 16, width: 960, height: 768 })
  assert.deepEqual(result.limits, { minWidth: 720, minHeight: 560, maxWidth: 1200, maxHeight: 768 })
  assert.deepEqual(calls, [
    ['minimum', 1, 1],
    ['maximum', 1280, 800],
    ['bounds', { x: -976, y: 16, width: 960, height: 768 }, true],
    ['minimum', 720, 560],
    ['maximum', 1200, 768],
  ])
})

test('moving between displays preserves user size where possible and clamps oversize bounds', () => {
  const calls = []
  const browserWindow = {
    isDestroyed: () => false,
    getBounds: () => ({ x: -1500, y: -80, width: 1300, height: 1000 }),
    setMinimumSize: (width, height) => calls.push(['minimum', width, height]),
    setMaximumSize: (width, height) => calls.push(['maximum', width, height]),
    setBounds: (bounds, animate) => calls.push(['bounds', bounds, animate]),
  }
  const electronScreen = {
    getDisplayMatching: () => ({ id: 22, workArea: { x: -1280, y: 0, width: 1280, height: 800 } }),
  }

  const result = clampWindowToWorkArea(browserWindow, electronScreen, 'expanded')
  assert.deepEqual(result, {
    bounds: { x: -1264, y: 16, width: 1200, height: 768 },
    displayId: 22,
    changed: true,
  })
  assert.deepEqual(calls.at(2), ['bounds', { x: -1264, y: 16, width: 1200, height: 768 }, false])
})

test('frontmost app parsing recognizes Resolve without broad name matching', () => {
  assert.equal(frontmostBundleIdFromInfo('"CFBundleIdentifier"="com.blackmagic-design.DaVinciResolve"\n'), 'com.blackmagic-design.DaVinciResolve')
  assert.equal(frontmostBundleIdFromInfo('"LSDisplayName"="DaVinci Resolve"\n'), '')
  assert.equal(isResolveBundleId('com.blackmagic-design.DaVinciResolve'), true)
  assert.equal(isResolveBundleId('com.example.DaVinciResolveClone'), false)
})

test('floating controller stays above Resolve but yields to unrelated applications', async () => {
  class FakeWindow extends EventEmitter {
    constructor() {
      super()
      this.focused = false
      this.destroyed = false
      this.topCalls = []
      this.workspaceCalls = []
    }
    isFocused() { return this.focused }
    isDestroyed() { return this.destroyed }
    setAlwaysOnTop(...args) { this.topCalls.push(args) }
    setVisibleOnAllWorkspaces(...args) { this.workspaceCalls.push(args) }
  }

  const browserWindow = new FakeWindow()
  let bundleId = 'com.blackmagic-design.DaVinciResolve'
  let intervalCallback = null
  let intervalCleared = false
  const timer = { unref() {} }
  const controller = createResolveAwareFloatingController(browserWindow, {
    getFrontmostBundleId: async () => bundleId,
    setIntervalFn: (callback) => { intervalCallback = callback; return timer },
    clearIntervalFn: (received) => { intervalCleared = received === timer },
  })

  await controller.refresh()
  assert.deepEqual(browserWindow.workspaceCalls, [[false, { visibleOnFullScreen: false }]])
  assert.deepEqual(browserWindow.topCalls.at(-1), [true, 'floating'])

  bundleId = 'com.apple.Safari'
  await controller.refresh()
  assert.deepEqual(browserWindow.topCalls.at(-1), [false])

  browserWindow.focused = true
  browserWindow.emit('focus')
  assert.deepEqual(browserWindow.topCalls.at(-1), [true, 'floating'])

  browserWindow.focused = false
  bundleId = 'com.apple.finder'
  await controller.refresh()
  assert.deepEqual(browserWindow.topCalls.at(-1), [false])
  assert.equal(typeof intervalCallback, 'function')

  controller.dispose()
  assert.equal(intervalCleared, true)
  assert.equal(browserWindow.listenerCount('focus'), 0)
  assert.equal(browserWindow.listenerCount('blur'), 0)
})
