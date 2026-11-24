import type { CarrierResult } from '../../core/result/index.js';
import { dateDhlRows } from '../gzyl/dhl-rows.js';
import type { HualeiRow, HualeiTenant } from '../gzyl/hualei.js';
import { isQlgjDhlGermanRow, isQlgjDhlRow, qlgjEnglish, qlgjStage } from './status.js';

export const PROVIDER = 'Qilin International';
export const QLGJ_ORIGIN = 'http://www.qlgj168.com:8082';

const CHINESE = /[一-鿿]/;
// The places in China the tracker writes in Latin letters, spaced or not ("shen zhen", "shanghai").
const CHINA = /^(?:shen ?zhen|shang ?hai|guang ?zhou|cn|china)$/i;

/**
 * Rows in China, placed there or nowhere, are on the platform's Beijing clock. A row placed
 * abroad, such as the flight's arrival at its airport, keeps its wall clock: its zone is not stated.
 * So does a row copied from DHL, placed or not: it is on DHL's clock where DHL scanned the parcel.
 */
function qlgjClock({ content, location }: HualeiRow): 'platform' | 'wall' {
  const place = location.trim();
  if (isQlgjDhlRow(content)) return 'wall';
  return !place || CHINESE.test(place) || CHINA.test(place) ? 'platform' : 'wall';
}

export const QLGJ: HualeiTenant = {
  carrier: 'qlgj', provider: PROVIDER, origin: QLGJ_ORIGIN, stage: qlgjStage, english: qlgjEnglish,
  ownNumber: /^QL\d{13}YQ$/, unlabelledPartners: ['dhl'], clock: qlgjClock,
};

/** The result with the rows the tracker copies from DHL dated, each keeping its wall clock. */
export const dateQlgjDhlRows = (result: CarrierResult): CarrierResult =>
  dateDhlRows(result, { isRow: isQlgjDhlRow, isGermanRow: isQlgjDhlGermanRow });
