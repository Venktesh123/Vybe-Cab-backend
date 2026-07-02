import { Injectable, Logger } from '@nestjs/common';

export interface DriverNotification {
  rideId: string;
  driverId: string;
  distanceKm: number;
  batchNumber: number;
  notifiedAt: string;
}

/**
 * Simulated notification channel, as explicitly permitted by the
 * assignment ("WebSockets, SSE, polling, or a simulated notification log
 * are all acceptable"). This keeps an in-memory log per ride so it can be
 * inspected via GET /rides/:id/notifications, and also writes to the
 * application log so it's visible in the screen recording.
 *
 * Swapping this for real push (e.g. a WebSocket gateway keyed by driverId)
 * would only mean changing the body of notifyDrivers() -- nothing in
 * AllocationService or RidesService needs to change, since they only
 * depend on this class's public interface.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private readonly log = new Map<string, DriverNotification[]>();

  notifyDrivers(
    rideId: string,
    drivers: { driverId: string; distanceKm: number }[],
    batchNumber: number,
  ): void {
    const now = new Date().toISOString();
    const entries = this.log.get(rideId) ?? [];

    for (const d of drivers) {
      const entry: DriverNotification = {
        rideId,
        driverId: d.driverId,
        distanceKm: d.distanceKm,
        batchNumber,
        notifiedAt: now,
      };
      entries.push(entry);
      this.logger.log(
        `NOTIFY ride=${rideId} batch=${batchNumber} driver=${d.driverId} distanceKm=${d.distanceKm.toFixed(2)}`,
      );
    }

    this.log.set(rideId, entries);
  }

  getNotificationsForRide(rideId: string): DriverNotification[] {
    return this.log.get(rideId) ?? [];
  }
}
