# Write-up: Real-Time Driver Allocation System

## What I built

A NestJS service that models the ride-hailing allocation loop end to end:
a rider requests a ride, the system geo-searches for nearby available
drivers using Redis `GEOSEARCH`, notifies a batch of them, and resolves
the race to acceptance atomically so exactly one driver is ever assigned.
If no one accepts within a configurable window, the system retries with
the next nearest batch, up to a retry limit, after which the ride expires.
Every state transition is persisted to Postgres, both for the ride's
current state and as an append-only audit trail.

The three moving pieces are:

- **Postgres** — durable system of record for rides, drivers, and the
  transition history. This is what you'd query for anything beyond the
  live allocation decision itself (support tooling, analytics, billing).
- **Redis** — the geo index (`GEOSEARCH`) and the *arbitration layer* for
  the accept race and the timeout race. It's also the BullMQ backing store
  for the scheduled per-batch timeout jobs.
- **NestJS** — orchestrates the two: kicks off search/notify, exposes the
  HTTP surface, and reconciles Redis's atomic decisions into Postgres.

## Why I made the choices I did, especially around concurrency

The requirement that mattered most was "only one driver assigned, even
under simultaneous accept attempts." I didn't want to reach for a
distributed lock (e.g. Redlock) as the first tool, because the actual
decision here is a single atomic compare-and-swap on a single key — a
lock is solving a more general problem than the one we have. Instead, I
put the whole decision inside one Redis Lua script
(`accept-ride.lua`):

1. Read the ride's current status.
2. If it's already resolved (`ASSIGNED`/`TIMEOUT`), reject — unless the
   caller is the driver who already won, in which case return the same
   success idempotently.
3. If it's open (`SEARCHING`), attempt `SET assignment driverId NX`. `NX`
   only succeeds for the first writer, so this line *is* the race
   resolution — whichever of N concurrent Lua invocations reaches this
   instruction first wins, and Redis's guarantee that a script's commands
   execute without interleaving from other clients means there is no
   window where two callers could both see "unclaimed" and both write.

The same pattern protects the timeout path: `timeout-ride.lua` only
flips `SEARCHING → TIMEOUT`, and refuses to touch a ride that's already
`ASSIGNED`. That's what handles "a driver accepting just after the
timeout fires" — both paths go through Redis atomically, so whichever one
actually executes first is authoritative, and the loser's script simply
observes a status that no longer permits its action. No wall-clock
coordination between the HTTP request handler and the timeout worker is
needed; Redis's execution order *is* the coordination.

Postgres writes happen only after the Redis decision is already final,
guarded by checking the ride's current persisted status before mutating
it — so even if two requests somehow reached the Postgres-write stage
(they can't, given the above, but defense in depth is cheap), the second
would be a no-op rather than a double-write.

**Idempotency** falls out of the same script: a driver's retried
`/accept` call (network retry, double-tap in a bad-signal area) re-enters
the script, sees `existing == driverId`, and returns the same success
outcome without any new write. I also added a status-guard on the
Postgres side for the same reason, so idempotency isn't solely dependent
on the Redis layer.

**Notification** is implemented as a simulated log (permitted explicitly
by the brief) rather than real push, to keep the surface area focused on
the concurrency mechanics being evaluated. It's isolated behind
`NotificationService`, so swapping in a WebSocket gateway later is a
localized change — `AllocationService` only depends on
`notifyDrivers()`'s signature, not its implementation.

**Retry/timeout scheduling** uses BullMQ (already have Redis, and it's
the idiomatic choice with NestJS) with a unique job ID per `(rideId,
batchNumber)` pair, so retried batches never collide with a stale timeout
job from an earlier batch, and cancelling the winning batch's job on
successful assignment is a single lookup by that same ID.

## What I'd improve with more time

- **Real push notifications** via a WebSocket gateway per driver, with the
  simulated log kept as a fallback/audit trail rather than the only
  channel.
- **Batch overlap safety**: currently a driver notified in batch 1 who's
  slow to respond could still accept after batch 2 has started — the Lua
  script handles this correctly (whoever's request reaches Redis first
  still wins), but the *product* behavior (do we want batch-1 drivers to
  still be eligible after their window closed?) is worth a real design
  discussion rather than an engineering default.
- **Driver-side cancellation** — right now a driver can accept but there's
  no explicit "ride cancelled by rider" flow before assignment; I'd add a
  `CANCELLED` transition reachable from `REQUESTED`/`SEARCHING`.
- **Proper DB migrations** instead of `synchronize: true`. I used
  `synchronize` here purely so the schema self-creates for a fast
  take-home review; the codebase already has a `typeorm.config.ts` data
  source wired up for `migration:generate`/`migration:run`, so switching
  is mechanical.
- **Load-based batch sizing** — `DRIVERS_PER_BATCH` is currently static;
  a real system would probably widen the batch (or radius) automatically
  in low-supply areas.

## Recommendations for hardening toward production

- **Scaling**: the Lua-script arbitration scales horizontally without
  change since it's a single Redis operation per accept — the bottleneck
  would be Redis throughput itself, which is addressed with clustering
  (careful: `GEOSEARCH` and the per-ride keys would need consistent
  hashing/key-tagging to stay on the same shard) rather than any
  applicaton-level change.
- **Observability**: add structured logging with a correlation ID per
  ride, metrics on allocation latency and retry rate per batch, and
  tracing (OpenTelemetry) across the HTTP → Redis → Postgres path so a
  slow allocation can be diagnosed quickly. The `ride_state_transitions`
  table already gives a cheap audit trail; I'd pair it with an alert on
  `EXPIRED` rate spiking.
- **Failure recovery**: if the Node process crashes between the Redis
  write and the Postgres write in `acceptRide`, Redis will show `ASSIGNED`
  but Postgres won't yet reflect it. A reconciliation job that
  periodically diffs Redis-assigned rides against Postgres and repairs
  drift would close this gap; the Lua-script status check already makes
  this safe to run repeatedly.
- **Backpressure**: under a surge of ride requests, geo search + batch
  notify should move off the request thread and onto a queue (similar to
  how timeouts are already queued) so `POST /rides` responds immediately
  with `REQUESTED` while allocation happens asynchronously.
- **Circuit breaking**: if Postgres is slow/unavailable, the Redis-side
  arbitration should still function so drivers get an immediate
  accept/reject response, with the Postgres write retried via an outbox
  pattern rather than blocking the HTTP response.
