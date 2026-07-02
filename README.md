# vybe cabs — Real-Time Driver Allocation System

A simulation of the core ride-hailing allocation workflow: geo-based driver
discovery, concurrent notification, race-safe first-acceptance assignment,
timeout/retry, and idempotent acceptance handling.

Stack: **NestJS (TypeScript) · PostgreSQL · Redis (GEO + Lua + BullMQ)**

---

## 1. Quick start (Docker)

```bash
docker compose up --build
```

This starts Postgres, Redis, and the app on `http://localhost:3000`.
Schema is created automatically on boot (TypeORM `synchronize: true` — see
write-up for why this is fine here but not in production).

To run without Docker:

```bash
cp .env.example .env
npm install
# make sure Postgres + Redis are reachable per your .env
npm run start:dev
```

---

## 2. Architecture

```
                         ┌─────────────────────────────────────────────┐
                         │                  NestJS App                  │
                         │                                               │
  Rider  ── POST /rides ─▶  RidesController ──▶ RidesService             │
                         │        │                    │                 │
                         │        ▼                    ▼                 │
                         │  AllocationService ──▶ NotificationService    │
                         │   (geo search, batch,      (simulated log /   │
                         │    schedule timeout)         "notify N")      │
                         │        │        ▲                             │
                         │        │        │ BullMQ delayed job          │
                         │        ▼        │ (per-batch, unique jobId)   │
                         │   TimeoutProcessor                            │
                         │                                               │
  Driver ── POST /rides/:id/accept ─▶ RidesController ─▶ RidesService    │
                         │                     │                         │
                         │                     ▼                         │
                         │            RedisService.attemptAcceptRide     │
                         │            (accept-ride.lua, atomic)          │
                         └───────────────────┬───────────────────────────┘
                                              │
                     ┌────────────────────────┴───────────────────────┐
                     ▼                                                  ▼
               ┌───────────┐                                     ┌───────────┐
               │  Redis    │  GEO index (drivers:locations)       │ PostgreSQL│
               │           │  ride:{id}:status                    │           │
               │           │  ride:{id}:assignment                │ rides,    │
               │           │  BullMQ queues                       │ drivers,  │
               │           │                                       │ transitions│
               └───────────┘                                     └───────────┘
```

**End-to-end flow:**

1. `POST /rides` → ride row created (`REQUESTED`) → `AllocationService`
   runs `GEOSEARCH` against `drivers:locations` for the nearest available
   drivers within radius.
2. Nearest N drivers are "notified" (simulated log; see write-up for why
   this satisfies the requirement and how it swaps for real push later).
   Ride status becomes `SEARCHING` in both Postgres and Redis, and a
   per-batch delayed timeout job is scheduled in BullMQ.
3. Any notified driver calls `POST /rides/:id/accept`. This runs
   `accept-ride.lua` atomically in Redis — the single choke point that
   guarantees exactly one winner even under concurrent calls.
4. The winning result is persisted to Postgres (`ASSIGNED`), the driver is
   marked `BUSY` and removed from the geo index, and the pending timeout
   job for that batch is cancelled.
5. If no one accepts before the window elapses, `timeout-ride.lua` runs
   (atomically, so it can never clobber a just-landed acceptance), ride
   moves to `TIMEOUT`, and allocation retries with the next batch of
   drivers — up to `MAX_ALLOCATION_RETRIES`, after which the ride is
   `EXPIRED`.

A hand-drawn version of this diagram is equally valid per the assignment;
this ASCII version is here so it renders directly in the repo.

---

## 3. Ride states

`REQUESTED → SEARCHING → ASSIGNED` (success path)
`SEARCHING → TIMEOUT → SEARCHING` (retry loop, up to `maxRetries`)
`SEARCHING → TIMEOUT → EXPIRED` (retries exhausted)
`SEARCHING → EXPIRED` (no candidates found at all, e.g. empty radius)

All transitions are written to the `ride_state_transitions` audit table.

---

## 4. Concurrency design (see write-up for full rationale)

- **Single source of truth for the race**: `ride:{id}:status` and
  `ride:{id}:assignment` in Redis. All acceptance attempts run through
  `accept-ride.lua`, which Redis executes atomically — no interleaving is
  possible between the "is this ride still open" check and the "claim it"
  write, because both happen inside one script execution.
- **No external distributed lock needed**: the claim itself uses `SET key
  value NX` as a compare-and-swap, which is atomic on its own; wrapping it
  in Lua only adds the surrounding status check atomically. This is
  simpler than Redlock-style locking for a single-key decision like this.
- **Timeout race**: `timeout-ride.lua` only flips `SEARCHING → TIMEOUT`;
  it never overwrites `ASSIGNED`. So a driver accepting a few milliseconds
  before or after the timeout fires always resolves consistently —
  whichever script call reaches Redis first wins, and Redis's single
  execution guarantee means there's no window where both could apply.
- **Idempotency**: a driver calling `/accept` twice (retry, double-tap,
  etc.) gets the same `ASSIGNED` response both times without any second
  write — the Lua script recognizes `existing == driverId` and returns
  `ALREADY_ASSIGNED_TO_YOU`, and the Postgres-side write is guarded by
  checking the ride's current status before mutating it.

---

## 5. API reference

### Create a driver
```bash
curl -X POST http://localhost:3000/drivers \
  -H "Content-Type: application/json" \
  -d '{"name": "Asha", "lat": 12.9716, "lng": 77.5946}'
```

### Update a driver's location
```bash
curl -X PATCH http://localhost:3000/drivers/<driverId>/location \
  -H "Content-Type: application/json" \
  -d '{"lat": 12.9720, "lng": 77.5950}'
```

### Set driver status (AVAILABLE / BUSY / OFFLINE)
```bash
curl -X PATCH http://localhost:3000/drivers/<driverId>/status \
  -H "Content-Type: application/json" \
  -d '{"status": "AVAILABLE"}'
```

### Request a ride
```bash
curl -X POST http://localhost:3000/rides \
  -H "Content-Type: application/json" \
  -d '{"riderId": "rider-1", "pickupLat": 12.9716, "pickupLng": 77.5946}'
```

### Accept a ride (as a driver)
```bash
curl -X POST http://localhost:3000/rides/<rideId>/accept \
  -H "Content-Type: application/json" \
  -d '{"driverId": "<driverId>"}'
```
Returns `200` with the assignment on success, `409` if someone else already
won, `404` if the ride doesn't exist.

### Inspect a ride
```bash
curl http://localhost:3000/rides/<rideId>
curl http://localhost:3000/rides/<rideId>/notifications
curl http://localhost:3000/rides/<rideId>/history
```

A ready-made Postman collection is at `postman/vybe-cabs.postman_collection.json`.

---

## 6. Running the concurrency proof

With the stack up (`docker compose up`, or `npm run start:dev` locally):

```bash
npm run verify:concurrency
```

This registers a batch of drivers at the same location, creates a ride,
fires all drivers' `accept` calls concurrently via `Promise.all`, and
asserts exactly one `200` / rest `409` — repeated for 20 rounds by default
to rule out lucky timing rather than proven correctness. Configure via
`CONCURRENCY_DRIVERS`, `CONCURRENCY_ITERATIONS`, and `BASE_URL` env vars.

---

## 7. Environment variables

See `.env.example`. Key allocation tuning knobs:

| Variable | Meaning | Default |
|---|---|---|
| `DRIVER_SEARCH_RADIUS_KM` | GEOSEARCH radius | 5 |
| `DRIVERS_PER_BATCH` | Drivers notified per attempt | 3 |
| `ACCEPT_TIMEOUT_MS` | Acceptance window per batch | 15000 |
| `MAX_ALLOCATION_RETRIES` | Retry batches before EXPIRED | 3 |

---

## 8. Project structure

```
src/
  common/redis/           RedisService (GEO + Lua script execution), lua/ scripts
  drivers/                Driver entity, CRUD, location + status updates
  rides/                  Ride entity, lifecycle states, controller/service
  allocation/             Geo search + notify + retry orchestration, BullMQ timeout processor
  config/                 TypeORM data source config
scripts/verify-concurrency.ts   Runnable concurrency proof
postman/                 Postman collection
docker-compose.yml       Postgres + Redis + app
WRITEUP.md               Design write-up
```
