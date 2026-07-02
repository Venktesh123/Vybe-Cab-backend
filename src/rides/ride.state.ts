export enum RideState {
  REQUESTED = 'REQUESTED', // ride row created, allocation not started yet
  SEARCHING = 'SEARCHING', // a batch of drivers has been notified, awaiting accept
  ASSIGNED = 'ASSIGNED', // a driver has accepted, terminal success state
  TIMEOUT = 'TIMEOUT', // current batch's window expired with no acceptance
  EXPIRED = 'EXPIRED', // retries exhausted, no driver ever accepted, terminal
  CANCELLED = 'CANCELLED', // rider or ops cancelled the ride, terminal
}

export const TERMINAL_STATES = new Set<RideState>([
  RideState.ASSIGNED,
  RideState.EXPIRED,
  RideState.CANCELLED,
]);
