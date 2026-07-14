// Revert-on-error test — confirms the legacynet behavior we depend on: a
// failed interaction must not mutate process state, whether the write happens
// before or after the error.
//
// Two distinct error layers exist on a lua-device process:
//
//  A. Handler errors CAUGHT by the module (our smoke.lua pcalls handlers and
//     restores a pre-dispatch snapshot of `state`). The slot computes OK, the
//     result reports `error: …`, state is reverted, and the process advances.
//     This is the layer that matches legacynet's semantics — BUT ONLY because
//     our module implements it. hyper-aos, notably, keeps mutations made
//     before a handler error.
//
//  B. UNCAUGHT lua errors. dev_lua returns an error, dev_process refuses to
//     store the slot — state reverts by construction, but the poisoned
//     assignment stays at its slot, so this section OBSERVES (rather than
//     asserts) whether the process can still advance afterwards. Run against
//     a disposable process.

import 'dotenv/config'
import { connect, createSigner } from '@permaweb/aoconnect'
import { loadWallet, resolveAuthority } from './helpers'
import {
  run, step, info, warn, check, checkEqual, sleep,
  spawnSmokeProcess, sendAction, sendActionOnce, outputData, readNow,
} from './smoke-util'

const HB_URL = process.env.HB_URL || 'http://localhost:8734'
const WALLET_FILE = process.env.WALLET_FILE || ''
const MODULE = process.env.MODULE || ''
const SCHEDULER = process.env.SCHEDULER

run('revert on error (lua)', async () => {
  if (!WALLET_FILE) throw new Error('WALLET_FILE is required (path to an Arweave JWK)')
  if (!MODULE) throw new Error('MODULE is required — run `bun run publish` first and put the id in .env')

  const signer = createSigner(loadWallet(WALLET_FILE))
  const ao: any = connect({ MODE: 'mainnet', URL: HB_URL, signer, SCHEDULER } as any)
  const authority = (await resolveAuthority(HB_URL)).trim()
  const scheduler = SCHEDULER || authority

  // ---------- Part A: module-caught errors (the load-bearing semantics) ----
  step('Part A: spawning process for caught-error matrix')
  const pid = await spawnSmokeProcess(ao, {
    module: MODULE, scheduler, authority, signer, namePrefix: 'revert-smoke',
  })
  await sleep(5000)

  // Baseline state that must survive the failures below.
  await sendAction(ao, pid, 'increment', { signer })
  await sendAction(ao, pid, 'set-note', {
    signer, tags: [{ name: 'Key', value: 'baseline' }, { name: 'Value', value: 'kept' }],
  })
  checkEqual(
    (await readNow(HB_URL, pid, 'state/counters/count')).text, '1',
    'baseline: count = 1 readable over HTTP',
  )

  // Error AFTER mutating (the "write before error" case).
  const afterMutate = await sendAction(ao, pid, 'mutate-then-fail', { signer })
  check(
    String(outputData(afterMutate.result)).startsWith('error:'),
    'mutate-then-fail reported a handler error',
  )
  checkEqual(
    (await readNow(HB_URL, pid, 'state/counters/count')).text, '1',
    'count unchanged after mutate-then-fail (mutation reverted)',
  )
  const leakedNote = await readNow(HB_URL, pid, 'state/notes/mutate-then-fail')
  check(!leakedNote.ok, 'note written before the error did not persist')

  // Error BEFORE mutating (the "write after error" case — write unreachable).
  const beforeMutate = await sendAction(ao, pid, 'fail-then-mutate', { signer })
  check(
    String(outputData(beforeMutate.result)).startsWith('error:'),
    'fail-then-mutate reported a handler error',
  )
  checkEqual(
    (await readNow(HB_URL, pid, 'state/counters/count')).text, '1',
    'count unchanged after fail-then-mutate',
  )

  // Baseline survived everything; the process still advances.
  checkEqual(
    (await readNow(HB_URL, pid, 'state/notes/baseline')).text, 'kept',
    'pre-error note still present',
  )
  const inc = await sendAction(ao, pid, 'increment', { signer })
  checkEqual(outputData(inc.result), '2', 'process still advances after caught errors')

  // ---------- Part B: uncaught slot error (observational, disposable proc) --
  step('Part B: spawning DISPOSABLE process for the uncaught-error probe')
  const pid2 = await spawnSmokeProcess(ao, {
    module: MODULE, scheduler, authority, signer, namePrefix: 'revert-uncaught',
  })
  await sleep(5000)
  await sendAction(ao, pid2, 'increment', { signer })
  checkEqual(
    (await readNow(HB_URL, pid2, 'state/counters/count')).text, '1',
    'disposable process: count = 1 before the uncaught error',
  )

  step('Sending fail-uncaught (raw lua error → the slot itself errors)')
  try {
    const res = await sendActionOnce(ao, pid2, 'fail-uncaught', { signer })
    warn(`fail-uncaught unexpectedly returned a result: ${JSON.stringify(outputData(res.result))?.slice(0, 200)}`)
  } catch (err) {
    info('fail-uncaught outcome', `threw as expected: ${(err as Error).message}`)
  }

  step('Observing process state after the uncaught error')
  const nowAfter = await readNow(HB_URL, pid2, 'state/counters/count')
  if (nowAfter.ok) {
    checkEqual(nowAfter.text, '1', '/now still readable and state reverted (poisoned slot skipped?)')
  } else {
    warn(`/now no longer computes (status ${nowAfter.status}) — the poisoned slot blocks it; state before the slot is intact by construction`)
  }

  step('Can the disposable process still advance? (observational)')
  try {
    const after = await sendActionOnce(ao, pid2, 'increment', { signer })
    info('post-error increment', `computed, output = ${outputData(after.result)}`)
    warn('process ADVANCED past an uncaught error — slot was not permanently poisoned')
  } catch (err) {
    warn(`process could NOT advance past the uncaught error (${(err as Error).message}) — raw lua errors effectively brick a process; modules MUST pcall handlers`)
  }

  check(true, 'caught-error revert semantics confirmed; uncaught-error behavior recorded above')
})
