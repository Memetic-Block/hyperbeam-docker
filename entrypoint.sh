#!/bin/sh
# Container entrypoint for hyperbeam-docker images. See README.md, "Runtime behavior (entrypoint)".

HB_SHUTDOWN_GRACE="${HB_SHUTDOWN_GRACE:-30}"

if [ ! -f "$HB_WALLET_PATH" ]; then
  if [ "$HB_ALLOW_EPHEMERAL_WALLET" = "true" ]; then
    echo "entrypoint: WARNING: no wallet at $HB_WALLET_PATH —" \
      "HB_ALLOW_EPHEMERAL_WALLET=true, the node will mint an EPHEMERAL identity" >&2
  else
    echo "entrypoint: FATAL: no wallet at $HB_WALLET_PATH." >&2
    echo "entrypoint: mount a keyfile there, point HB_WALLET_PATH at one, or set" \
      "HB_ALLOW_EPHEMERAL_WALLET=true to let the node mint a throwaway identity." >&2
    exit 1
  fi
fi

export HB_KEY="$HB_WALLET_PATH"

"$@" &
child=$!
stopping=0

shutdown() {
  stopping=1
  echo "entrypoint: SIGTERM/SIGINT — stopping node (grace ${HB_SHUTDOWN_GRACE}s)" >&2
  if [ -x ./bin/hb ]; then
    # Fire-and-forget: on v0.9-FINAL this initiates shutdown but never
    # returns (init:stop wedges), so it must not block the escalation timer.
    ./bin/hb stop >/dev/null 2>&1 &
  else
    kill -TERM "$child" 2>/dev/null
  fi
  waited=0
  while kill -0 "$child" 2>/dev/null && [ "$waited" -lt "$HB_SHUTDOWN_GRACE" ]; do
    sleep 1
    waited=$((waited + 1))
  done
  if kill -0 "$child" 2>/dev/null; then
    echo "entrypoint: node still up after ${HB_SHUTDOWN_GRACE}s (known init:stop wedge) — SIGKILL" >&2
    kill -KILL "$child" 2>/dev/null
  fi
}
trap shutdown TERM INT

# `wait` returns early when a trapped signal arrives; loop until the child is
# actually gone so the trap's escalation can run to completion.
while :; do
  wait "$child"
  status=$?
  kill -0 "$child" 2>/dev/null || break
done

# An orchestrated stop that needed the SIGKILL escalation is still a
# successful stop — don't surface 137 for it.
if [ "$stopping" = "1" ]; then
  exit 0
fi
exit "$status"
