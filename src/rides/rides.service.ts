import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Ride } from './entities/ride.entity';
import { RideStateTransition } from './entities/ride-state-transition.entity';
import { RideState } from './ride.state';
import { CreateRideDto } from './dto/create-ride.dto';
import { AllocationService } from '../allocation/allocation.service';
import { NotificationService } from '../allocation/notification.service';
import { RedisService } from '../common/redis/redis.service';

export interface AcceptRideResponse {
  rideId: string;
  status: string;
  assignedDriverId: string | null;
  idempotentReplay?: boolean;
}

@Injectable()
export class RidesService {
  private readonly logger = new Logger(RidesService.name);
  private readonly maxRetries: number;

  constructor(
    @InjectRepository(Ride) private readonly rideRepo: Repository<Ride>,
    @InjectRepository(RideStateTransition)
    private readonly transitionRepo: Repository<RideStateTransition>,
    private readonly allocationService: AllocationService,
    private readonly notificationService: NotificationService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {
    this.maxRetries = parseInt(
      this.config.get<string>('MAX_ALLOCATION_RETRIES', '3'),
      10,
    );
  }

  async createRide(dto: CreateRideDto): Promise<Ride> {
    const ride = this.rideRepo.create({
      riderId: dto.riderId,
      pickupLat: dto.pickupLat,
      pickupLng: dto.pickupLng,
      status: RideState.REQUESTED,
      notifiedDriverIds: [],
      retryCount: 0,
      maxRetries: this.maxRetries,
    });
    const saved = await this.rideRepo.save(ride);
    await this.transitionRepo.save(
      this.transitionRepo.create({
        rideId: saved.id,
        fromState: 'NONE',
        toState: RideState.REQUESTED,
      }),
    );

    // Kick off the first search+notify batch immediately. In a system with
    // heavier fan-out this would go through a queue instead of running
    // inline; inline is fine here since the search itself is a single fast
    // Redis GEOSEARCH call.
    await this.allocationService.searchAndNotify(saved);

    return this.findOne(saved.id);
  }

  async findOne(id: string): Promise<Ride> {
    const ride = await this.rideRepo.findOne({ where: { id } });
    if (!ride) {
      throw new NotFoundException(`Ride ${id} not found`);
    }
    return ride;
  }

  async findAll(): Promise<Ride[]> {
    return this.rideRepo.find({ order: { createdAt: 'DESC' } });
  }

  getNotifications(rideId: string) {
    return this.notificationService.getNotificationsForRide(rideId);
  }

  async getStateHistory(rideId: string): Promise<RideStateTransition[]> {
    return this.transitionRepo.find({
      where: { rideId },
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * The accept endpoint. All the concurrency-critical decision-making
   * already happened atomically in Redis (see RedisService.attemptAcceptRide
   * / accept-ride.lua) before we get here -- this method's job is just to
   * translate that decision into an HTTP response and persist it to
   * Postgres for durable state / querying.
   */
  async acceptRide(rideId: string, driverId: string): Promise<AcceptRideResponse> {
    const result = await this.redis.attemptAcceptRide(rideId, driverId);

    if (result.outcome === 'NOT_FOUND') {
      throw new NotFoundException(`Ride ${rideId} not found or not open`);
    }

    if (result.outcome === 'REJECTED') {
      throw new ConflictException({
        message: 'Ride is no longer available for acceptance',
        rideId,
        status: result.status,
        assignedDriverId: result.winningDriverId,
      });
    }

    // ASSIGNED or ALREADY_ASSIGNED_TO_YOU both mean this driverId is (now,
    // or still) the winner. Persist idempotently: the guarded UPDATE below
    // only actually changes a row the first time it runs, so replays of
    // this same driver's accept call are safe no-ops on the DB side too.
    const ride = await this.findOne(rideId);
    const wasAlreadyPersisted = ride.status === RideState.ASSIGNED;

    if (!wasAlreadyPersisted) {
      const fromState = ride.status;
      ride.status = RideState.ASSIGNED;
      ride.assignedDriverId = driverId;
      await this.rideRepo.save(ride);
      await this.transitionRepo.save(
        this.transitionRepo.create({
          rideId,
          fromState,
          toState: RideState.ASSIGNED,
          metadata: { driverId },
        }),
      );

      await this.allocationService.cancelScheduledTimeout(
        rideId,
        ride.retryCount,
      );
      await this.allocationService.markDriverBusy(driverId);

      this.logger.log(`Ride ${rideId} ASSIGNED to driver ${driverId}`);
    }

    return {
      rideId,
      status: RideState.ASSIGNED,
      assignedDriverId: driverId,
      idempotentReplay:
        wasAlreadyPersisted || result.outcome === 'ALREADY_ASSIGNED_TO_YOU',
    };
  }
}
