import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const hookPath = path.join(projectRoot, 'scripts', 'hooks', 'pre-push')

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim()
}

// Builds a repository whose HEAD sits `behindBy` commits behind origin/main.
// origin/main is written directly as a remote-tracking ref, which is what the
// hook reads — no network and no real remote involved.
function repositoryBehindOriginMain(behindBy) {
  const directory = mkdtempSync(path.join(tmpdir(), 'easyfield-prepush-'))
  git(directory, 'init', '--quiet', '--initial-branch=main')
  writeFileSync(path.join(directory, 'package.json'), '{"name":"fixture","version":"0.0.0"}\n')
  git(directory, 'add', 'package.json')
  git(directory, 'commit', '--quiet', '-m', 'base')
  const base = git(directory, 'rev-parse', 'HEAD')

  for (let index = 0; index < behindBy; index += 1) {
    writeFileSync(path.join(directory, `ahead-${index}.txt`), `${index}\n`)
    git(directory, 'add', '.')
    git(directory, 'commit', '--quiet', '-m', `ahead ${index}`)
  }
  git(directory, 'update-ref', 'refs/remotes/origin/main', git(directory, 'rev-parse', 'HEAD'))
  git(directory, 'checkout', '--quiet', '-B', 'feature', base)
  return directory
}

function runHook(directory) {
  try {
    return {
      status: 0,
      output: execFileSync('bash', [hookPath], { cwd: directory, encoding: 'utf8', stdio: 'pipe' }),
    }
  } catch (error) {
    return { status: error.status, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

test('the pre-push hook refuses to publish a build older than origin/main', () => {
  // Publishing from a stale branch hands the panel a downgrade: a local update
  // source accepts any fresh buildId without comparing versions, so an older
  // tree silently replaces a newer released one.
  const directory = repositoryBehindOriginMain(3)
  try {
    const { status, output } = runHook(directory)
    assert.equal(status, 0, 'the hook must never block a push')
    assert.match(output, /Skipped publishing the local plugin update/)
    assert.match(output, /3 commit\(s\) behind origin\/main/)
    assert.doesNotMatch(
      output,
      /Publishing local plugin update/,
      'a stale branch must not reach the publish step',
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the pre-push hook still publishes when the branch contains origin/main', () => {
  const directory = repositoryBehindOriginMain(0)
  try {
    const { status, output } = runHook(directory)
    assert.equal(status, 0, 'the hook must never block a push')
    assert.match(output, /Publishing local plugin update/)
    assert.doesNotMatch(output, /Skipped publishing/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the pre-push hook publishes when origin/main is unknown', () => {
  // A fresh clone or a fork without origin/main must keep the old behaviour
  // rather than silently stop publishing.
  const directory = mkdtempSync(path.join(tmpdir(), 'easyfield-prepush-noremote-'))
  try {
    git(directory, 'init', '--quiet', '--initial-branch=main')
    writeFileSync(path.join(directory, 'package.json'), '{"name":"fixture","version":"0.0.0"}\n')
    git(directory, 'add', 'package.json')
    git(directory, 'commit', '--quiet', '-m', 'base')

    const { status, output } = runHook(directory)
    assert.equal(status, 0)
    assert.match(output, /Publishing local plugin update/)
    assert.doesNotMatch(output, /Skipped publishing/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
