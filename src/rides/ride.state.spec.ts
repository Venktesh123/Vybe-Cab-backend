import { RideState, TERMINAL_STATES } from './ride.state';

describe('RideState', () => {
  it('marks ASSIGNED, EXPIRED, and CANCELLED as terminal', () => {
    expect(TERMINAL_STATES.has(RideState.ASSIGNED)).toBe(true);
    expect(TERMINAL_STATES.has(RideState.EXPIRED)).toBe(true);
    expect(TERMINAL_STATES.has(RideState.CANCELLED)).toBe(true);
  });

  it('does not mark in-flight states as terminal', () => {
    expect(TERMINAL_STATES.has(RideState.REQUESTED)).toBe(false);
    expect(TERMINAL_STATES.has(RideState.SEARCHING)).toBe(false);
    expect(TERMINAL_STATES.has(RideState.TIMEOUT)).toBe(false);
  });
});
