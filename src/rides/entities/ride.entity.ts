import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { RideState } from '../ride.state';

@Entity('rides')
export class Ride {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  riderId: string;

  @Column({ type: 'double precision' })
  pickupLat: number;

  @Column({ type: 'double precision' })
  pickupLng: number;

  @Index()
  @Column({ type: 'varchar', default: RideState.REQUESTED })
  status: RideState;

  @Column({ type: 'varchar', nullable: true })
  assignedDriverId: string | null;

  // Driver ids already notified across all retry batches, so a retry never
  // re-notifies someone who already ignored/missed this ride.
  @Column({ type: 'jsonb', default: () => "'[]'" })
  notifiedDriverIds: string[];

  @Column({ type: 'int', default: 0 })
  retryCount: number;

  @Column({ type: 'int', default: 3 })
  maxRetries: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
