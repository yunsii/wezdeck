// Before any cdp test: is the stack under test built from these sources?
// A stale stack (sources edited, stack not restarted) fails every test in
// ways that look like real bugs — that cost a round of "is it the old
// build?" doubt. The web build id and the relay version are both the source
// fingerprint (scripts/dev/source-fingerprint.sh, set by
// remote-test-stack.sh and native/wezdeck-wsl/build.sh), so compare them
// with the fingerprint of the working tree and stop early on a mismatch.
// WEZDECK_SKIP_VERSION_CHECK=1 skips (e.g. probing an old deploy on purpose).
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const repo = join(import.meta.dirname, '..', '..')
const fingerprint = (dir: string) =>
  execFileSync(join(repo, 'scripts/dev/source-fingerprint.sh'), [dir])
    .toString()
    .trim()

const restart =
  'restart the stack: scripts/dev/remote-test-stack.sh start (then re-export its env)'

export default async function checkVersions() {
  if (process.env.WEZDECK_SKIP_VERSION_CHECK === '1') return
  const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'
  const wantWeb = fingerprint('web')
  let served = ''
  try {
    const res = await fetch(`${base}/build.json?t=${Date.now()}`, {
      cache: 'no-store',
    })
    served = ((await res.json()) as { buildId?: string }).buildId ?? ''
  } catch (e) {
    throw new Error(
      `cdp tests: ${base}/build.json unreachable (${String(e)}); ${restart}`,
    )
  }
  if (served !== wantWeb)
    throw new Error(
      `cdp tests: ${base} serves web build ${served || '?'}, the sources are ${wantWeb}; ${restart}`,
    )
  // the test relay's own log; only for the local stack
  const stack =
    process.env.WEZDECK_TEST_STACK_DIR || '/tmp/wezdeck-remote-test-stack'
  const log = join(stack, 'relay.out')
  if (!/127\.0\.0\.1|localhost/.test(base) || !existsSync(log)) return
  const running = [
    ...readFileSync(log, 'utf8').matchAll(/event=connected .*version=(\S+)/g),
  ].at(-1)?.[1]
  const wantRelay = fingerprint('native/wezdeck-wsl')
  if (running !== wantRelay)
    throw new Error(
      `cdp tests: the test relay runs ${running ?? '? (no version logged)'}, the sources are ${wantRelay}; ${restart}`,
    )
}
