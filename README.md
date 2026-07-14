# Docker Images for HyperBEAM

Dockerized setup for running [HyperBEAM](https://github.com/permaweb/hyperbeam) AO mainnet nodes. Builds HyperBEAM from source with all dependencies (Erlang 27, Rebar3, Rust 1.95) using the default rebar3 profile, where the lua device (`~lua@5.3a`) is the AO compute method.

Builds are pinned to the `v0.9-FINAL` tag of HyperBEAM by default (see the `VERSION` build arg).

> **Legacy:** the previous genesis_wasm-based setup (for legacy `ao.TN.1` wasm processes) is deprecated and lives in [legacy/](legacy/) as a known-working config base.

## Prerequisites

- Docker/Podman and Compose
- An Arweave wallet file (JSON keyfile)

## Quick Start

Set the `WALLET_FILE` environment variable to the path of your Arweave wallet (or with .env, see `.env.example`):

```sh
export WALLET_FILE=/path/to/wallet.json
```

Run a node with persistent cache:

```sh
docker compose up hyperbeam
```

The node will be available on port **8734**.

## Services

| Service | Mode | Cache | Description |
|---|---|---|---|
| `hyperbeam` | Dev shell | Persistent | Development node with a named volume for `cache-mainnet` |
| `hyperbeam-ephemeral` | Dev shell | Ephemeral | Development node with no persistent cache |
| `hyperbeam-release` | Release | Persistent | Production release build with a named volume |
| `hyperbeam-release-ephemeral` | Release | Ephemeral | Production release build with no persistent cache |

### Dev shell vs Release

- **Dev shell** services run via `rebar3 shell` — useful for development, debugging, and live interaction with the Erlang shell.
- **Release** services use a compiled OTP release (`./bin/hb foreground`) — suitable for production deployments.

## Configuration

Configuration is provided via `.flat` files mounted into the container:

- [config.flat](config.flat) — used by dev shell services
- [config.release.flat](config.release.flat) — used by release services

Both files set `priv_key_location` to the path where the wallet is mounted inside the container. Note that typed config values (booleans/lists) must come from a JSON config ([config.release.json](config.release.json)) via `HB_CONFIG`; `.flat` coerces values to strings.

## AO compute

This image does **not** include the genesis_wasm server, so it will not compute legacy `ao.TN.1` (wasm) processes. Mainnet processes must declare their own `execution-device` — spawn with `execution-device: lua@5.3a` and a lua module (lua **source** published to Arweave, not a wasm binary) to run AO processes on this node. For legacy wasm processes, use the [legacy](legacy/) image.

## Runtime behavior (entrypoint)

The image ships an entrypoint that hardens two fail-open behaviors of a bare
`hb foreground` container (both verified against `v0.9-FINAL`):

- **Identity is fail-closed.** HyperBEAM silently mints a fresh wallet when
  none exists. The entrypoint refuses to start unless a keyfile exists at
  `HB_WALLET_PATH` (defaults to the path the bundled configs use). Set
  `HB_ALLOW_EPHEMERAL_WALLET=true` to explicitly opt into a throwaway
  identity (e.g. for scratch containers).
- **SIGTERM stops the node.** The bare BEAM (PID 1, relx `foreground`)
  ignores SIGTERM entirely, and `bin/hb stop` (`init:stop()`) wedges partway
  through app shutdown on v0.9-FINAL — the node stays up in `terminating`
  state indefinitely, so containers only ever died by SIGKILL (exit 137).
  On SIGTERM the entrypoint initiates `hb stop`, waits `HB_SHUTDOWN_GRACE`
  seconds (default 30) for a clean exit — the path that wins if upstream
  fixes the wedge — then hard-kills and exits 0 for the orchestrated stop.
  The elmdb cache is LMDB (transactionally crash-safe), so the hard kill
  loses at most uncommitted work.

**Nomad:** set `kill_timeout` comfortably above `HB_SHUTDOWN_GRACE`
(e.g. 45s over a 30s grace) so the entrypoint's escalation runs instead of
the runtime's. The `init:stop()` wedge is an upstream HyperBEAM bug worth
reporting — until then a truly graceful stop is not possible.

## Smoke tests

[ao-test/](ao-test/) contains bun + aoconnect smoke tests that spawn lua-device processes against a running node: Arweave- and EVM-signed interactions, revert-on-error semantics, and a comparison of read paths for nested process state. See its README for setup (the lua module must be published once).

## Build

To build the image without starting a service:

```sh
docker compose build hyperbeam
```

The Dockerfile builds the `v0.9-FINAL` tag of HyperBEAM by default. To build a different version, set the `VERSION` build arg:

```sh
docker compose build --build-arg VERSION=edge hyperbeam
```

## Volumes

Persistent services use named volumes to retain `cache-mainnet` data across restarts:

- `hyperbeam` — dev shell cache
- `hyperbeam-release` — release cache

To reset the cache, remove the volume:

```sh
docker volume rm hyperbeam-docker_hyperbeam
```
