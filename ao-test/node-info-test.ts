// Liveness smoke test: confirm the HyperBEAM node is up and report its
// operator/scheduler address (the default scheduler/authority for spawns).

import 'dotenv/config'
import { resolveAuthority } from './helpers'
import { run, step, info, check, checkEqual } from './smoke-util'

const HB_URL = process.env.HB_URL || 'http://localhost:8734'

run('node-info', async () => {
  info('HB_URL', HB_URL)

  step('GET /~meta@1.0/info')
  const res = await fetch(`${HB_URL}/~meta@1.0/info`)
  checkEqual(res.status, 200, 'node responded 200 to ~meta@1.0/info')
  info('info (truncated)', (await res.text()).slice(0, 300))

  step('Resolve operator/scheduler address')
  const address = (await resolveAuthority(HB_URL)).trim()
  info('node address', address)
  check(address.length > 0, 'node returned a non-empty operator/scheduler address')
})
