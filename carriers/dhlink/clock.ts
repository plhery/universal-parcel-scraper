import { isoTime } from '../../core/time/index.js';

// DHLink records each row on Beijing time (`createDate`): rows scanned in China
// are recorded within seconds of their clocks.
export const DHLINK_RECORD_ZONE = 'Asia/Shanghai';
// The clocks of the contiguous US, where GOFO and SwiftX deliver.
const US_ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles'];

/**
 * Whether a partner's scan, at `wall` on its US wall clock, is its copy of
 * DHLink's own row of the scan at `timestamp`: a US reading of its clock
 * gives that instant.
 */
export function usClockCopy(wall: string, timestamp: number): boolean {
  return usClockZone(wall, timestamp) !== null;
}

/** The US zone, the state's first, on whose clock `wall` strikes at `timestamp`; null when none does. */
export function usClockZone(wall: string, timestamp: number, state?: string | null): string | null {
  return [...(state ? [state] : []), ...US_ZONES].find((zone) => isoTime(wall, zone)?.timestamp === timestamp) ?? null;
}
