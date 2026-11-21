import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { dhlPolandScanKind } from './status.js';

const wording = (scan: SameInstantScan) => scan.description.replace(/\s+/g, ' ').trim().toLowerCase();

// A terminal arrival, the scan DHL rewords in place, in either language.
const TERMINAL = /^(?:the shipment has reached dhl terminal|przesyłka dotarła do (?:oddziału|terminala))[ .]/i;

/**
 * DHL rewords a history scan in place: a terminal arrival later gains its planned delivery day
 * ("… in Zabrze. Planned date of delivery to: 04-11-2026."). Its scans carry no code, so a scan at
 * the same instant and the same named place takes over the stored row, whatever its wording now;
 * the match must still be unique both ways, which keeps two scans the page lists at one minute apart.
 * The page lists a terminal arrival and its sorting at one minute and one place, so two scans the
 * map reads as different scans stay apart there, unless both are terminal arrivals.
 * Scans with no place need the same wording, or wordings the map reads as one scan: the page words a
 * Polish reader's scans in Polish, and a row stored in English takes them. The page translates some
 * places too ("Koninko (branch in Gądki)", "Koninko (z siedzibą w Gądkach)"), so a scan at another
 * place takes the row over only when the map reads both wordings as one scan.
 */
function reworded(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const place = incoming.location.trim();
  if (!wording(incoming) || !wording(stored)) return false;
  const kind = dhlPolandScanKind(incoming.description);
  const storedKind = dhlPolandScanKind(stored.description);
  if (place === stored.location.trim() && (place !== '' || wording(incoming) === wording(stored))) {
    return kind === undefined || storedKind === undefined || kind === storedKind
      || (TERMINAL.test(wording(incoming)) && TERMINAL.test(wording(stored)));
  }
  return kind !== undefined && kind === storedKind;
}

export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'dhl-ecommerce-pl', storedSources: ['dhl-ecommerce-pl'], requireProviderCode: false,
  matchEachScan: true,
  matches: reworded,
};
