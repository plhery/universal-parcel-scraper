import type { SameInstantScan } from './eventIdentity.js';

const normalized = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');

/** Adding a place must keep the scan's wording and known stage; conflicting places do not match. */
export function matchesLocationEnrichment(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const wording = normalized(incoming.description);
  const location = normalized(incoming.location);
  const savedLocation = normalized(stored.location);
  return Boolean(location && wording) && !['', 'unknown'].includes(incoming.stage)
    && incoming.stage === stored.stage && wording === normalized(stored.description)
    && (!savedLocation || location === savedLocation);
}
