// Phase 2 — EVM smoke test: spawn an AOS process signed with an EVM private key
// (using the dev-provided createEthSigner in helpers.ts), then Eval and assert.

import 'dotenv/config'
import { connect } from '@permaweb/aoconnect'
import { EthereumSigner } from '@dha-team/arbundles'
import { createEthSigner } from './helpers'
import { run, step, info, check, checkEqual, sleep, evalLua, outputData, resolveImportAuthority, uniqueName } from './smoke-util'

const HB_URL = process.env.HB_URL || 'http://localhost:8734'
const MODULE = process.env.MODULE || 'ISShJH1ij-hPPt9St5UFFr_8Ys3Kj5cyg7zrMGt7H9s'
const SCHEDULER = process.env.SCHEDULER
const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY || ''

run('evm spawn + eval', async () => {
  if (!EVM_PRIVATE_KEY) throw new Error('EVM_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY) is required')

  step('Building EVM signer from private key')
  const ethSigner = new EthereumSigner(EVM_PRIVATE_KEY)
  const signer = await createEthSigner(ethSigner)
  check(signer != null, 'createEthSigner returned a signer')

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
      { name: 'Name', value: uniqueName('evm-smoke') },
      { name: 'Authority', value: authority },
    ],
    data: 'evm smoke test',
  })
  info('processId', processId)
  check(typeof processId === 'string' && processId.length > 0, 'spawn returned a process id (EVM-signed)')

  step('Waiting for spawn to settle')
  await sleep(5000)

  const r1 = await evalLua(ao, processId, 'return 1 + 1', signer)
  checkEqual(outputData(r1), '2', '1 + 1 evaluated to 2 (EVM-signed)')

  const r2 = await evalLua(ao, processId, 'return "evm ok"', signer)
  checkEqual(outputData(r2), 'evm ok', 'string eval (EVM-signed)')

  check(true, 'EVM-signed spawn + eval works end-to-end')
})
