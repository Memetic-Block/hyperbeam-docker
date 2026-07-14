# Legacy: genesis_wasm HyperBEAM images (DEPRECATED)

The genesis_wasm rebar3 profile bolts a Node.js `genesis-wasm-server` onto the HyperBEAM release to compute legacy `ao.TN.1` (wasm) processes. It is deprecated upstream — the current setup at the repo root builds the default profile, where the lua device is the AO compute method.

This directory is kept as a known-working config base:

- [genesis_wasm.Dockerfile](genesis_wasm.Dockerfile) — build/release stages with the `genesis_wasm` profile
- [docker-compose.yml](docker-compose.yml) — the original `hyperbeam-edge*` services, plus `hyperbeam-edge-release-image` which runs the published `ghcr.io/memetic-block/hyperbeam-docker:v0.9-final` image
- `config.flat` / `config.release.flat` / `config.release.json` — configs with `_build/genesis_wasm/rel/hb` paths
- [ao-test/](ao-test/) — the original smoke tests, which spawn **wasm** AOS processes computed by the genesis-wasm executor (import-authority gating and all); its README's findings section documents what made v0.9-FINAL the pinned tag

Run from the repo root with `-f` so relative paths and `.env` resolve against this directory:

```sh
podman compose -f legacy/docker-compose.yml up hyperbeam-edge
```

Note: the compose project is named `hyperbeam-docker-legacy`, so named cache volumes from the pre-move layout (`hyperbeam-docker_hyperbeam-edge*`) are not reused.

To publish a genesis_wasm image, run the *Build and Publish* workflow with `flavor: genesis_wasm` — it builds from this directory and suffixes the image tag with `-genesis-wasm`.
