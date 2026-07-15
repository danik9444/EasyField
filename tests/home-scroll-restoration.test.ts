import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const homeSource = readFileSync(new URL('../src/screens/Home.tsx', import.meta.url), 'utf8')

test('Home navigation memory is owned above the conditionally mounted screen', () => {
  assert.match(appSource, /useRef<HomeNavigationMemory>\(\{[\s\S]*query:\s*''[\s\S]*activeCategory:\s*'all'[\s\S]*scrollTop:\s*0[\s\S]*windowMode:\s*settings\.windowMode/)
  assert.match(appSource, /navigationMemory=\{homeNavigationMemoryRef\.current\}/)
})

test('Home restores its own scroll viewport rather than the browser window', () => {
  assert.match(homeSource, /useLayoutEffect\(\(\)\s*=>\s*\{[\s\S]*homeScrollRef\.current[\s\S]*scrollViewport\.scrollTop\s*=\s*navigationMemory\.scrollTop/)
  assert.match(homeSource, /ref=\{homeScrollRef\}[\s\S]*className="ef-scroll ef-home-scroll"[\s\S]*onScroll=\{\(event\)\s*=>\s*\{ navigationMemory\.scrollTop = event\.currentTarget\.scrollTop \}\}/)
  assert.doesNotMatch(homeSource, /window\.scrollTo|window\.scrollY/)
})

test('Home preserves the filter context needed for an exact return position', () => {
  assert.match(homeSource, /useState\(\(\)\s*=>\s*navigationMemory\.query\)/)
  assert.match(homeSource, /HOME_CATEGORY_IDS\.includes\(navigationMemory\.activeCategory\)/)
  assert.match(homeSource, /navigationMemory\.query\s*=\s*nextQuery/)
  assert.match(homeSource, /navigationMemory\.activeCategory\s*=\s*nextCategory/)
})

test('Home uses a semantic tool anchor when compact and expanded layouts differ', () => {
  assert.match(homeSource, /navigationMemory\.windowMode\s*===\s*windowMode/)
  assert.match(homeSource, /data-home-scroll-anchor=\{tool\.id\}/)
  assert.match(homeSource, /navigationMemory\.anchorOffset/)
  assert.match(homeSource, /scrollViewport\.scrollTop\s*\+=\s*anchorTop\s*-\s*viewportTop\s*-\s*navigationMemory\.anchorOffset/)
})
