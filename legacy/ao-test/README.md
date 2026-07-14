# ao-test

Smoke tests for AO functionality on a [HyperBEAM](https://github.com/permaweb/hyperbeam)
node, using [bun](https://bun.sh) and [`@permaweb/aoconnect`](https://github.com/permaweb/ao/tree/main/connect)
in **mainnet** mode.

Each test spawns an AOS process, `Eval`s some Lua against it, and asserts the
output — first signing with an **Arweave** wallet (phase 1), then with an **EVM**
wallet (phase 2). Shared signing/auth helpers live in `helpers.ts`.

## Files

| Path | Purpose |
|---|---|
| `helpers.ts` | `loadWallet`, `resolveAuthority`, `createEthSigner` (EVM, dev-provided) |
| `smoke-util.ts` | Logging, assertions, eval→result flow (with retry), authority + unique-name helpers |
| `node-info-test.ts` | Node is up; reports operator/scheduler address |
| `arweave-spawn-eval-test.ts` | Phase 1 — Arweave-signed spawn + eval |
| `evm-spawn-eval-test.ts` | Phase 2 — EVM-signed spawn + eval |
| `spawn-example-test.ts` | Original reference example (EVM, bundled-Lua eval) |

## Setup

```sh
cd ao-test
bun install
cp .env.example .env   # then edit it
```

## Running

```sh
bun run info      # node liveness + operator address
bun run arweave   # phase 1 — Arweave-signed spawn + eval
bun run evm       # phase 2 — EVM-signed spawn + eval
bun run smoke     # info + arweave
```

Point at any node with `HB_URL`. Each script prints clearly and exits non-zero on
the first failed assertion. `EVAL_RETRIES` (default 3) retries transient eval
failures.

## Status / findings

- **Both Arweave and EVM spawn+eval pass end-to-end against Forward's public
  nodes** (`HB_URL=https://push.forward.computer`). This validates the harness,
  signers, and aoconnect `0.0.98`.
- **Authority matters.** A HyperBEAM node only computes a process whose
  `Authority` is in its `genesis-wasm-import-authorities` list — usually a
  SEPARATE address from the node's own operator address. Using the operator
  address spawns fine but then silently 504s on the eval push. The tests
  auto-resolve the right authority via `resolveImportAuthority()`; override with
  the `AUTHORITY` env var.
- **Unique process names.** HyperBEAM hooks a new spawn into an EXISTING process
  if the `Name` tag matches one it already has. Tests use `uniqueName()` so every
  run gets a fresh process.
- **Forward's public nodes are flaky** under load — identical requests can return
  200 / 400 / 504 from one minute to the next. Hence the eval retry. For
  deterministic runs, a local node is preferable (see below).
### Self-hosting (the real goal: no dependence on Forward) — WORKING ✅

Local node = `docker-compose` `hyperbeam-edge-release-image`, port 8734.
**Both Arweave and EVM spawn+eval pass end-to-end against the local node** — no
Forward dependency, and faster/more reliable than Forward's public nodes.

The two things that matter:

1. **Image must be `…:v0.9-final`** — it's version-sensitive:
   - `…e49eb6c` (v0.10): spawn rejected (`process_not_verified`). ✗
   - `…4135280` (v0.9 commit): spawns, but eval message rejected by the scheduler
     (`verify(Req, signers)=false`, `dev_scheduler.erl:478`). ✗
   - **`v0.9-final`: spawn + eval both work for Arweave and EVM. ✓** ← pinned.
2. **Typed config goes in JSON, not `.flat`.** `.flat` coerces every value to a
   string, so booleans/lists silently break. The service sets `HB_CONFIG=config.json`
   and mounts `config.release.json`, which sets `scheduler-default-commitment-spec:
   ans104@1.0` (to match aoconnect's ans104 signing).

Notes:
- `genesis-wasm-import-authorities` defaults (hardcoded in `hb_opts.erl`) to a
  Forward authority address; eval still works against the local node with it. For a
  fully independent node you may eventually set your own authority, but it governs
  checkpoint import, not the live eval path.
- Known HyperBEAM bug: `debug-print: true` leaks memory ~250 MB/s at boot and the
  node never starts (would OOM any host) — don't enable it.

## Run a local node (Podman)

The repo root `docker-compose.yml` uses Podman locally and includes a
`hyperbeam-edge-release-image` service that runs the prebuilt image pinned at the
top of the file (skips the long source build). Bind mounts use `:z` SELinux
labels so the container can read the config/wallet on Fedora.

```sh
# from the repo root — WALLET_FILE is the node's own signing key
WALLET_FILE=./ao-test/test-keys/node-wallet.json \
  podman compose up -d hyperbeam-edge-release-image
```

The node listens on **http://localhost:8734**. (See the status note above — spawns
against this image currently fail `process_not_verified`.)

## API notes (verified against `@permaweb/aoconnect@0.0.98`)

- `connect({ MODE: 'mainnet', URL, signer })` → `{ spawn, message, result, dryrun, request, ... }`
- `spawn({ module, scheduler?, authority?, tags?, data? })` → `processId`.
- `message({ process, tags, data })` → returns a **slot number**; with
  `require-codec: application/json` it computes synchronously (this is what 504s
  under load).
- `result({ process, slot })` → `{ Output, Messages, Spawns, Assignments, Error }`.
- No first-party EVM signer exists; EVM signing uses the custom RawSigner
  `createEthSigner` in `helpers.ts` over `@dha-team/arbundles`' `EthereumSigner`.
