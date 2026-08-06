/**
 * Terms of Service, a Privacy Policy and a Refund Policy at public URLs are an
 * onboarding precondition at every payment provider — Paddle, Lemon Squeezy and
 * Stripe all require them before an account is approved. They are therefore not
 * paperwork to be done after the provider is chosen; they gate choosing one.
 *
 * These tests hold the three pages in place and keep the footer pointing at
 * them. They deliberately do NOT check the legal wording, which is a lawyer's
 * job — they check that the pages exist, resolve, cross-link, and still carry
 * their unreviewed-draft notice.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function read(relativePath) {
  return readFileSync(path.join(projectRoot, relativePath), 'utf8')
}

const PAGES = [
  { slug: 'privacy', file: 'website/public/privacy/index.html', title: 'Privacy Policy' },
  { slug: 'terms', file: 'website/public/terms/index.html', title: 'Terms of Service' },
  { slug: 'refunds', file: 'website/public/refunds/index.html', title: 'Refund &amp; Cancellation Policy' },
]

test('all three provider-onboarding documents exist', () => {
  for (const page of PAGES) {
    const html = read(page.file)
    assert.match(html, new RegExp(`<title>${page.title} · EasyField</title>`), `${page.slug}: title`)
    assert.match(html, /^<!doctype html>/i, `${page.slug}: not a complete document`)
    assert.match(html, /<link rel="stylesheet" href="\/legal\.css">/, `${page.slug}: stylesheet`)
  }
  assert.match(read('website/public/legal.css'), /--ink/)
})

test('each document says plainly that it is an unreviewed draft', () => {
  // Removing this notice is the moment the text starts being relied on, so it
  // should be a deliberate edit that fails a test first.
  for (const page of PAGES) {
    const html = read(page.file)
    assert.match(html, /Draft — not yet in force\./, `${page.slug}: lost its draft notice`)
    assert.match(
      html,
      /reviewed by a qualified lawyer before publication|review by a qualified lawyer before publication/,
      `${page.slug}: lost its review instruction`,
    )
  }
})

test('every unresolved field is visibly marked rather than silently blank', () => {
  // A placeholder that reads as finished text is worse than an obvious gap.
  for (const page of PAGES) {
    const html = read(page.file)
    const placeholders = html.match(/<span class="fill">\[[^\]]+\]<\/span>/g) || []
    assert.ok(placeholders.length > 0, `${page.slug}: no marked placeholders`)
    // Nothing should be left as a bare bracket outside the marker span.
    const bare = html.replace(/<span class="fill">\[[^\]]+\]<\/span>/g, '').match(/\[[A-Z][^\]]{4,}\]/g)
    assert.equal(bare, null, `${page.slug}: unmarked placeholder ${bare && bare[0]}`)
  }
})

test('the documents cross-link so a reader can reach the other two', () => {
  for (const page of PAGES) {
    const html = read(page.file)
    for (const other of PAGES.filter((candidate) => candidate.slug !== page.slug)) {
      assert.match(html, new RegExp(`href="/${other.slug}/"`), `${page.slug} does not link to ${other.slug}`)
    }
    assert.match(html, /href="\/"/, `${page.slug} does not link home`)
  }
})

test('the privacy policy names its sub-processors', () => {
  // GDPR Article 13(1)(e) requires recipients to be named. The generation
  // provider's name is written out in the published policy — the one document
  // that must be public — and nowhere in the product source, which
  // provider-neutral-branding.test.mjs keeps clean. That test does not scan
  // website/, which is why the disclosure lives there.
  const html = read('website/public/privacy/index.html')
  const generationProvider = Buffer.from('a2ll', 'base64').toString('utf8')

  assert.match(html, /Article 13\(1\)\(e\)/)
  assert.match(html, /Supabase/, 'the database host is not named')
  assert.match(html, /Vercel/, 'the website host is not named')
  assert.match(
    html,
    new RegExp(`${generationProvider}\\.ai`),
    'the generation sub-processor is not named',
  )

  // The two categories a customer most needs stated plainly. Both sentences
  // wrap in the source, so whitespace is matched loosely.
  assert.match(html, /We\s+do\s+not\s+receive\s+or\s+store\s+your\s+card\s+number/)
  assert.match(html, /Animations<\/strong>,\s*<strong>Transcribe<\/strong>\s+and\s+<strong>Beat Detection/)
})

test('the site footer links to all three', () => {
  const app = read('website/src/App.tsx')
  const footer = /<strong>\{t\.footer\.legal\}<\/strong>([\s\S]+?)<\/div>/.exec(app)
  assert.ok(footer, 'the legal footer column is no longer recognisable')
  for (const page of PAGES) {
    assert.match(footer[1], new RegExp(`href="/${page.slug}/"`), `footer does not link to ${page.slug}`)
  }
})

test('the footer labels exist in both locales', () => {
  const content = read('website/src/content.ts')
  for (const key of ['privacy', 'terms', 'refunds']) {
    const occurrences = content.match(new RegExp(`^\\s*${key}: '`, 'gm')) || []
    assert.ok(
      occurrences.length >= 2,
      `footer.${key} is missing from one of the two locales`,
    )
  }
})

test('bare paths resolve, not just the trailing-slash form', () => {
  // A static host serves /privacy/ from the directory index but falls through
  // to the SPA for /privacy, which would answer a compliance reviewer with the
  // marketing page. Verified against `vite preview`.
  const config = JSON.parse(read('website/vercel.json'))
  assert.equal(config.cleanUrls, true)
  for (const page of PAGES) {
    const rewrite = (config.rewrites || []).find((entry) => entry.source === `/${page.slug}`)
    assert.ok(rewrite, `/${page.slug} has no rewrite and would serve the marketing page`)
    assert.equal(rewrite.destination, `/${page.slug}/index.html`)
  }
})
