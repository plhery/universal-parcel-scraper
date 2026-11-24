import type { CarrierResult } from '../../core/result/index.js';
import { countryCode } from '../../core/time/index.js';
import { dateDhlRows } from '../gzyl/dhl-rows.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiRow, type HualeiTenant } from '../gzyl/hualei.js';
import { isVyangDhlGermanRow, isVyangDhlRow, vyangStage } from './status.js';

export const PROVIDER = 'VYANG International';
export const VYANG_ORIGIN = 'http://43.136.110.132:8082';

/** A row placed abroad: its place ends in the code of a country other than China ("LIEGE, AVALON, BE", "BE"). */
function abroad(location: string): boolean {
  const code = /(?:^|[\s,])([A-Z]{2})$/.exec(location.trim())?.[1];
  return Boolean(code) && code !== 'CN' && countryCode(code) === code;
}

const arrivals = new WeakMap<readonly HualeiRow[], string | null>();

/**
 * Rows in China, placed there ("Mainland China, CN", "DONGGUAN") or nowhere, are on the platform's
 * Beijing clock. From the flight's landing abroad on, the line's rows keep the wall clock where
 * they were written, as do the rows the tracker copies from DHL: their zone is not stated. Read on
 * Beijing's clock, the flight from China to Liège would take eight hours.
 */
export function vyangClock(row: HualeiRow, rows: readonly HualeiRow[]): 'platform' | 'wall' {
  if (isVyangDhlRow(row.content)) return 'wall';
  if (!arrivals.has(rows)) {
    arrivals.set(rows, rows.filter((other) => abroad(other.location)).map((other) => other.clock).sort()[0] ?? null);
  }
  const arrival = arrivals.get(rows);
  return arrival && row.clock >= arrival ? 'wall' : 'platform';
}

/**
 * VYANG's own tenant of the Hualei platform. The transfer number a record holds is the delivery
 * carrier's, DHL's in Germany, which the tracker names no channel for.
 */
export const VYANG: HualeiTenant = {
  carrier: 'vyang', provider: PROVIDER, origin: VYANG_ORIGIN, stage: vyangStage, unlabelledPartners: ['dhl'], clock: vyangClock,
};

/** The result with the rows the tracker copies from DHL dated, each keeping its wall clock. */
export const dateVyangDhlRows = (result: CarrierResult): CarrierResult =>
  dateDhlRows(result, { isRow: isVyangDhlRow, isGermanRow: isVyangDhlGermanRow });

export function parseVyangTrack(payload: unknown, number: string, readAt?: number): CarrierResult | null {
  const result = parseHualeiTrack(payload, number, VYANG, readAt);
  return result && dateVyangDhlRows(result);
}

export const parseVyangPage = (html: string, number: string, readAt?: number): CarrierResult =>
  dateVyangDhlRows(parseHualeiPage(html, number, VYANG, readAt));
