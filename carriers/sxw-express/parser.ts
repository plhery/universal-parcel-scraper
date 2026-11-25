import { countryCode } from '../../core/time/index.js';
import { airportTimeZone, locatePlace } from '../../places/index.js';
import { countryZones } from '../../places/zones.js';
import type { HualeiRow, HualeiTenant } from '../gzyl/hualei.js';
import { sxwEnglish, sxwStage } from './status.js';

export const PROVIDER = 'SXW Express';
export const SXW_ORIGIN = 'http://www.sxwexpress.cn:8082';

// Australia Post's rows, which SXW copies with the suburb and its state alone.
const AUSTRALIAN_STATE = /(?:^|[\s,])(?:ACT|NSW|NT|QLD|SA|TAS|VIC|WA)(?:\s+\d{4})?$/;

/**
 * A row placed abroad: its place ends in the code of a country other than China ("…, GB", "AU"), is
 * an airport outside China named by its code alone, as the line's landing ("MEL"), or is an
 * Australian suburb and its state, as Australia Post's rows name them.
 */
function abroad(location: string): boolean {
  const place = location.trim();
  const code = /(?:^|[\s,])([A-Z]{2})$/.exec(place)?.[1];
  if (code && code !== 'CN' && countryCode(code) === code) return true;
  if (/^[A-Z]{3}$/.test(place)) {
    const zone = airportTimeZone(place);
    return zone !== null && !countryZones('CN').includes(zone);
  }
  return AUSTRALIAN_STATE.test(place) && locatePlace(place)?.country === 'AU';
}

const arrivals = new WeakMap<readonly HualeiRow[], string | null>();

/**
 * The partner abroad gives its rows on the destination's wall clock, and SXW
 * copies the delivery carrier's rows after them the same way: from the
 * earliest row placed abroad on, a row keeps its wall clock. Read on Beijing's
 * clock, an Australian row would come before the platform wrote it, and Royal
 * Mail dates the acceptance SXW copies at that wall clock in the UK.
 */
function sxwClock(row: HualeiRow, rows: readonly HualeiRow[]): 'platform' | 'wall' {
  if (!arrivals.has(rows)) {
    arrivals.set(rows, rows.filter((other) => abroad(other.location)).map((other) => other.clock).sort()[0] ?? null);
  }
  const arrival = arrivals.get(rows);
  return arrival && row.clock >= arrival ? 'wall' : 'platform';
}

/**
 * SXW Express's own tenant of the Hualei platform. Its waybills open with SXW; the
 * tracking number a record holds beside one is the delivery carrier's, GOFO's in
 * the United States, which the tracker names no channel for.
 */
export const SXW: HualeiTenant = {
  carrier: 'sxw-express', provider: PROVIDER, origin: SXW_ORIGIN, stage: sxwStage, english: sxwEnglish,
  ownNumber: /^SXW\d{12}$/, unlabelledPartners: ['gofo'], clock: sxwClock,
};
