// Phase 2 — EVM smoke test: spawn a lua-device process from our smoke module,
// signed with an EVM private key (custom RawSigner in helpers.ts), then send
// interactions and assert results and readable state.

import 'dotenv/config'
import { connect } from '@permaweb/aoconnect'
import { EthereumSigner } from '@dha-team/arbundles'
import { createEthSigner, resolveAuthority } from './helpers'
import {
  run, step, info, check, checkEqual, sleep,
  spawnSmokeProcess, sendAction, outputData, readNow,
} from './smoke-util'

const HB_URL = process.env.HB_URL || 'http://localhost:8734'
const MODULE = process.env.MODULE || ''
const SCHEDULER = process.env.SCHEDULER
const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY || ''

run('evm spawn + interact (lua)', async () => {
  if (!EVM_PRIVATE_KEY) throw new Error('EVM_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY) is required')
  if (!MODULE) throw new Error('MODULE is required — run `bun run publish` first and put the id in .env')

  step('Building EVM signer from private key')
  const ethSigner = new EthereumSigner(EVM_PRIVATE_KEY)
  const signer = await createEthSigner(ethSigner)
  check(signer != null, 'createEthSigner returned a signer')

  const ao: any = connect({ MODE: 'mainnet', URL: HB_URL, signer, SCHEDULER } as any)

  const authority = (await resolveAuthority(HB_URL)).trim()
  const scheduler = SCHEDULER || authority
  step('Spawning lua process')
  info('module', MODULE)
  info('scheduler', scheduler)
  const processId = await spawnSmokeProcess(ao, {
    module: MODULE, scheduler, authority, signer, namePrefix: 'evm-lua-smoke',
  })

  step('Waiting for spawn to settle')
  await sleep(5000)

  const ping = await sendAction(ao, processId, 'ping', { signer })
  checkEqual(outputData(ping.result), 'pong', 'ping returned pong (EVM-signed)')

  await sendAction(ao, processId, 'increment', { signer })
  const inc2 = await sendAction(ao, processId, 'increment', { signer })
  checkEqual(outputData(inc2.result), '2', 'count persisted across messages (EVM-signed)')

  const count = await readNow(HB_URL, processId, 'state/counters/count')
  checkEqual(count.text, '2', 'GET /now/state/counters/count reads the live count')

  check(true, 'EVM-signed spawn + interact works end-to-end on the lua device')
})
