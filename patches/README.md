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

## `v0.9-FINAL/` (= `466cf489`)

| patch | closes | upstream fix | notes |
|---|---|---|---|
| `0001-a15-lua-empty-map-decode-crash.patch` | A15 | `04b7b2b7` (262 commits past v0.9-FINAL) | `message_to_ordered_list` `hd([])` badarg on an emptied Lua state map → permanent process wedge. Minimal guard on the empty key list. |
