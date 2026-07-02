-- accept-ride.lua
--
-- Atomically decides whether an accept() call from a driver wins the ride.
-- This is the single source of truth for "only one driver gets assigned."
-- Redis executes each script call atomically end-to-end, so no two
-- invocations of this script for the same keys can ever interleave --
-- that's what removes the race, without needing a separate distributed lock.
--
-- KEYS[1] = ride:{rideId}:status      (string: SEARCHING | ASSIGNED | TIMEOUT | EXPIRED)
-- KEYS[2] = ride:{rideId}:assignment  (string: driverId, only ever set once)
-- ARGV[1] = driverId attempting to accept
--
-- Returns a 3-element array: { outcome, currentStatus, winningDriverId }
-- outcome is one of: "ASSIGNED", "ALREADY_ASSIGNED_TO_YOU", "REJECTED", "NOT_FOUND"

local statusKey = KEYS[1]
local assignmentKey = KEYS[2]
local driverId = ARGV[1]

local status = redis.call('GET', statusKey)

if status == false then
  return { 'NOT_FOUND', '', '' }
end

-- Ride already has a winner
if status == 'ASSIGNED' then
  local existing = redis.call('GET', assignmentKey)
  if existing == driverId then
    -- Same driver retried the accept call (network retry, duplicate click).
    -- Idempotent: return the same success outcome, no double side-effects.
    return { 'ALREADY_ASSIGNED_TO_YOU', status, existing }
  else
    return { 'REJECTED', status, existing or '' }
  end
end

-- Ride is closed for reasons other than assignment (timed out / expired)
if status ~= 'SEARCHING' then
  return { 'REJECTED', status, '' }
end

-- Ride is open. Claim it atomically: SET ... NX is our compare-and-swap --
-- it only succeeds for the first caller to reach this line.
local claimed = redis.call('SET', assignmentKey, driverId, 'NX')

if claimed then
  redis.call('SET', statusKey, 'ASSIGNED')
  return { 'ASSIGNED', 'ASSIGNED', driverId }
else
  -- Someone else claimed it between our GET above and this SET attempt --
  -- exactly the race window this script exists to close.
  local winner = redis.call('GET', assignmentKey)
  if winner == driverId then
    return { 'ALREADY_ASSIGNED_TO_YOU', 'ASSIGNED', winner }
  end
  return { 'REJECTED', 'ASSIGNED', winner or '' }
end
