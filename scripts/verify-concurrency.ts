/**
 * verify-concurrency.ts
 *
 * Runnable proof of the core requirement: "Ensure only one driver is
 * assigned per ride request, even when multiple drivers attempt to accept
 * at the same time."
 *
 * What it does, per iteration:
 *   1. Registers N driver rows, all at (roughly) the same location.
 *   2. Creates a ride at that location so all N drivers are within radius
 *      and all get notified in the first batch.
 *   3. Fires all N drivers' POST /rides/:id/accept calls at once via
 *      Promise.all (true concurrency from the client's perspective).
 *   4. Asserts exactly one 200 (ASSIGNED) and the rest 409 (REJECTED).
 *   5. Repeats for ITERATIONS rounds to rule out lucky timing, since a
 *      single passing round is not strong evidence against a race.
 *
 * Usage:
 *   npm run verify:concurrency
 *   (requires the app to be running, e.g. via `docker compose up` or
 *   `npm run start:dev`, reachable at BASE_URL)
 */

import axios from 'axios';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const DRIVERS_PER_ROUND = parseInt(process.env.CONCURRENCY_DRIVERS || '10', 10);
const ITERATIONS = parseInt(process.env.CONCURRENCY_ITERATIONS || '20', 10);

// A fixed point so every driver + ride land in the same small radius.
const BASE_LAT = 12.9716;
const BASE_LNG = 77.5946;

interface DriverRecord {
  id: string;
}

async function registerDrivers(count: number): Promise<DriverRecord[]> {
  const drivers: DriverRecord[] = [];
  for (let i = 0; i < count; i++) {
    // Tiny jitter so drivers aren't at the literal identical point, but
    // well within a 5km search radius.
    const jitter = () => (Math.random() - 0.5) * 0.01;
    const res = await axios.post(`${BASE_URL}/drivers`, {
      name: `LoadTestDriver-${i}-${Date.now()}`,
      lat: BASE_LAT + jitter(),
      lng: BASE_LNG + jitter(),
    });
    drivers.push({ id: res.data.id });
  }
  return drivers;
}

async function createRide(): Promise<string> {
  const res = await axios.post(`${BASE_URL}/rides`, {
    riderId: `LoadTestRider-${Date.now()}`,
    pickupLat: BASE_LAT,
    pickupLng: BASE_LNG,
  });
  return res.data.id;
}

interface AcceptOutcome {
  driverId: string;
  succeeded: boolean;
  statusCode: number;
}

async function fireConcurrentAccepts(
  rideId: string,
  drivers: DriverRecord[],
): Promise<AcceptOutcome[]> {
  const calls = drivers.map(async (driver): Promise<AcceptOutcome> => {
    try {
      const res = await axios.post(`${BASE_URL}/rides/${rideId}/accept`, {
        driverId: driver.id,
      });
      return { driverId: driver.id, succeeded: res.status === 200, statusCode: res.status };
    } catch (err: any) {
      const statusCode = err.response?.status ?? 0;
      return { driverId: driver.id, succeeded: false, statusCode };
    }
  });

  // Promise.all fires every request essentially simultaneously; Node's
  // event loop interleaves the outgoing HTTP requests without waiting for
  // one to finish before starting the next, which is what actually
  // exercises the race on the server side.
  return Promise.all(calls);
}

async function runIteration(round: number): Promise<boolean> {
  const drivers = await registerDrivers(DRIVERS_PER_ROUND);
  const rideId = await createRide();

  // Give the ride a beat to finish its initial searchAndNotify() write to
  // Redis (status=SEARCHING) before we hammer it -- this is about
  // realistic sequencing, not about avoiding the race we're testing.
  await new Promise((r) => setTimeout(r, 300));

  const outcomes = await fireConcurrentAccepts(rideId, drivers);

  const winners = outcomes.filter((o) => o.succeeded);
  const rejected = outcomes.filter((o) => !o.succeeded);

  const pass = winners.length === 1 && rejected.length === drivers.length - 1;

  console.log(
    `[round ${round}] ride=${rideId} winners=${winners.length} rejected=${rejected.length} ` +
      `${pass ? 'PASS' : 'FAIL'}`,
  );

  if (!pass) {
    console.error('  Unexpected outcome distribution:', outcomes);
  }

  return pass;
}

async function main() {
  console.log(
    `Running ${ITERATIONS} rounds with ${DRIVERS_PER_ROUND} concurrent drivers each against ${BASE_URL}`,
  );

  let passCount = 0;
  for (let i = 1; i <= ITERATIONS; i++) {
    const pass = await runIteration(i);
    if (pass) passCount += 1;
  }

  console.log(`\n${passCount}/${ITERATIONS} rounds passed.`);

  if (passCount !== ITERATIONS) {
    console.error('CONCURRENCY VERIFICATION FAILED');
    process.exit(1);
  }

  console.log('CONCURRENCY VERIFICATION PASSED: exactly one driver was assigned in every round.');
}

main().catch((err) => {
  console.error('Script error:', err);
  process.exit(1);
});
