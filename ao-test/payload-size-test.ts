// Payload-size probe — how big can a single message be, end-to-end?
//
// Motivation: batching per-node score updates into many messages causes
// message bloat and redundant compute; ideally ONE Add-Scores message carries
// the whole fleet's scores. Source reading (v0.9-FINAL) says:
//   - HyperBEAM's HTTP server has NO body-size cap (read_body loops until done)
//   - the scheduler has no message-size check
//   - the node's archival uploads to the bundler (up.arweave.net) are
//     fire-and-forget: hb_client:upload results are IGNORED by
//     dev_scheduler_server, so bundler free-tier limits (~100 KiB) do NOT
//     block scheduling — but oversized messages may silently fail to archive
//     to Arweave (auditability trade-off!).
// This probe finds the PRACTICAL ceiling: escalating JSON-shaped payloads
// through push → schedule → luerl compute → result, with a health check
// (ping) after each size so we also learn whether an oversized message merely
// fails or poisons the process.

import 'dotenv/config'
import { connect, createSigner } from '@permaweb/aoconnect'
import { loadWallet, resolveAuthority } from './helpers'
import {
  run, step, info, warn, check, checkEqual, sleep,
  spawnSmokeProcess, sendActionOnce, outputData,
} from './smoke-util'

const HB_URL = process.env.HB_URL || 'http://localhost:8734'
const WALLET_FILE = process.env.WALLET_FILE || ''
const MODULE = process.env.MODULE || ''
const SCHEDULER = process.env.SCHEDULER
// KiB sizes to probe, escalating. Override: SIZES=16,64,256,1024
const SIZES = (process.env.SIZES || '16,64,128,256,512,1024,2048')
  .split(',').map(s => Number(s.trim()))

/** Build a JSON-shaped scores payload of ~`kib` KiB and report entry count. */
function scoresPayload (kib: number): { payload: string, entries: number } {
  const target = kib * 1024
  const scores: Record<string, object> = {}
  let i = 0
  // ~90 bytes per entry — roughly one relay's score record.
  while (JSON.stringify(scores).length < target - 100) {
    scores[`relay-fingerprint-${String(i).padStart(8, '0')}`] = {
      score: 1000 + i, uptime: 99.9, seen: 1783990000 + i,
    }
    i++
  }
  return { payload: JSON.stringify({ action: 'add-scores', scores }), entries: i }
}

run('payload size probe (lua)', async () => {
  if (!WALLET_FILE) throw new Error('WALLET_FILE is required (path to an Arweave JWK)')
  if (!MODULE) throw new Error('MODULE is required — run `bun run publish` first and put the id in .env')

  const signer = createSigner(loadWallet(WALLET_FILE))
  const ao: any = connect({ MODE: 'mainnet', URL: HB_URL, signer, SCHEDULER } as any)
  const authority = (await resolveAuthority(HB_URL)).trim()
  const scheduler = SCHEDULER || authority

  step('Spawning probe process')
  let pid = await spawnSmokeProcess(ao, {
    module: MODULE, scheduler, authority, signer, namePrefix: 'payload-probe',
  })
  await sleep(5000)

  const results: string[] = []
  let smallestVerified = 0

  for (const kib of SIZES) {
    const { payload, entries } = scoresPayload(kib)
    step(`Probing ${kib} KiB (${payload.length} bytes ≈ ${entries} node entries)`)
    const t0 = Date.now()
    try {
      const res = await sendActionOnce(ao, pid, 'data-length', { signer, data: payload })
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
      checkEqual(outputData(res.result), String(payload.length),
        `${kib} KiB round-tripped; lua saw every byte (${elapsed}s)`)
      results.push(`${kib} KiB (~${entries} entries): OK in ${elapsed}s`)
      if (!smallestVerified) smallestVerified = kib
    } catch (err) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
      warn(`${kib} KiB FAILED after ${elapsed}s: ${(err as Error).message}`)
      results.push(`${kib} KiB (~${entries} entries): FAILED (${(err as Error).message})`)
      // Did the failure poison the process, or just get rejected?
      try {
        const pong = await sendActionOnce(ao, pid, 'ping', { signer })
        checkEqual(outputData(pong.result), 'pong', 'process still healthy after the failed size')
      } catch {
        warn('process POISONED by the failed payload — spawning a fresh one for remaining sizes')
        pid = await spawnSmokeProcess(ao, {
          module: MODULE, scheduler, authority, signer, namePrefix: 'payload-probe',
        })
        await sleep(5000)
      }
    }
  }

  step('Summary')
  for (const line of results) info('probe', line)
  check(smallestVerified > 0, `at least the smallest probe size worked (${smallestVerified} KiB)`)
})
