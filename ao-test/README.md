# ao-test (lua device)

Smoke tests for AO functionality on a [HyperBEAM](https://github.com/permaweb/hyperbeam)
node using **lua-device compute** (`execution-device: lua@5.3a`), with
[bun](https://bun.sh) and [`@permaweb/aoconnect`](https://github.com/permaweb/ao/tree/main/connect)
`0.0.98` in **mainnet** mode. The legacy genesis-wasm suite lives in
[../legacy/ao-test](../legacy/ao-test/).

Processes here run [lua/smoke.lua](lua/smoke.lua), a module we author and
publish ourselves. Unlike legacynet, `Module` is **lua source on Arweave**, not
a wasm binary: the node loads the source through its gateway store and runs it
in luerl (a Lua VM inside the BEAM). No genesis-wasm server, no wasm.

## What the suite verifies

1. **Spawn + interactions with both wallet types** — `arweave-spawn-test.ts`
   (Arweave JWK) and `evm-spawn-test.ts` (EVM key via the custom RawSigner in
   `helpers.ts`).
2. **State reverts on error** — `revert-on-error-test.ts`, with writes before
   and after the error. See *Error semantics* below: this behavior is
   module-owned on hyperbeam, and our module implements it.
3. **Deeply nested state exposure** — `nested-state-test.ts` compares four
   read paths (per-key, node-serialized JSON, module-rendered JSON string,
   prerendered HTML).
4. **Single-message payload ceiling** — `payload-size-test.ts` probes how big
   one message can be (motivated by batching all node scores into one
   Add-Scores message instead of many).

## Setup

```sh
cd ao-test
bun install
cp .env.example .env   # then edit it

# one-time: publish the smoke module and put the printed id in .env as MODULE=
WALLET_FILE=./test-keys/client-wallet.json bun run publish
```

Module uploads go to `up.arweave.net` first, falling back to Turbo
(`upload.ardrive.io`); both are free under ~100 KiB. Override with
`UPLOAD_URL`.

The publish script waits for TWO things: the gateway serving the raw source
(fast), then the **GraphQL index** picking up the data item (can take many
minutes). The second wait is the one that matters — HyperBEAM loads modules
via GraphQL (`hb_gateway_client` needs the ANS-104 metadata to reconstruct the
committed message), so until the item is indexed every push against a process
using the module fails with a 400.

## Running

```sh
bun run info      # node liveness + operator address + lua device present
bun run arweave   # Arweave-signed spawn + interactions
bun run evm       # EVM-signed spawn + interactions
bun run revert    # revert-on-error matrix
bun run nested    # nested-state read-path comparison
bun run smoke     # info + arweave + evm
bun run full      # everything
```

Point at any node with `HB_URL`. Each script prints clearly and exits non-zero
on the first failed assertion. `EVAL_RETRIES` (default 3) retries transient
failures.

## How lua-device processes differ from legacynet / genesis-wasm

- **The returned base message IS the process state.** `compute(base, assignment,
  opts)` returns the new state; every key set on `base` is immediately readable:
  `GET /<pid>~process@1.0/now/state/counters/count`. The legacynet patch dance
  (`Send({ device = 'patch@1.0', cache = { … } })`) exists because wasm memory
  is opaque; with lua it is unnecessary. (The `patch@1.0` device still exists
  for stack setups — `dev_genesis_wasm` used it with
  `patch-from: /results/outbox` — but flat ANS-104 spawn tags can't express a
  `device-stack` list, and there's no need for it here.)
- **Spawn shape** (aoconnect `0.0.98` hardcodes genesis-wasm, but user tags win):
  spawn with tag `execution-device: lua@5.3a` and `module` = txid of lua source.
- **No import-authority gating.** Authority defaults to the node's operator
  address; there is no `genesis-wasm-import-authorities` list in the lua path.

### Error semantics (the part we depended on in legacynet)

There are two layers, and neither gives legacynet semantics for free
(all rows verified against a local `v0.9-final` node, 2026-07-13):

| Layer | What happens | State | Process |
|---|---|---|---|
| Handler error **caught by the module** (pcall + snapshot restore — what `smoke.lua` does) | slot computes OK, result reports `error: …` | **reverted by the module** ✓ | keeps advancing ✓ |
| Handler error caught hyper-aos-style (pcall, **no** restore) | slot computes OK | **mutations before the error PERSIST** | keeps advancing |
| **Uncaught** lua error | `dev_lua` errors, `dev_process` does not store the slot | reverted by construction | **BRICKED** ✗ — the poisoned assignment stays at its slot: `/now` returns 500 and no later message can compute (confirmed by `revert-on-error-test.ts` Part B) |

**Takeaway:** revert-on-error is the module's job, and pcall is not optional —
an uncaught error permanently wedges the process. `smoke.lua`'s `compute` is
the pattern to copy: a **trampoline that must be trivially infallible** —
snapshot the managed state (itself under pcall), pcall a `protected_compute`
that contains *everything* fallible (state init, dispatch, rendering), restore
the snapshot on failure, and assemble `results` with plain table construction
only. The rule: any line outside a pcall must be incapable of throwing.

What the pattern does NOT cover (keep these in mind for real modules):

- **Module top-level errors** — code outside `compute` runs at VM init; if it
  throws, every slot fails and the process is unusable from birth. Keep
  top-level code minimal and lint/parse before publishing.
- **VM-level failures** — out-of-memory or a luerl internal crash isn't
  catchable by pcall; an infinite loop doesn't error at all, it hangs the
  compute. pcall guards against *lua* errors only.
- **Deliberate `error()` outside the pcall** — smoke.lua's `fail-uncaught` is
  a test hook; real modules should have no such paths.

### Nested state: read-path comparison

`smoke.lua` exposes the same nested structure four ways (all verified working
against a local `v0.9-final` node):

| Path | Read | Notes |
|---|---|---|
| nested table | `GET /now/state/deep/l1/l2/l3/value` | per-key, no client parsing, hashpath-cacheable — best for debugging |
| nested table | `GET /now/state/serialize~json@1.0` | **inlines only that level's scalars** — nested submessages come back as `<key>+link` references (even with `accept-bundle=true`), so full trees need one request per level |
| JSON string | `GET /now/state-json` | module-rendered; whole tree in one request, but an opaque blob you must re-render on every write (and filter node bookkeeping — see below) |
| HTML | `GET /now/state-html` | submessage with `content-type: text/html`; browsers render it directly — good for human dashboards |

**Recommendation:** keep state as a **plain nested table on `base`**: per-key
reads are the debugging workhorse (any sub-path individually GETtable), and
they're what the revert/count assertions in this suite use. For consumers that
want the whole tree in one request, maintain a module-rendered JSON string —
the node-side serializer's `+link` behavior makes it clumsy for deep trees.
HTML for human dashboards. A separate view module (dev_lua can load multiple
lua modules per process) is the heavier version of the same idea — worth it
only if views get big enough to want their own publish cycle.

**Gotcha — commitments pollution:** state read back into lua on later slots
carries `commitments` / `ao-types` bookkeeping on every submessage. Module
renders must filter these keys (see `jsonencode` in `smoke.lua`), and don't be
surprised to see them in node-serialized JSON either.

### Message payload size (single Add-Scores feasibility)

Verified against a local `v0.9-final` node (2026-07-13), JSON-shaped payloads
through push → schedule → luerl compute → byte-exact result:

- **16 KiB → 2 MiB (~27k node-score entries) all pass**, each slot computing
  in ≤ 1s. No transport ceiling found at realistic fleet sizes.
- Source-level: HyperBEAM has **no HTTP body cap** (`read_body` loops until
  done) and **no scheduler size check** (v0.9-FINAL).
- The node's archival uploads to the bundler are **fire-and-forget**
  (`hb_client:upload` results ignored by `dev_scheduler_server`), so bundler
  limits can't block scheduling. During the probe `up.arweave.net` returned
  200 even for the 1–2 MiB items. **Caveat:** a 200 from the bundler ≠
  permanently seeded to Arweave — for auditability, spot-check that large
  messages actually land on a gateway, and remember a silent archival failure
  leaves the message only in the node's local cache.
- `data-length` measures transport, not parsing: a real Add-Scores handler
  must decode the JSON inside luerl (pure-lua decoder; expect it to dominate
  slot time at MiB sizes). If that bites, send scores as **structured message
  keys via an httpsig-signed request** (aoconnect `request()`) so lua receives
  a table with no JSON parse, or chunk into a few 100–500 KiB batches.

## Files

| Path | Purpose |
|---|---|
| `lua/smoke.lua` | The authored module: handlers, revert-on-error, state renders |
| `publish-module.ts` | Sign + upload the module (up.arweave.net → Turbo fallback) |
| `helpers.ts` | `loadWallet`, `resolveAuthority`, `createEthSigner` |
| `smoke-util.ts` | Logging/assertions, `spawnSmokeProcess`, `sendAction`, `readNow` |
| `node-info-test.ts` | Liveness + lua device present |
| `arweave-spawn-test.ts` | Arweave-signed spawn + interactions |
| `evm-spawn-test.ts` | EVM-signed spawn + interactions |
| `revert-on-error-test.ts` | Revert matrix (caught) + uncaught-slot-error probe |
| `nested-state-test.ts` | Four read paths over deeply nested state |

## API notes (verified against `@permaweb/aoconnect@0.0.98`)

- `connect({ MODE: 'mainnet', URL, signer })` → `{ spawn, message, result, request, … }`
- `spawn({ module, scheduler?, authority?, tags?, data? })` → `processId`.
  Defaults `execution-device: genesis-wasm@1.0`, but tags are spread after the
  defaults, so an `execution-device` tag overrides it.
- `message({ process, tags, data })` → slot number (computes via `/push`).
- `result({ process, slot })` is **unusable for lua results**: the JSON codec
  returns nested maps as `+link` references, so it normalizes to `{}`. The
  suite reads results over plain HTTP instead:
  `GET /<pid>~process@1.0/compute&slot=<n>/results/output/serialize~json@1.0`
  (see `readResult` in `smoke-util.ts`).
- No first-party EVM signer; EVM signing uses the RawSigner in `helpers.ts`
  over `@dha-team/arbundles`' `EthereumSigner`.
