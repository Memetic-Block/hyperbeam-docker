--- smoke.lua — authored smoke-test module for a HyperBEAM `lua@5.3a` process.
---
--- The node calls `compute(base, assignment, opts)` for every scheduled
--- message; the returned `base` IS the process state. That means every key we
--- set on `base` is directly readable over HTTP with no patch device needed:
---
---   GET /<pid>~process@1.0/now/state/counters/count
---   GET /<pid>~process@1.0/now/state/serialize~json@1.0
---   GET /<pid>~process@1.0/now/state-json
---   GET /<pid>~process@1.0/now/state-html
---
--- Error model (the behavior we relied on in legacynet): handlers run under
--- pcall; before dispatch we deep-copy the managed `state` table, and on any
--- handler error we restore it, so a failed interaction never mutates state.
--- Note that hyper-aos does NOT do this — its pcall keeps prior mutations —
--- so revert-on-error must be owned by the module, like here.
---
--- `action = fail-uncaught` raises OUTSIDE the pcall: the whole slot errors at
--- the node level (dev_process does not store the slot), which also reverts
--- state — but the scheduled assignment remains, so the tests probe whether
--- the process can still advance afterwards.

local function deepcopy(v)
  if type(v) ~= 'table' then return v end
  local out = {}
  for k, x in pairs(v) do out[k] = deepcopy(x) end
  return out
end

--- Minimal JSON encoder (encode-only; enough for our state shapes).
--- Skips `commitments`/`ao-types`: HyperBEAM attaches commitment metadata to
--- every stored submessage, so state read back into lua on later slots
--- carries them — they are node bookkeeping, not our state.
local function jsonencode(v)
  local t = type(v)
  if t == 'number' or t == 'boolean' then return tostring(v) end
  if t == 'string' then
    return '"' .. v:gsub('[\\"]', '\\%0'):gsub('\n', '\\n') .. '"'
  end
  if t == 'table' then
    local n = 0
    for _ in pairs(v) do n = n + 1 end
    if n == #v then -- array (or empty table)
      local parts = {}
      for i = 1, #v do parts[i] = jsonencode(v[i]) end
      return '[' .. table.concat(parts, ',') .. ']'
    end
    local parts = {}
    for k, x in pairs(v) do
      if k ~= 'commitments' and k ~= 'ao-types' then
        parts[#parts + 1] = jsonencode(tostring(k)) .. ':' .. jsonencode(x)
      end
    end
    return '{' .. table.concat(parts, ',') .. '}'
  end
  return 'null'
end

--- Re-render the derived views of `state`: a JSON string and prerendered HTML.
--- These exist to compare read paths for deeply nested state; the nested
--- `state` table itself is already path-addressable.
local function render(base)
  local encoded = jsonencode(base.state)
  base['state-json'] = encoded
  base['state-html'] = {
    ['content-type'] = 'text/html',
    body = '<!doctype html><title>smoke state</title>'
      .. '<h1>smoke state</h1><pre>' .. encoded .. '</pre>'
  }
end

local handlers = {}

handlers['ping'] = function (base, req)
  return 'pong'
end

handlers['increment'] = function (base, req)
  base.state.counters.count = base.state.counters.count + 1
  return tostring(base.state.counters.count)
end

--- Set a note: tags `key` and `value` on the message.
handlers['set-note'] = function (base, req)
  local key = req.key or 'default'
  base.state.notes[key] = req.value or ''
  return 'note set: ' .. key
end

--- Echo the byte length of the message data payload. Used to probe how large
--- a single message (e.g. a batched Add-Scores) can be end-to-end: client →
--- push → schedule → luerl compute → result.
handlers['data-length'] = function (base, req)
  return tostring(#(req.data or ''))
end

--- Write a deterministic deeply nested structure, leaf = `value` tag.
handlers['deep-set'] = function (base, req)
  base.state.deep = {
    l1 = { l2 = { l3 = { value = req.value or 'deep-default' } } }
  }
  return 'deep set'
end

--- Mutate state, THEN error. The mutation must NOT survive (module pcall +
--- snapshot restore). This is the "patch before error" case.
handlers['mutate-then-fail'] = function (base, req)
  base.state.counters.count = base.state.counters.count + 1000
  base.state.notes['mutate-then-fail'] = 'must not persist'
  error('deliberate failure after mutating state')
end

--- Error BEFORE any mutation ("patch after error": the write is unreachable).
handlers['fail-then-mutate'] = function (base, req)
  error('deliberate failure before mutating state')
  base.state.counters.count = base.state.counters.count + 1000 -- luacheck: ignore
end

--- Everything fallible for a slot: state init, handler dispatch, rendering.
--- Runs inside pcall from compute() — an error anywhere in here is caught and
--- the pre-slot snapshot is restored.
local function protected_compute(base, req, action)
  -- First message: initialize managed state.
  base.state = base.state or {
    counters = { count = 0 },
    notes = {},
    deep = {}
  }
  base.state.counters = base.state.counters or { count = 0 }
  base.state.notes = base.state.notes or {}
  base.state.deep = base.state.deep or {}

  local handler = handlers[action]
  if not handler then
    error('unknown action: ' .. tostring(action))
  end
  local result = handler(base, req)
  render(base)
  return result
end

--- The entry point is a trampoline that must be TRIVIALLY INFALLIBLE: any
--- error that escapes compute() fails the slot at the node level, and a slot
--- that can never compute permanently wedges the process (verified against
--- v0.9-final — /now 500s and no later message can compute). So nothing out
--- here but pcalls and plain table construction.
function compute(base, assignment, opts)
  local req = assignment.body or {}
  local action = req.action or 'ping'

  -- TEST HOOK ONLY: deliberately raised outside the protected region so the
  -- test suite can observe node-level slot-error behavior. Real modules must
  -- not have paths like this.
  if action == 'fail-uncaught' then
    error('uncaught failure requested; slot must error and state must not advance')
  end

  -- Snapshot first; if even snapshotting fails, bail WITHOUT touching state.
  local snapok, snapshot = pcall(deepcopy, base.state)
  if not snapok then
    base.results = {
      outbox = {},
      output = { data = 'error: could not snapshot state: ' .. tostring(snapshot) }
    }
    return base
  end

  local ok, result = pcall(protected_compute, base, req, action)
  if not ok then
    base.state = snapshot -- revert: a failed slot never mutates state
    result = 'error: ' .. tostring(result)
    -- Re-render views of the restored state; belt-and-braces pcall so a
    -- render bug can't escape the trampoline.
    pcall(render, base)
  end
  base.results = {
    outbox = {},
    output = { data = result }
  }
  return base
end
