import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Ride } from './entities/ride.entity';
import { RideStateTransition } from './entities/ride-state-transition.entity';
import { RidesService } from './rides.service';
import { RidesController } from './rides.controller';
import { AllocationModule } from '../allocation/allocation.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Ride, RideStateTransition]),
    AllocationModule,
  ],
  controllers: [RidesController],
  providers: [RidesService],
})
export class RidesModule {}
