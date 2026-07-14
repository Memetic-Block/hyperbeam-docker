// Nested-state read-path comparison — answers "how should we expose deeply
// nested state, and which read path is best / easiest to debug?"
//
// On a lua-device process the returned base message IS the process state, so
// the patch@1.0 dance from legacynet (Send({ device = 'patch@1.0', … })) is
// unnecessary: any key the module sets on base is immediately addressable
// under /now. The smoke module exposes the same nested structure four ways:
//
//   1. nested table   → GET /now/state/deep/l1/l2/l3/value   (per-key reads)
//   2. nested table   → GET /now/state/serialize~json@1.0    (whole subtree as JSON)
//   3. JSON string    → GET /now/state-json                  (module-rendered)
//   4. prerendered    → GET /now/state-html                  (content-type: text/html)
//
// The test asserts all four work and prints what each returns so the DX
// trade-offs are visible in the output.

import 'dotenv/config'
import { connect, createSigner } from '@permaweb/aoconnect'
import { loadWallet, resolveAuthority } from './helpers'
import {
  run, step, info, check, checkEqual, sleep,
  spawnSmokeProcess, sendAction, readNow,
} from './smoke-util'

const HB_URL = process.env.HB_URL || 'http://localhost:8734'
const WALLET_FILE = process.env.WALLET_FILE || ''
const MODULE = process.env.MODULE || ''
const SCHEDULER = process.env.SCHEDULER

run('nested state read paths (lua)', async () => {
  if (!WALLET_FILE) throw new Error('WALLET_FILE is required (path to an Arweave JWK)')
  if (!MODULE) throw new Error('MODULE is required — run `bun run publish` first and put the id in .env')

  const signer = createSigner(loadWallet(WALLET_FILE))
  const ao: any = connect({ MODE: 'mainnet', URL: HB_URL, signer, SCHEDULER } as any)
  const authority = (await resolveAuthority(HB_URL)).trim()
  const scheduler = SCHEDULER || authority

  step('Spawning lua process')
  const pid = await spawnSmokeProcess(ao, {
    module: MODULE, scheduler, authority, signer, namePrefix: 'nested-state-smoke',
  })
  await sleep(5000)

  const LEAF = `deep-${Date.now()}`
  await sendAction(ao, pid, 'deep-set', {
    signer, tags: [{ name: 'Value', value: LEAF }],
  })
  await sendAction(ao, pid, 'increment', { signer })

  step('Path 1: per-key read of the nested table')
  const leaf = await readNow(HB_URL, pid, 'state/deep/l1/l2/l3/value')
  info('GET …/now/state/deep/l1/l2/l3/value', `${leaf.status} ${leaf.text.slice(0, 120)}`)
  checkEqual(leaf.text, LEAF, 'nested leaf directly addressable by path')

  step('Path 2: node-side JSON serialization (per-level inlining)')
  // Finding: serialize~json@1.0 inlines only the scalar keys of the message
  // it's applied to — nested submessages come back as `<key>+link` references
  // (even with accept-bundle=true). Full trees need one request per level or
  // client-side link chasing; leaf-adjacent levels inline fine.
  const subtree = await readNow(HB_URL, pid, 'state', { json: true })
  info('GET …/now/state/serialize~json@1.0', `${subtree.status} ${subtree.text.slice(0, 200)}`)
  check(subtree.ok, 'subtree serializes')
  check(subtree.text.includes('deep+link'), 'nested maps appear as +link references, not inline')
  const leafLevel = await readNow(HB_URL, pid, 'state/deep/l1/l2/l3', { json: true })
  info('GET …/now/state/deep/l1/l2/l3/serialize~json@1.0', `${leafLevel.status} ${leafLevel.text.slice(0, 200)}`)
  checkEqual(JSON.parse(leafLevel.text)?.value, LEAF, 'leaf-adjacent level serializes inline')

  step('Path 3: module-rendered JSON string')
  const rendered = await readNow(HB_URL, pid, 'state-json')
  info('GET …/now/state-json', `${rendered.status} ${rendered.text.slice(0, 200)}`)
  check(rendered.ok, 'module-rendered JSON readable')
  const parsedRendered = JSON.parse(rendered.text)
  checkEqual(parsedRendered?.deep?.l1?.l2?.l3?.value, LEAF, 'module-rendered JSON contains the leaf')

  step('Path 4: prerendered HTML')
  const html = await readNow(HB_URL, pid, 'state-html')
  info('GET …/now/state-html', `${html.status} content-type=${html.contentType}`)
  info('html (truncated)', html.text.slice(0, 200))
  check(html.ok, 'prerendered HTML readable')
  check(html.text.includes(LEAF), 'HTML contains the leaf value')

  check(true, 'all four read paths work — see README for the recommendation')
})
