-- timeout-ride.lua
--
-- Atomically transitions a ride from SEARCHING to TIMEOUT, but only if it is
-- still SEARCHING. This closes the "driver accepts just after the timeout
-- fires" race: whichever of (accept-ride.lua, timeout-ride.lua) reaches
-- Redis first wins, and the loser observes a status that no longer permits
-- it to act.
--
-- KEYS[1] = ride:{rideId}:status
-- KEYS[2] = ride:{rideId}:assignment (unused directly, reserved for future use)
--
-- Returns the resulting status string.

local statusKey = KEYS[1]

local status = redis.call('GET', statusKey)

if status == false then
  return 'NOT_FOUND'
end

if status == 'SEARCHING' then
  redis.call('SET', statusKey, 'TIMEOUT')
  return 'TIMEOUT'
end

-- Already ASSIGNED (or previously TIMEOUT/EXPIRED) -- leave it alone.
return status
