import type { CarrierResult } from '../../core/result/index.js';
import { normalizeRetomsNumber, parseRetoms, RETOMS_MAX_BYTES, type RetomsTenant } from '../kuayuan-express/retoms.js';
import { statusMap, wldStage } from './status.js';

export const PROVIDER = 'WLD Express';
export const WLD_MAX_BYTES = RETOMS_MAX_BYTES;
/** The endpoint WLD's track query page posts to. */
export const WLD_API = 'https://wld-exp.com/api/re-toms/v1';

/**
 * WLD's tenant of the re-toms order system. Its tracker checks the token the
 * page signs each request with. Its scans under `ND` include the line's
 * delivery attempts, so `wldStage` reads them by their wording. The line's
 * place is written `office|town`, and the page shows the line's number as the
 * tracking number. The recipient's name and town are not kept.
 */
export const WLD: RetomsTenant = {
  carrier: 'wld-express', provider: PROVIDER, api: WLD_API, page: 'https://wld-exp.com/',
  // WLD, two letters and ten digits: the numbers WLD's tracker answers with its scans.
  number: /^WLD[A-Z]{2}\d{10}$/, numberFormat: 'WLD, two letters and ten digits',
  // The key the page's script signs every request with; every visitor gets the same one.
  auth: { signingKey: 'EYOU7RF4' }, // gitleaks:allow
  // The answer for a number the tracker does not hold, in English and in Chinese.
  notFound: /^(?:Code does not exist|单号不存在)$/i,
  stage: wldStage, statusMap, place: { maxLength: 160, officeTown: true }, identity: ['shipper_hawbcode'], keepsLine: true,
};

/** A WLD number in upper case, as the tracker reads it; anything else is not one WLD issues. */
export const normalizeWldNumber = (raw: string): string => normalizeRetomsNumber(raw, WLD);

/** The reply of the track query page's `getTrackInfoOutside` call for one WLD number. */
export const parseWld = (payload: unknown, raw: string): CarrierResult => parseRetoms(payload, raw, WLD);
