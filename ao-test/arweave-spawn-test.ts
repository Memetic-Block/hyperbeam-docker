// Phase 1 — Arweave smoke test: spawn a lua-device process from our smoke
// module, signed with an Arweave JWK, then send interactions and assert both
// the interaction results and the HTTP-readable process state.

import 'dotenv/config'
import { connect, createSigner } from '@permaweb/aoconnect'
import { loadWallet, resolveAuthority } from './helpers'
import {
  run, step, info, check, checkEqual, sleep,
  spawnSmokeProcess, sendAction, outputData, readNow,
} from './smoke-util'

const HB_URL = process.env.HB_URL || 'http://localhost:8734'
const WALLET_FILE = process.env.WALLET_FILE || ''
const MODULE = process.env.MODULE || ''
const SCHEDULER = process.env.SCHEDULER

run('arweave spawn + interact (lua)', async () => {
  if (!WALLET_FILE) throw new Error('WALLET_FILE is required (path to an Arweave JWK)')
  if (!MODULE) throw new Error('MODULE is required — run `bun run publish` first and put the id in .env')

  step('Building Arweave signer from JWK')
  info('WALLET_FILE', WALLET_FILE)
  const signer = createSigner(loadWallet(WALLET_FILE))

  const ao: any = connect({ MODE: 'mainnet', URL: HB_URL, signer, SCHEDULER } as any)

  const authority = (await resolveAuthority(HB_URL)).trim()
  const scheduler = SCHEDULER || authority
  step('Spawning lua process')
  info('module', MODULE)
  info('scheduler', scheduler)
  const processId = await spawnSmokeProcess(ao, {
    module: MODULE, scheduler, authority, signer, namePrefix: 'arweave-lua-smoke',
  })

  step('Waiting for spawn to settle')
  await sleep(5000)

  // Basic interaction round-trip.
  const ping = await sendAction(ao, processId, 'ping', { signer })
  checkEqual(outputData(ping.result), 'pong', 'ping returned pong')

  // Persistent state across messages.
  await sendAction(ao, processId, 'increment', { signer })
  const inc2 = await sendAction(ao, processId, 'increment', { signer })
  checkEqual(outputData(inc2.result), '2', 'count persisted and incremented across messages')

  // State is directly readable over HTTP — no patch device involved.
  const count = await readNow(HB_URL, processId, 'state/counters/count')
  checkEqual(count.text, '2', 'GET /now/state/counters/count reads the live count')

  check(true, 'Arweave-signed spawn + interact works end-to-end on the lua device')
})
