import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import * as fs from 'fs';
import * as path from 'path';
import { buildRedisConnectionOptions } from './redis-connection.util';

export type AcceptRideOutcome =
  | 'ASSIGNED'
  | 'ALREADY_ASSIGNED_TO_YOU'
  | 'REJECTED'
  | 'NOT_FOUND';

export interface AcceptRideResult {
  outcome: AcceptRideOutcome;
  status: string;
  winningDriverId: string | null;
}

const DRIVERS_GEO_KEY = 'drivers:locations';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  public readonly client: Redis;

  private acceptRideSha: string;
  private timeoutRideSha: string;

  constructor(private readonly config: ConfigService) {
    this.client = new Redis(buildRedisConnectionOptions(this.config));
  }

  async onModuleInit() {
    await this.loadScripts();
  }

  async onModuleDestroy() {
    await this.client.quit();
  }

  private async loadScripts() {
    // In dev (ts-node) lua files live next to src; in the built image the
    // Dockerfile copies them alongside dist/common/redis/lua.
    const luaDir = path.join(__dirname, 'lua');
    const acceptScript = fs.readFileSync(
      path.join(luaDir, 'accept-ride.lua'),
      'utf8',
    );
    const timeoutScript = fs.readFileSync(
      path.join(luaDir, 'timeout-ride.lua'),
      'utf8',
    );

    this.acceptRideSha = await this.client.script(
      'LOAD',
      acceptScript,
    ) as string;
    this.timeoutRideSha = await this.client.script(
      'LOAD',
      timeoutScript,
    ) as string;

    this.logger.log('Lua scripts loaded into Redis');
  }

  /**
   * Runs accept-ride.lua atomically. This is the single choke point through
   * which every driver acceptance must pass -- it is what guarantees only
   * one driver is ever assigned to a given ride, no matter how many drivers
   * call accept() concurrently.
   */
  async attemptAcceptRide(
    rideId: string,
    driverId: string,
  ): Promise<AcceptRideResult> {
    const statusKey = `ride:${rideId}:status`;
    const assignmentKey = `ride:${rideId}:assignment`;

    const result = (await this.evalWithReload(
      'accept',
      2,
      [statusKey, assignmentKey],
      [driverId],
    )) as [string, string, string];

    return {
      outcome: result[0] as AcceptRideOutcome,
      status: result[1],
      winningDriverId: result[2] || null,
    };
  }

  /**
   * Runs timeout-ride.lua atomically. Only flips SEARCHING -> TIMEOUT;
   * never overwrites an ASSIGNED ride, which is what protects against the
   * "driver accepted a split second after the timeout fired" edge case.
   */
  async attemptTimeoutRide(rideId: string): Promise<string> {
    const statusKey = `ride:${rideId}:status`;
    const assignmentKey = `ride:${rideId}:assignment`;

    return this.evalWithReload(
      'timeout',
      2,
      [statusKey, assignmentKey],
      [],
    ) as Promise<string>;
  }

  private async evalWithReload(
    which: 'accept' | 'timeout',
    numKeys: number,
    keys: string[],
    args: string[],
  ): Promise<unknown> {
    const sha = which === 'accept' ? this.acceptRideSha : this.timeoutRideSha;
    try {
      return await this.client.evalsha(sha, numKeys, ...keys, ...args);
    } catch (err) {
      // NOSCRIPT can happen if Redis was restarted/flushed since we loaded
      // the script. Reload once and retry rather than failing the request.
      if (err instanceof Error && err.message.includes('NOSCRIPT')) {
        await this.loadScripts();
        const reloadedSha =
          which === 'accept' ? this.acceptRideSha : this.timeoutRideSha;
        return this.client.evalsha(reloadedSha, numKeys, ...keys, ...args);
      }
      throw err;
    }
  }

  async setRideStatus(rideId: string, status: string): Promise<void> {
    await this.client.set(`ride:${rideId}:status`, status);
  }

  async getRideStatus(rideId: string): Promise<string | null> {
    return this.client.get(`ride:${rideId}:status`);
  }

  async getAssignedDriver(rideId: string): Promise<string | null> {
    return this.client.get(`ride:${rideId}:assignment`);
  }

  async clearRideKeys(rideId: string): Promise<void> {
    await this.client.del(`ride:${rideId}:status`, `ride:${rideId}:assignment`);
  }

  // ---- Geo helpers -------------------------------------------------------

  async upsertDriverLocation(
    driverId: string,
    lng: number,
    lat: number,
  ): Promise<void> {
    await this.client.geoadd(DRIVERS_GEO_KEY, lng, lat, driverId);
  }

  async removeDriverFromGeo(driverId: string): Promise<void> {
    await this.client.zrem(DRIVERS_GEO_KEY, driverId);
  }

  /**
   * Returns nearby driver ids sorted by distance ascending, using Redis
   * GEOSEARCH. Distance unit is kilometers.
   */
  async searchNearbyDrivers(
    lng: number,
    lat: number,
    radiusKm: number,
    count: number,
  ): Promise<{ driverId: string; distanceKm: number }[]> {
    // ioredis exposes GEOSEARCH via a generic call since typed helpers vary
    // by version; using `call` keeps this robust across ioredis releases.
    const raw = (await this.client.call(
      'GEOSEARCH',
      DRIVERS_GEO_KEY,
      'FROMLONLAT',
      lng.toString(),
      lat.toString(),
      'BYRADIUS',
      radiusKm.toString(),
      'km',
      'ASC',
      'COUNT',
      count.toString(),
      'WITHCOORD',
      'WITHDIST',
    )) as any[];

    return raw.map((entry) => {
      const [driverId, distanceStr] = entry;
      return { driverId, distanceKm: parseFloat(distanceStr) };
    });
  }
}
