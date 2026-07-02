import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { Ride } from '../rides/entities/ride.entity';
import { RideStateTransition } from '../rides/entities/ride-state-transition.entity';
import { AllocationService, RIDE_TIMEOUT_QUEUE } from './allocation.service';
import { NotificationService } from './notification.service';
import { TimeoutProcessor } from './timeout.processor';
import { DriversModule } from '../drivers/drivers.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Ride, RideStateTransition]),
    BullModule.registerQueue({ name: RIDE_TIMEOUT_QUEUE }),
    DriversModule,
  ],
  providers: [AllocationService, NotificationService, TimeoutProcessor],
  exports: [AllocationService, NotificationService],
})
export class AllocationModule {}
