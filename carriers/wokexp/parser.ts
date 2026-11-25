import type { CarrierResult } from '../../core/result/index.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiRow, type HualeiTenant } from '../gzyl/hualei.js';
import { wokexpStage } from './status.js';

export const PROVIDER = 'Wokexp';
export const WOKEXP_ORIGIN = 'http://www.wokexp.cn:8082';

// Poste Italiane's sentences the tracker copies on the line to Italy: "Consegnata, la spedizione è stata consegnata".
const POSTE_ITALIANE_ROW = /^(?:consegnat[ae]|in consegna|in transito|in giacenza|presa in carico|in lavorazione|non consegnat[ae]|accettat[ae])\b|\bla spedizione\b/i;

/** Whether a row is one the tracker copies from Poste Italiane, in Italian. */
export const isWokexpPosteRow = (wording: string): boolean => POSTE_ITALIANE_ROW.test(wording.trim());

/**
 * The forwarder's own rows are on the platform's Beijing clock. The rows it copies from Poste
 * Italiane keep Italy's wall clock: read on Beijing's, the parcel would go out for delivery at four
 * in the morning in Italy.
 */
export function wokexpClock({ content }: HualeiRow): 'platform' | 'wall' {
  return isWokexpPosteRow(content) ? 'wall' : 'platform';
}

/**
 * Poste Italiane gives a scan twice: its category alone, and the category followed by its
 * sentence ("In consegna, la spedizione è in consegna"). At one clock and place, a wording that
 * starts with another and a comma is that scan again.
 */
export const repeatsWokexpRow = (wording: string, other: string): boolean => wording.startsWith(`${other}, `);

/**
 * Wokexp's tenant of the Hualei platform. Its line to Italy flies parcels to Amsterdam and hands
 * them to Poste Italiane, whose scans the tracker copies in Italian.
 */
export const WOKEXP: HualeiTenant = {
  carrier: 'wokexp', provider: PROVIDER, origin: WOKEXP_ORIGIN, stage: wokexpStage, clock: wokexpClock, repeats: repeatsWokexpRow,
};

/** The track interface's reply, or null when it holds no row for the number. */
export const parseWokexpTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, WOKEXP, readAt);
export const parseWokexpPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, WOKEXP, readAt);
