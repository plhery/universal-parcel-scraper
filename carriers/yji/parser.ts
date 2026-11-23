import type { CarrierResult } from '../../core/result/index.js';
import { usStateTimeZone } from '../../core/time/index.js';
import { dateWallClocks } from '../gzyl/gofo-rows.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { yjiStage } from './status.js';

export const PROVIDER = 'YJI';
export const YJI_ORIGIN = 'http://yanjin-gj.com:8082';

// A row the tracker copies from the US delivery carrier, placed as `US,<state>,<town>`, or as `US` alone.
const US_PLACE = /^US(?:,([A-Z]{2}),(.+))?$/;
// The place a copied row ends up with once written as the town and its state's code.
const TOWN_STATE = /^(.+), ([A-Z]{2})$/;

/** A copied row's place, `US,TN,MEMPHIS`, as the town and its state's code; other places as written. */
export function splitYjiRow(content: string, location: string): { content: string; location: string } {
  const place = US_PLACE.exec(location.trim());
  return { content, location: place?.[1] ? `${place[2]!.trim()}, ${place[1]}` : location };
}

/**
 * The rows the tracker copies from FedEx, placed in the United States, keep FedEx's wall clock;
 * the forwarder's own rows and notes are on the platform's Beijing clock.
 */
export const YJI: HualeiTenant = {
  carrier: 'yji', provider: PROVIDER, origin: YJI_ORIGIN, stage: yjiStage, split: splitYjiRow,
  clock: ({ location }) => (US_PLACE.test(location.trim()) ? 'wall' : 'platform'),
};

/** The record with each copied FedEx row placed in a state dated in that state's zone. */
export const finishYjiRecord = (result: CarrierResult): CarrierResult => dateWallClocks(result, (event) => {
  const state = TOWN_STATE.exec(event.location ?? '')?.[2];
  const zone = state ? usStateTimeZone(state) : null;
  return zone ? { zone, basis: 'place' } : null;
});

/** The track interface's reply, or null when it holds no row for the number. */
export function parseYjiTrack(payload: unknown, number: string, readAt?: number): CarrierResult | null {
  const result = parseHualeiTrack(payload, number, YJI, readAt);
  return result && finishYjiRecord(result);
}
export const parseYjiPage = (html: string, number: string, readAt?: number): CarrierResult =>
  finishYjiRecord(parseHualeiPage(html, number, YJI, readAt));
