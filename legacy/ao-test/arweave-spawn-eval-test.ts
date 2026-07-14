// Phase 1 — Arweave smoke test: spawn an AOS process signed with an Arweave JWK,
// then Eval Lua and assert the output.

import 'dotenv/config'
import { connect, createSigner } from '@permaweb/aoconnect'
import { loadWallet } from './helpers'
import { run, step, info, check, checkEqual, sleep, evalLua, outputData, resolveImportAuthority, uniqueName } from './smoke-util'

const HB_URL = process.env.HB_URL || 'http://localhost:8734'
const WALLET_FILE = process.env.WALLET_FILE || ''
const MODULE = process.env.MODULE || 'ISShJH1ij-hPPt9St5UFFr_8Ys3Kj5cyg7zrMGt7H9s'
const SCHEDULER = process.env.SCHEDULER

run('arweave spawn + eval', async () => {
  if (!WALLET_FILE) throw new Error('WALLET_FILE is required (path to an Arweave JWK)')

  step('Building Arweave signer from JWK')
  info('WALLET_FILE', WALLET_FILE)
  const signer = createSigner(loadWallet(WALLET_FILE))

  const ao: any = connect({ MODE: 'mainnet', URL: HB_URL, signer, SCHEDULER } as any)

  const authority = (await resolveImportAuthority(HB_URL)).trim()
  const scheduler = SCHEDULER || authority
  step('Spawning process')
  info('module', MODULE)
  info('scheduler', scheduler)
  info('authority', authority)
  const processId = await ao.spawn({
    module: MODULE,
    scheduler,
    authority,
    signer,
    tags: [
      { name: 'Name', value: uniqueName('arweave-smoke') },
      { name: 'Authority', value: authority },
    ],
    data: 'arweave smoke test',
  })
  info('processId', processId)
  check(typeof processId === 'string' && processId.length > 0, 'spawn returned a process id')

  step('Waiting for spawn to settle')
  await sleep(5000)

  // Basic arithmetic — proves the process computes and returns output.
  const r1 = await evalLua(ao, processId, 'return 1 + 1', signer)
  checkEqual(outputData(r1), '2', '1 + 1 evaluated to 2')

  // String round-trip.
  const r2 = await evalLua(ao, processId, 'return "hello from " .. "aos"', signer)
  checkEqual(outputData(r2), 'hello from aos', 'string concat evaluated')

  // Persistent state across messages.
  await evalLua(ao, processId, 'Counter = (Counter or 0) + 1; return Counter', signer)
  const r4 = await evalLua(ao, processId, 'Counter = (Counter or 0) + 1; return Counter', signer)
  checkEqual(outputData(r4), '2', 'Counter persisted and incremented across messages')

  check(true, 'Arweave-signed spawn + eval works end-to-end')
})
