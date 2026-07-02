import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { Ride } from '../rides/entities/ride.entity';
import { RideStateTransition } from '../rides/entities/ride-state-transition.entity';
import { RideState } from '../rides/ride.state';
import { RedisService } from '../common/redis/redis.service';
import { NotificationService } from './notification.service';
import { DriversService } from '../drivers/drivers.service';
import { DriverStatus } from '../drivers/entities/driver.entity';

export const RIDE_TIMEOUT_QUEUE = 'ride-timeouts';

@Injectable()
export class AllocationService {
  private readonly logger = new Logger(AllocationService.name);

  private readonly searchRadiusKm: number;
  private readonly driversPerBatch: number;
  private readonly acceptTimeoutMs: number;

  constructor(
    @InjectRepository(Ride) private readonly rideRepo: Repository<Ride>,
    @InjectRepository(RideStateTransition)
    private readonly transitionRepo: Repository<RideStateTransition>,
    @InjectQueue(RIDE_TIMEOUT_QUEUE) private readonly timeoutQueue: Queue,
    private readonly redis: RedisService,
    private readonly notifications: NotificationService,
    private readonly driversService: DriversService,
    private readonly config: ConfigService,
  ) {
    this.searchRadiusKm = parseFloat(
      this.config.get<string>('DRIVER_SEARCH_RADIUS_KM', '5'),
    );
    this.driversPerBatch = parseInt(
      this.config.get<string>('DRIVERS_PER_BATCH', '3'),
      10,
    );
    this.acceptTimeoutMs = parseInt(
      this.config.get<string>('ACCEPT_TIMEOUT_MS', '15000'),
      10,
    );
  }

  private async recordTransition(
    rideId: string,
    fromState: string,
    toState: string,
    metadata?: Record<string, unknown>,
  ) {
    await this.transitionRepo.save(
      this.transitionRepo.create({ rideId, fromState, toState, metadata: metadata ?? null }),
    );
  }

  /**
   * Kicks off (or retries) allocation for a ride: searches for nearby
   * available drivers not already notified, notifies them, opens the
   * acceptance window in Redis, and schedules the timeout job for this
   * specific batch.
   */
  async searchAndNotify(ride: Ride): Promise<void> {
    const nearby = await this.redis.searchNearbyDrivers(
      ride.pickupLng,
      ride.pickupLat,
      this.searchRadiusKm,
      // Over-fetch so we can filter out already-notified drivers and still
      // have enough left for a full batch.
      this.driversPerBatch + ride.notifiedDriverIds.length,
    );

    const freshCandidates = nearby
      .filter((d) => !ride.notifiedDriverIds.includes(d.driverId))
      .slice(0, this.driversPerBatch);

    const fromState = ride.status;

    if (freshCandidates.length === 0) {
      // No more drivers to try -- exhaust immediately rather than opening
      // a window nobody can accept.
      ride.status = RideState.EXPIRED;
      await this.rideRepo.save(ride);
      await this.redis.setRideStatus(ride.id, RideState.EXPIRED);
      await this.recordTransition(ride.id, fromState, RideState.EXPIRED, {
        reason: 'no_available_drivers_in_radius',
      });
      this.logger.warn(`Ride ${ride.id} EXPIRED: no candidates found`);
      return;
    }

    ride.notifiedDriverIds = [
      ...ride.notifiedDriverIds,
      ...freshCandidates.map((d) => d.driverId),
    ];
    ride.status = RideState.SEARCHING;
    await this.rideRepo.save(ride);

    // Redis is the source of truth for accept/timeout race arbitration --
    // (re)initialize it for this batch.
    await this.redis.setRideStatus(ride.id, RideState.SEARCHING);

    await this.recordTransition(ride.id, fromState, RideState.SEARCHING, {
      batch: ride.retryCount,
      candidateDriverIds: freshCandidates.map((d) => d.driverId),
    });

    this.notifications.notifyDrivers(ride.id, freshCandidates, ride.retryCount);

    // Each batch gets its own uniquely-keyed delayed job so retries never
    // collide with a still-pending timeout job from a previous batch.
    await this.timeoutQueue.add(
      'timeout',
      { rideId: ride.id },
      {
        jobId: `${ride.id}-batch-${ride.retryCount}`,
        delay: this.acceptTimeoutMs,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  /**
   * Invoked by the BullMQ worker when a batch's acceptance window elapses.
   * Uses the atomic Lua timeout script so a driver who accepted a split
   * second before this runs is never overridden.
   */
  async handleTimeout(rideId: string): Promise<void> {
    const outcome = await this.redis.attemptTimeoutRide(rideId);

    if (outcome !== 'TIMEOUT') {
      // Ride was already ASSIGNED (or otherwise resolved) before the
      // timeout could apply -- nothing to do.
      this.logger.debug(
        `Timeout fired for ride ${rideId} but status was already ${outcome}; no-op`,
      );
      return;
    }

    const ride = await this.rideRepo.findOne({ where: { id: rideId } });
    if (!ride) {
      this.logger.warn(`Timeout fired for unknown ride ${rideId}`);
      return;
    }

    // Another safety check: if Postgres already shows ASSIGNED (e.g. the
    // accept request's Postgres write landed just before this ran), don't
    // regress it.
    if (ride.status === RideState.ASSIGNED) {
      return;
    }

    const fromState = ride.status;
    ride.status = RideState.TIMEOUT;
    await this.rideRepo.save(ride);
    await this.recordTransition(ride.id, fromState, RideState.TIMEOUT, {
      batch: ride.retryCount,
    });

    if (ride.retryCount >= ride.maxRetries) {
      ride.status = RideState.EXPIRED;
      await this.rideRepo.save(ride);
      await this.redis.setRideStatus(ride.id, RideState.EXPIRED);
      await this.recordTransition(ride.id, RideState.TIMEOUT, RideState.EXPIRED, {
        reason: 'max_retries_exhausted',
      });
      this.logger.warn(`Ride ${ride.id} EXPIRED after ${ride.retryCount} retries`);
      return;
    }

    ride.retryCount += 1;
    await this.rideRepo.save(ride);
    this.logger.log(
      `Ride ${ride.id} timed out, retrying (attempt ${ride.retryCount}/${ride.maxRetries})`,
    );
    await this.searchAndNotify(ride);
  }

  /**
   * Called after a successful accept to stop the now-irrelevant scheduled
   * timeout job for the batch that won. Best-effort: if the job already
   * fired, attemptTimeoutRide's status guard makes it a safe no-op anyway.
   */
  async cancelScheduledTimeout(rideId: string, batch: number): Promise<void> {
    const job = await this.timeoutQueue.getJob(`${rideId}-batch-${batch}`);
    if (job) {
      await job.remove().catch(() => undefined);
    }
  }

  async markDriverBusy(driverId: string): Promise<void> {
    await this.driversService.setStatus(driverId, DriverStatus.BUSY);
  }
}
