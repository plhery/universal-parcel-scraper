import type { CarrierResult } from '../../core/result/index.js';
import { countryCode } from '../../core/time/index.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiRow, type HualeiTenant } from '../gzyl/hualei.js';
import { isZxsyNotice, zxsyEnglish, zxsyStage } from './status.js';

export const PROVIDER = 'ZXSY';
export const ZXSY_ORIGIN = 'http://www.zxsywl.cn:8082';

// A status code alone, without a place: DELIVERED, ITEM_AT_DELIVERY_DEPOT, RELEASED_FROM_CUSTOMS, INFO.
const BARE_CODE = /^[A-Z]+(?:_[A-Z]+)*$/;

/**
 * A row without the bare status codes the delivering carrier's feed writes beside its worded scans,
 * which are dropped. Each repeats a worded scan of the same feed, and its clock is that scan's
 * wall clock read as UTC: Helthjem's own tracker dates the delivery at the wall clock the worded
 * scan shows, the code row eight hours later on Beijing's clock. `INFO` says nothing at all.
 */
export function splitZxsyRow(content: string, location: string): { content: string; location: string } {
  return !location.trim() && BARE_CODE.test(content.trim()) ? { content: '', location: '' } : { content, location };
}

/** The country a place names, by its code or name alone or after its last comma: "NO", "Norway", "Oslo Airport, Norway". */
const placeCountry = (place: string): string | null => countryCode(place.split(',').at(-1) ?? '');

const landings = new WeakMap<readonly HualeiRow[], string | null>();

/**
 * The line's own rows, placed at a country, in China or nowhere, are on the platform's Beijing clock.
 * From the first row placed in another country on, a row placed at a town, a depot or an airport
 * there is one the tracker copies from the airport's handler or the delivering carrier, and keeps
 * its wall clock: no zone is stated, and Helthjem's own tracker gives its scans the same wall clocks.
 */
export function zxsyClock(row: HualeiRow, rows: readonly HualeiRow[]): 'platform' | 'wall' {
  const place = row.location.trim();
  if (!/\p{L}/u.test(place) || /\p{Script=Han}/u.test(place) || countryCode(place)) return 'platform';
  if (!landings.has(rows)) {
    const abroad = rows.filter((other) => { const country = placeCountry(other.location); return country && country !== 'CN'; });
    landings.set(rows, abroad.map((other) => other.clock).sort()[0] ?? null);
  }
  const landing = landings.get(rows);
  return landing && row.clock >= landing ? 'wall' : 'platform';
}

/**
 * ZXSY's tenant of the Hualei platform. Its own numbers are ZXSY, eight digits and CN; once the
 * delivering carrier's number has taken the record's tracking number, that number is Helthjem's on
 * the line to Norway, without a channel name.
 */
export const ZXSY: HualeiTenant = {
  carrier: 'zxsy', provider: PROVIDER, origin: ZXSY_ORIGIN, stage: zxsyStage, english: zxsyEnglish,
  split: splitZxsyRow, clock: zxsyClock, ownNumber: /^ZXSY\d+CN$/, unlabelledPartners: ['helthjem'],
  notice: (_code, wording) => isZxsyNotice(wording),
};

/** The track interface's reply, or null when it holds no row for the number. */
export const parseZxsyTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, ZXSY, readAt);
export const parseZxsyPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, ZXSY, readAt);
