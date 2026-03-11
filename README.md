# Docker Images for HyperBEAM

Dockerized setup for running [HyperBEAM](https://github.com/permaweb/hyperbeam) nodes. Builds HyperBEAM from source with all dependencies (Erlang 27, Rebar3, Rust 1.86, Node.js 22) and provides multiple service profiles for development and production use.

## Prerequisites

- Docker and Docker Compose
- An Arweave wallet file (JSON keyfile)

## Quick Start

Set the `WALLET_FILE` environment variable to the path of your Arweave wallet (or with .env, see `.env.example`):

```sh
export WALLET_FILE=/path/to/wallet.json
```

Run a node with persistent cache:

```sh
docker compose up hyperbeam-edge
```

The node will be available on port **8734**.

## Services

| Service | Mode | Cache | Description |
|---|---|---|---|
| `hyperbeam-edge` | Dev shell | Persistent | Development node with a named volume for `cache-mainnet` |
| `hyperbeam-edge-ephemeral` | Dev shell | Ephemeral | Development node with no persistent cache |
| `hyperbeam-edge-release` | Release | Persistent | Production release build with a named volume |
| `hyperbeam-edge-release-ephemeral` | Release | Ephemeral | Production release build with no persistent cache |

### Dev shell vs Release

- **Dev shell** services run via `rebar3 as genesis_wasm shell` — useful for development, debugging, and live interaction with the Erlang shell.
- **Release** services use a compiled OTP release (`./bin/hb foreground`) — suitable for production deployments.

## Configuration

Configuration is provided via `.flat` files mounted into the container:

- [config.flat](config.flat) — used by dev shell services
- [config.release.flat](config.release.flat) — used by release services

Both files set `priv_key_location` to the path where the wallet is mounted inside the container. Uncomment the `gateway` line to use a custom gateway (e.g. Turbo).

## Build

To build the image without starting a service:

```sh
docker compose build hyperbeam-edge
```

The Dockerfile clones the `edge` branch of HyperBEAM by default. To build a different version, set the `VERSION` build arg:

```sh
docker compose build --build-arg VERSION=main hyperbeam-edge
```

## Volumes

Persistent services use named Docker volumes to retain `cache-mainnet` data across restarts:

- `hyperbeam-edge` — dev shell cache
- `hyperbeam-edge-release` — release cache

To reset the cache, remove the volume:

```sh
docker volume rm hyperbeam-docker_hyperbeam-edge
```

