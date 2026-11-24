import type { CarrierResult } from '../../core/result/index.js';
import { kuayuanStage, statusMap } from './status.js';
import { normalizeRetomsNumber, parseRetoms, RETOMS_MAX_BYTES, type RetomsTenant } from './retoms.js';

export const PROVIDER = 'Kuayuan Express';
export const KUAYUAN_MAX_BYTES = RETOMS_MAX_BYTES;
/** The endpoint the tracking form on Kuayuan's home page posts to. */
export const KUAYUAN_API = 'https://kuayuanexpress.com.cn/api/re-toms/v1';

/**
 * Kuayuan's tenant of the re-toms order system. Its page sends one token with
 * every lookup, and its map reads every scan under `ND`, the line's, as in
 * transit. The shipment may name the number asked as Kuayuan's or the line's,
 * and the line's number is kept only for a carrier that claims it. The
 * recipient's name and town are kept.
 */
export const KUAYUAN: RetomsTenant = {
  carrier: 'kuayuan-express', provider: PROVIDER, api: KUAYUAN_API, page: 'https://www.kuayuanexpress.com.cn/',
  // A digit, three letters and ten digits: the numbers Kuayuan's tracker answers with its scans.
  number: /^\d[A-Z]{3}\d{10}$/, numberFormat: 'a digit, three letters and ten digits',
  // The token the home page's script sends with every lookup; every visitor gets the same one.
  auth: { token: 'd68d8e7efc586bd8806b' }, // gitleaks:allow
  // The answer for a number the tracker has nothing for, in English and in Chinese.
  notFound: /^(?:Trajectory Information does not exist|轨迹信息不存在)$/i,
  stage: kuayuanStage, statusMap, place: { maxLength: 120 }, identity: ['shipper_hawbcode', 'server_hawbcode'], recipient: true,
};

/** A Kuayuan number in upper case, as the tracker reads it; anything else is not one Kuayuan issues. */
export const normalizeKuayuanNumber = (raw: string): string => normalizeRetomsNumber(raw, KUAYUAN);

/** The reply of the home page's `getTrackInfoOutside` call for one Kuayuan number. */
export const parseKuayuan = (payload: unknown, raw: string): CarrierResult => parseRetoms(payload, raw, KUAYUAN);
