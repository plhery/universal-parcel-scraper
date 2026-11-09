import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { dhlPolandScanKind } from './status.js';

const wording = (scan: SameInstantScan) => scan.description.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * DHL rewords a history scan in place: a terminal arrival later gains its planned delivery day
 * ("… in Zabrze. Planned date of delivery to: 04-11-2026."). Its scans carry no code, so a scan at
 * the same instant and the same named place takes over the stored row, whatever its wording now;
 * the match must still be unique both ways, which keeps two scans the page lists at one minute apart.
 * Scans with no place need the same wording, or wordings the map reads as one scan: the page words a
 * Polish reader's scans in Polish, and a row stored in English takes them.
 */
function reworded(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const place = incoming.location.trim();
  if (place !== stored.location.trim() || !wording(incoming) || !wording(stored)) return false;
  if (place !== '' || wording(incoming) === wording(stored)) return true;
  const kind = dhlPolandScanKind(incoming.description);
  return kind !== undefined && kind === dhlPolandScanKind(stored.description);
}

export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'dhl-ecommerce-pl', storedSources: ['dhl-ecommerce-pl'], requireProviderCode: false,
  matchEachScan: true,
  matches: reworded,
};
