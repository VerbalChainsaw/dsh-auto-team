// End-to-end verification for @local/dsh-auto-team.
//
// This is the "do I believe it" script. It answers three questions with evidence
// instead of assertion:
//
//   1. Is the code installed in the profile byte-identical to this checkout?
//   2. Do the policies actually behave, running the real listener code?
//   3. Is the plugin composed into the profile the Host will boot?
//
// Run: node verify.mjs
// Exit code 0 means every check passed.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'

const HERE = import.meta.dirname
const SOURCE = join(HERE, 'index.js')
const PROFILE = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'web')
// Derive identity from this package's manifest so a rename cannot silently
// invalidate the check (the previous hardcoded scope did exactly that risk).
const PKG = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'))
const PKG_NAME = PKG.name
const INSTALLED = join(PROFILE, 'node_modules', ...PKG_NAME.split('/'), 'index.js')
const PROFILE_JSON = join(PROFILE, 'package.json')

const results = []
const record = (ok, label, detail) => {
  results.push({ ok, label })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`)
}
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

console.log('auto-team verification\n')

// 1. Artifact identity -------------------------------------------------------
if (!existsSync(INSTALLED)) {
  record(false, 'installed artifact exists', INSTALLED)
} else {
  const a = hash(SOURCE)
  const b = hash(INSTALLED)
  record(
    a === b,
    'installed artifact is byte-identical to this checkout',
    `source    ${a}\n        installed ${b}`,
  )
}

// 2. Real listener behaviour, against the installed copy ---------------------
// The suite imports the module under test, so pointing it at the installed file
// validates the artifact rather than only the workspace source.
const suiteArgs = [join(HERE, 'test', 'provision.test.mjs')]
const suite = existsSync(INSTALLED)
  ? spawnSync(process.execPath, suiteArgs, {
      env: { ...process.env, AUTO_TEAM_MODULE: INSTALLED },
      stdio: 'inherit',
    })
  : spawnSync(process.execPath, suiteArgs, { stdio: 'inherit' })
record(
  suite.status === 0,
  existsSync(INSTALLED)
    ? 'policy suite passes against the INSTALLED artifact'
    : 'policy suite passes against the workspace source',
)

// 3. Composition -------------------------------------------------------------
if (!existsSync(PROFILE_JSON)) {
  record(false, 'profile package.json found', PROFILE_JSON)
} else {
  const pkg = JSON.parse(readFileSync(PROFILE_JSON, 'utf8'))
  const bundles = pkg.dsh?.profile?.bundles ?? []
  const spec = pkg.dependencies?.[PKG_NAME]
  record(
    bundles.includes(PKG_NAME),
    'auto-team is in the profile bundle layer list',
    `bundles: ${bundles.length}`,
  )
  record(
    typeof spec === 'string' && !spec.startsWith('link:'),
    'profile owns a packaged copy, not a link into a checkout',
    spec ? `dependency: ${spec}` : 'no dependency entry',
  )
}

// 3b. The composed profile the Host will actually boot carries the row, enabled.
// This is the check that catches a shipped patch that parses but disarms the
// policy — exactly what hashing index.js alone cannot see.
{
  const profileName = basename(PROFILE)
  // On Windows `dsh` is a .cmd shim, which only cmd.exe can resolve.
  const isWindows = process.platform === 'win32'
  const dump = spawnSync(
    isWindows ? 'dsh.cmd' : 'dsh',
    ['--profile', profileName, '--dump-config'],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      shell: isWindows,
    },
  )
  if (dump.error) {
    record(false, 'composed profile validated (dsh --dump-config)', dump.error.message)
  } else if (dump.status !== 0) {
    record(
      false,
      'composed profile validated (dsh --dump-config)',
      `exit ${dump.status}: ${String(dump.stderr ?? '').slice(0, 200)}`,
    )
  } else {
    const text = dump.stdout ?? ''
    const idx = text.indexOf('- id: auto-team')
    const window = idx === -1 ? '' : text.slice(idx, idx + 1600)
    const present = idx !== -1
    const disabled = /disabled:\s*true/.test(window)
    record(
      present && !disabled,
      'composed profile carries the auto-team row, enabled',
      present
        ? disabled
          ? 'row present but disabled: true'
          : 'row present and enabled'
        : 'row missing from the composed output',
    )
  }
}

// 4. Honest summary ----------------------------------------------------------
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log('\nNot releasable. Fix the FAIL lines above.')
  process.exit(1)
}
console.log(`
What this proves: the installed code is the code under test, its policies behave,
and the profile is composed to boot it.
What it does NOT prove: that a live session provisions a crew. For that, run one
fresh session and look for:

  [auto-team] armed api=ok sources=[startup] ... gate=on policy=require shell=on
  [auto-team] provisioned [scout,builder,critic,operator] for <session>`)
