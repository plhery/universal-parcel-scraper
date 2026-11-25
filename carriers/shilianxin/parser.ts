import type { CarrierResult } from '../../core/result/index.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiRow, type HualeiTenant } from '../gzyl/hualei.js';
import { splitKunExpressRow } from '../kun-express/parser.js';
import { shilianxinEnglish, shilianxinStage } from './status.js';

export const PROVIDER = 'Shilianxin';
export const SHILIANXIN_ORIGIN = 'http://47.108.154.213:8082';

const HAN = /\p{Script=Han}/u;
// The Chinese half of a row the forwarder words in both languages: "飞行到达；Flight arrived".
const CHINESE_HALF = /^[^；;]*\p{Script=Han}[^；;]*[；;]\s*(?=\S)/u;

/**
 * A row's English half when the forwarder words it in Chinese and English; a row copied from
 * USPS is cut as Kun Express cuts its copies, without the place's ZIP code.
 */
export function splitShilianxinRow(content: string, location: string): { content: string; location: string } {
  const english = content.replace(CHINESE_HALF, '');
  return english === content ? splitKunExpressRow(content, location) : { content: english, location };
}

/**
 * The forwarder words its own rows in Chinese, alone or before their English, on the platform's
 * Beijing clock, to the minute or the second. The rows it copies from USPS are in English alone and
 * keep the facility's wall clock; one at midnight carries only its day.
 */
export function shilianxinClock({ content, clock }: HualeiRow): 'platform' | 'wall' | 'day' {
  if (HAN.test(content)) return 'platform';
  return clock.endsWith(' 00:00:00') ? 'day' : 'wall';
}

/**
 * Shilianxin's tenant of the Hualei platform. Its US line hands the parcel to USPS, whose scans the
 * tracker copies without naming USPS's number.
 */
export const SHILIANXIN: HualeiTenant = {
  carrier: 'shilianxin', provider: PROVIDER, origin: SHILIANXIN_ORIGIN, stage: shilianxinStage, english: shilianxinEnglish,
  split: splitShilianxinRow, clock: shilianxinClock,
};

/** The track interface's reply, or null when it holds no row for the number. */
export const parseShilianxinTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, SHILIANXIN, readAt);
export const parseShilianxinPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, SHILIANXIN, readAt);
