import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Append-only audit trail of every state change a ride goes through.
 * Not required by the assignment, but cheap to add and makes the
 * "observability / failure recovery" story in the write-up concrete --
 * you can always reconstruct exactly what happened to a given ride.
 */
@Entity('ride_state_transitions')
export class RideStateTransition {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'varchar' })
  rideId: string;

  @Column({ type: 'varchar' })
  fromState: string;

  @Column({ type: 'varchar' })
  toState: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt: Date;
}
