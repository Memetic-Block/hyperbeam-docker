# Source patches

Backports of upstream permaweb/HyperBEAM fixes that are **not** in the pinned
build `VERSION`, so the image can be built against arbitrary tags/shas for
cross-version validation.

**Patches are scoped by target version.** They live in `patches/<VERSION>/`, and
the Dockerfile applies only `patches/$VERSION/*.patch` — matched against the
`VERSION` build arg — from `/app` (the checked-out git tree) with `git apply -p1`,
after `git checkout` and before `rebar3 compile`, fail-fast on any reject. Build a
version with no matching directory (e.g. `--build-arg VERSION=edge`) and it stays
vanilla. The directory name must match the `VERSION` value exactly (tag, branch,
or sha).

Keep patches minimal and cite, in the patch header, the upstream commit they
backport and the `anyone-protocol/docs/hyperbeam-migration/UPSTREAM-ISSUES.md`
id they close. Drop a patch (or its whole version dir) once you bump `VERSION`
past its upstream fix.

Most patches here are backports. A patch may also carry a fix that does **not**
exist upstream yet, in which case its header must say so and cite the PR (or the
draft) that will make it redundant — otherwise there is no signal for when to drop
it, and "bump `VERSION` past the upstream fix" silently loses the change.

## `v0.9-FINAL/` (= `466cf489`)

| patch | closes | upstream fix | notes |
|---|---|---|---|
| `0001-a15-lua-empty-map-decode-crash.patch` | A15 | `04b7b2b7` (262 commits past v0.9-FINAL) | `message_to_ordered_list` `hd([])` badarg on an emptied Lua state map → permanent process wedge. Minimal guard on the empty key list. |
| `0002-luerl-gc-after-compute.patch` | — | **none yet** — [permaweb/HyperBEAM#1062](https://github.com/permaweb/HyperBEAM/pull/1062), open | Luerl never calls `luerl_heap:gc/1` and neither does HyperBEAM, so the VM in `priv` retains every table ever allocated and `dev_lua:snapshot/3` grows with it (400 KB → 20.6 MB by slot 150, written 2×/slot). Collects in `process_response/3`, the only quiescent point, which bounds the live state rather than a serialised copy. Drop when the PR lands. |
| `0004-bundler-asymmetric-bundle-flag.patch` | WS-6 bundling | `0510a6ac` / `47c7c496` (the `fix/bundler-corruption-20260518` line, #916, merged 5-15 days past v0.9-FINAL) | `post_tx` converts the signed TX out with `bundle => true`, `build_proofs` converts it back WITHOUT it, so the proofs' `data_size` (23,076) does not match the header posted from `SignedTX` (13,729) and every chunk POST is rejected `data_root_not_found` forever - the transaction is paid for and mined, and its data never lands. Restores symmetry by flagging the reverse conversion, which `build_signed_tx_on_arbundles_js_test/0` in the same module already proves lossless at this version. Upstream instead dropped the flag from BOTH sides and posts `Committed` rather than `SignedTX`; that is the better end state but the riskier backport, since the unflagged round trip is untested here and needed later codec work (`3108b8d3`). Drop on VERSION bump - do not carry forward. |
| ~~`0002-luerl-gc-before-snapshot.patch`~~ | — | — | **Superseded 2026-08-09** by the above. Collected a copy at snapshot time, so the running VM stayed uncollected. #1062 moved to collecting after compute; matching it here keeps our image and the PR one change. |
