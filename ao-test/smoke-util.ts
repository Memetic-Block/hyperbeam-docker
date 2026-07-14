// Shared helpers for the lua smoke tests: logging, assertions, and the
// spawn/interact/read flow against a HyperBEAM node in aoconnect mainnet mode.
//
// The processes here run our authored module (lua/smoke.lua) with
// `execution-device: lua@5.3a` — no genesis-wasm anywhere.

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[2m',
}

const HB_URL = process.env.HB_URL || 'http://localhost:8734'

export function step (msg: string) { console.log(`${c.cyan}▶${c.reset} ${msg}`) }
export function pass (msg: string) { console.log(`${c.green}✓${c.reset} ${msg}`) }
export function warn (msg: string) { console.log(`${c.yellow}!${c.reset} ${msg}`) }
export function info (label: string, value: unknown) {
  console.log(`  ${c.dim}${label}:${c.reset} ${fmt(value)}`)
}

export function check (cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${msg}`)
  pass(msg)
}

export function checkEqual (actual: unknown, expected: unknown, msg: string) {
  if (String(actual) !== String(expected)) {
    throw new Error(
      `Assertion failed: ${msg}\n    expected: ${fmt(expected)}\n    actual:   ${fmt(actual)}`,
    )
  }
  pass(`${msg} (= ${fmt(actual)})`)
}

function fmt (v: unknown): string {
  if (typeof v === 'string') return v
  try { return JSON.stringify(v) } catch { return String(v) }
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * Build a guaranteed-unique process Name. HyperBEAM will hook a new spawn into
 * an EXISTING process if the `Name` tag matches one it already has — so every
 * smoke run must use a fresh name or it may silently reuse a stale process.
 */
export function uniqueName (prefix: string): string {
  return `${prefix}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`
}

/**
 * Spawn a process running our smoke module on the lua device. aoconnect
 * 0.0.98 hardcodes `execution-device: genesis-wasm@1.0`, but user tags are
 * spread after the defaults, so the tag here overrides it.
 */
export async function spawnSmokeProcess (
  ao: any,
  { module, scheduler, authority, signer, namePrefix }: {
    module: string, scheduler: string, authority: string,
    signer: any, namePrefix: string,
  },
): Promise<string> {
  const processId = await ao.spawn({
    module,
    scheduler,
    authority,
    signer,
    tags: [
      { name: 'execution-device', value: 'lua@5.3a' },
      { name: 'Name', value: uniqueName(namePrefix) },
      { name: 'Authority', value: authority },
    ],
    data: 'lua smoke test process',
  })
  check(typeof processId === 'string' && processId.length > 0, 'spawn returned a process id')
  info('processId', processId)
  return processId
}

/**
 * Send an `Action` message to the process and read back the slot's result.
 * Retries transient failures (public nodes can 504 under load). The smoke
 * module reports handler errors as `output.data` strings starting with
 * `error:` while the slot itself computes OK — use `sendActionOnce` when a
 * test wants to observe a hard slot failure instead.
 */
export async function sendAction (
  ao: any,
  processId: string,
  action: string,
  { tags = [], data = '', signer, retries }: {
    tags?: { name: string, value: string }[],
    data?: string,
    signer?: any,
    retries?: number,
  } = {},
) {
  const attempts = retries ?? Number(process.env.EVAL_RETRIES ?? 3)
  let lastErr: unknown
  for (let i = 1; i <= attempts; i++) {
    try {
      return await sendActionOnce(ao, processId, action, { tags, data, signer })
    } catch (err) {
      lastErr = err
      if (i < attempts) {
        warn(`${action} attempt ${i}/${attempts} failed (${(err as Error).message}); retrying…`)
        await sleep(2000 * i)
      }
    }
  }
  throw lastErr
}

/** Single-shot variant of sendAction: no retry, propagates hard failures. */
export async function sendActionOnce (
  ao: any,
  processId: string,
  action: string,
  { tags = [], data = '', signer }: {
    tags?: { name: string, value: string }[],
    data?: string,
    signer?: any,
  } = {},
) {
  step(`Action: ${action}${tags.length ? ' ' + fmt(tags) : ''}`)
  const slot = await ao.message({
    process: processId,
    tags: [{ name: 'Action', value: action }, ...tags],
    data,
    signer,
  })
  info('slot', slot)
  const result = { output: await readResult(processId, slot) }
  info('output', outputData(result))
  return { slot, result }
}

/**
 * Read a computed slot's output over plain HTTP. aoconnect 0.0.98's
 * `result()` is unusable for lua results: the JSON codec serializes nested
 * maps as `+link` references, so `results` comes back as `{output+link: …}`
 * and normalizeOutput finds nothing. One more path hop inlines the level we
 * need: `…/results/output/serialize~json@1.0` → `{ data: … }`.
 */
export async function readResult (processId: string, slot: number | string) {
  const url = `${HB_URL}/${processId}~process@1.0/compute&slot=${slot}/results/output/serialize~json@1.0`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`result read failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
  }
  return await res.json()
}

/** Pull the output data out of a result (lua device uses lowercase keys). */
export function outputData (result: any): unknown {
  return result?.output?.data ?? result?.Output?.data ?? result?.Output ?? result?.output
}

/**
 * Read a path under the process's current state over plain HTTP:
 *   GET {hbUrl}/{processId}~process@1.0/now/{path}
 * With `json: true`, appends `/serialize~json@1.0` so nested maps come back
 * as a JSON document. Returns status/body/content-type without throwing, so
 * tests can also observe failure modes.
 */
export async function readNow (
  hbUrl: string,
  processId: string,
  path = '',
  { json = false }: { json?: boolean } = {},
) {
  const suffix = (path ? `/${path}` : '') + (json ? '/serialize~json@1.0' : '')
  const url = `${hbUrl}/${processId}~process@1.0/now${suffix}`
  try {
    const res = await fetch(url)
    return {
      url,
      ok: res.ok,
      status: res.status,
      contentType: res.headers.get('content-type') ?? '',
      text: await res.text(),
    }
  } catch (err) {
    return { url, ok: false, status: 0, contentType: '', text: String(err) }
  }
}

/** Wrap a test's main() so failures print clearly and set a non-zero exit code. */
export async function run (name: string, main: () => Promise<void>) {
  console.log(`\n${c.cyan}=== ${name} ===${c.reset}`)
  const t0 = Date.now()
  try {
    await main()
    console.log(`\n${c.green}PASS${c.reset} ${name} ${c.dim}(${((Date.now() - t0) / 1000).toFixed(1)}s)${c.reset}\n`)
    process.exit(0)
  } catch (err) {
    const e = err as Error
    console.error(`\n${c.red}FAIL${c.reset} ${name}\n${c.red}${e.stack ?? e.message}${c.reset}\n`)
    process.exit(1)
  }
}
