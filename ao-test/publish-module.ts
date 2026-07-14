// Publish a lua module (default: lua/smoke.lua) to Arweave as an ANS-104 data
// item via up.arweave.net (free for items under ~100 KiB), then wait until a
// gateway serves it — the HyperBEAM node loads the module through its gateway
// store, so the test suite can't run until the module is fetchable.
//
// Usage:
//   WALLET_FILE=./test-keys/client-wallet.json bun run publish-module.ts [path/to/module.lua]
//
// Prints the module tx id; put it in .env as MODULE=<id>.

import 'dotenv/config'
import { readFileSync } from 'fs'
import { basename } from 'path'
import { createData, ArweaveSigner } from '@dha-team/arbundles'
import { loadWallet } from './helpers'
import { step, info, warn, pass, check, sleep } from './smoke-util'

const WALLET_FILE = process.env.WALLET_FILE || ''
// Tried in order; first accepted upload wins. UPLOAD_URL replaces the list.
// (up.arweave.net preferred; Turbo kept as fallback pending Forward's advice.)
const UPLOAD_URLS = process.env.UPLOAD_URL
  ? [process.env.UPLOAD_URL]
  : ['https://up.arweave.net/tx', 'https://upload.ardrive.io/v1/tx']
const GATEWAY = process.env.GATEWAY || 'https://arweave.net'
const MODULE_PATH = process.argv[2] || 'lua/smoke.lua'

async function main () {
  if (!WALLET_FILE) throw new Error('WALLET_FILE is required (path to an Arweave JWK)')

  step(`Reading ${MODULE_PATH}`)
  const source = readFileSync(MODULE_PATH, 'utf-8')
  info('bytes', source.length)
  check(source.length < 100 * 1024, 'module is under the ~100 KiB free upload limit')

  step('Signing ANS-104 data item')
  const signer = new ArweaveSigner(loadWallet(WALLET_FILE))
  const item = createData(source, signer, {
    tags: [
      { name: 'Content-Type', value: 'application/lua' },
      { name: 'Data-Protocol', value: 'ao' },
      { name: 'Type', value: 'Module' },
      { name: 'Module-Format', value: 'lua' },
      { name: 'File-Name', value: basename(MODULE_PATH) },
    ],
  })
  await item.sign(signer)
  const id = item.id
  info('module id', id)

  let uploaded = false
  for (const url of UPLOAD_URLS) {
    step(`Uploading to ${url}`)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(item.getRaw()),
      })
      if (res.ok) {
        info('upload response', (await res.text()).slice(0, 300))
        uploaded = true
        break
      }
      warn(`upload to ${url} rejected (${res.status}): ${(await res.text()).slice(0, 200)}`)
    } catch (err) {
      warn(`upload to ${url} failed: ${(err as Error).message}`)
    }
  }
  check(uploaded, 'module uploaded')

  step(`Waiting for ${GATEWAY} to serve the module`)
  const rawDeadline = Date.now() + 120_000
  while (true) {
    const probe = await fetch(`${GATEWAY}/raw/${id}`)
    if (probe.ok) {
      const body = await probe.text()
      check(body === source, 'gateway serves the exact module source')
      break
    }
    if (Date.now() > rawDeadline) {
      throw new Error(`gateway did not serve ${id} within 120s (last status ${probe.status})`)
    }
    await sleep(5000)
  }

  // Raw availability is NOT enough for HyperBEAM: hb_gateway_client loads
  // modules via GraphQL (it needs the ANS-104 metadata — owner, signature,
  // tags — to reconstruct the committed message), so the node can only load
  // the module once the GraphQL index has it. Bundler→index lag can be many
  // minutes.
  step(`Waiting for ${GATEWAY}/graphql to index the module (node loads via GraphQL; this can take a while)`)
  const gqlDeadline = Date.now() + 45 * 60_000
  while (true) {
    const res = await fetch(`${GATEWAY}/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query { transactions(ids: ["${id}"]) { edges { node { id } } } }`,
      }),
    })
    if (res.ok) {
      const body = await res.json() as any
      if (body?.data?.transactions?.edges?.length > 0) {
        pass('GraphQL index has the module — the node can load it now')
        break
      }
    }
    if (Date.now() > gqlDeadline) {
      throw new Error(`GraphQL did not index ${id} within 45m — retry later; the tests will fail with a push 400 until it lands`)
    }
    info('not indexed yet', `retrying in 30s (deadline ${new Date(gqlDeadline).toISOString()})`)
    await sleep(30_000)
  }

  console.log(`\nPublished. Add to .env:\n\nMODULE=${id}\n`)
}

main().catch(err => { console.error(err); process.exit(1) })
