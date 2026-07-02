import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { AllocationService, RIDE_TIMEOUT_QUEUE } from './allocation.service';

@Processor(RIDE_TIMEOUT_QUEUE)
export class TimeoutProcessor extends WorkerHost {
  private readonly logger = new Logger(TimeoutProcessor.name);

  constructor(private readonly allocationService: AllocationService) {
    super();
  }

  async process(job: Job<{ rideId: string }>): Promise<void> {
    this.logger.debug(`Processing timeout job for ride ${job.data.rideId}`);
    await this.allocationService.handleTimeout(job.data.rideId);
  }
}
