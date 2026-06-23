// Shared helpers for the smoke tests: logging, assertions, and the
// spawn/eval/result flow against a HyperBEAM node in aoconnect mainnet mode.

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[2m',
}

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
 * Resolve the authority a process should declare so the node's genesis-wasm
 * executor will import/compute its messages.
 *
 * HyperBEAM nodes only compute messages for processes whose `Authority` is in
 * the node's `genesis-wasm-import-authorities` list — which is typically a
 * SEPARATE address from the node's own operator address. Using the node's own
 * address spawns fine but then silently 504s on the eval push. We read the
 * configured import authority and use that.
 *
 * Precedence: AUTHORITY env > genesis-wasm-import-authorities > node address.
 */
export async function resolveImportAuthority (url: string): Promise<string> {
  if (process.env.AUTHORITY) return process.env.AUTHORITY
  try {
    const res = await fetch(
      `${url}/~meta@1.0/info/genesis-wasm-import-authorities/serialize~json@1.0`,
    )
    if (res.ok) {
      const list = await res.json()
      const authorities = Object.entries(list)
        .filter(([k]) => k !== 'device')
        .map(([, v]) => v)
        .filter((v): v is string => typeof v === 'string')
      if (authorities.length > 0) {
        if (authorities.length > 1) {
          warn(`node lists ${authorities.length} import authorities; using the first`)
        }
        return authorities[0]
      }
    }
  } catch {
    // fall through to node address
  }
  const addr = await fetch(`${url}/~meta@1.0/info/address`)
  if (!addr.ok) throw new Error(`Failed to resolve authority from ${url}: ${addr.status}`)
  return (await addr.text()).trim()
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

/**
 * Send an `Action: Eval` message with Lua `code`, then read back the result.
 * `ao` is a connected aoconnect mainnet client. Returns the normalized result.
 */
export async function evalLua (ao: any, processId: string, code: string, signer?: any) {
  step(`Eval: ${code}`)
  // Public HyperBEAM nodes can transiently 504/error under load; retry a few times.
  const attempts = Number(process.env.EVAL_RETRIES ?? 3)
  let lastErr: unknown
  for (let i = 1; i <= attempts; i++) {
    try {
      const slot = await ao.message({
        process: processId,
        tags: [{ name: 'Action', value: 'Eval' }],
        data: code,
        signer,
      })
      info('slot', slot)
      const result = await ao.result({ process: processId, slot })
      info('Output', result?.Output)
      if (result?.Error) throw new Error(`Eval returned Error: ${fmt(result.Error)}`)
      return result
    } catch (err) {
      lastErr = err
      if (i < attempts) {
        warn(`eval attempt ${i}/${attempts} failed (${(err as Error).message}); retrying…`)
        await sleep(2000 * i)
      }
    }
  }
  throw lastErr
}

/** Pull the `data`/`Data` field out of a normalized Eval result's Output. */
export function outputData (result: any): unknown {
  return result?.Output?.data ?? result?.Output?.Data ?? result?.Output
}
