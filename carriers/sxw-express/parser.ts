import { countryCode } from '../../core/time/index.js';
import { airportTimeZone, locatePlace } from '../../places/index.js';
import { countryZones, mainZone } from '../../places/zones.js';
import { gofoScanZone } from '../gofo/clock.js';
import { GOFO_CLOCK_ZONE } from '../gofo/parser.js';
import type { HualeiRow, HualeiTenant, HualeiZoneClock } from '../gzyl/hualei.js';
import { sxwEnglish, sxwStage } from './status.js';

export const PROVIDER = 'SXW Express';
export const SXW_ORIGIN = 'http://www.sxwexpress.cn:8082';

// Australia Post's rows, which SXW copies with the suburb and its state alone.
const AUSTRALIAN_STATE = /(?:^|[\s,])(?:ACT|NSW|NT|QLD|SA|TAS|VIC|WA)(?:\s+\d{4})?$/;
// SXW copies them on the clock of Australia's east coast wherever the suburb lies: its copy of a
// Queensland row reads an hour later than Australia Post's own, a Victorian row the same.
const AUSTRALIA_POST_CLOCK: HualeiZoneClock = { zone: mainZone('AU') ?? 'Australia/Sydney', basis: 'destination' };

/** A row SXW copies from Australia Post: a suburb and its state that the gazetteer places in Australia. */
const australiaPost = (place: string): boolean => AUSTRALIAN_STATE.test(place) && locatePlace(place)?.country === 'AU';

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
  return australiaPost(place);
}

// GOFO's rows in the United States, from its regional hub's on: SXW takes GOFO's Pacific clocks for Eastern ones
// before writing them on Beijing's, so its copies come three hours before GOFO's own scans, at Carteret, Charlotte
// and Miami as on a row with no place. They are dated on GOFO's clock and shown on the station's, as GOFO's are.
const GOFO_ROW = /\bGOFO\b/;
const gofoClock = (row: HualeiRow): HualeiZoneClock => ({
  zone: gofoScanZone(row.location, row.content) ?? GOFO_CLOCK_ZONE, basis: 'carrier', misread: { zone: GOFO_CLOCK_ZONE, as: 'America/New_York' },
});

const arrivals = new WeakMap<readonly HualeiRow[], { abroad: string | null; gofo: string | null }>();
const earliest = (rows: readonly HualeiRow[], test: (row: HualeiRow) => boolean) => rows.filter(test).map((row) => row.clock).sort()[0] ?? null;

/**
 * The partner abroad gives its rows on the destination's wall clock, and SXW
 * copies the delivery carrier's rows after them the same way: from the
 * earliest row placed abroad on, a row keeps its wall clock. Read on Beijing's
 * clock, an Australian row would come before the platform wrote it, and Royal
 * Mail dates the acceptance SXW copies at that wall clock in the UK. Australia
 * Post's rows are on Australia's east coast clock, whatever their place. GOFO's
 * rows, from the first that names GOFO on, are on GOFO's clock.
 */
function sxwClock(row: HualeiRow, rows: readonly HualeiRow[]): 'platform' | 'wall' | HualeiZoneClock {
  if (!arrivals.has(rows)) {
    arrivals.set(rows, { abroad: earliest(rows, (other) => abroad(other.location)), gofo: earliest(rows, (other) => GOFO_ROW.test(other.content)) });
  }
  const arrival = arrivals.get(rows)!;
  if (arrival.gofo && row.clock >= arrival.gofo) return gofoClock(row);
  if (!arrival.abroad || row.clock < arrival.abroad) return 'platform';
  return australiaPost(row.location.trim()) ? AUSTRALIA_POST_CLOCK : 'wall';
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
