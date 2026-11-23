import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { parseGetOnline, type GetOnlineMember } from '../skynet-worldwide/getonline.js';
import { skyquickStage } from './status.js';

export const PROVIDER = 'SkyQuick International';
/** The GETOnline page Frontier Force hosts for SkyQuick, `stid=skyquick`. */
export const SKYQUICK_TRACKER = 'https://tracking.frontierforce.com/go/plm-tracking';
// The tracker takes any reference and checks none; this keeps out what cannot be one.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,20}$/;
// A run of zeros is a placeholder, not an air waybill.
const PLACEHOLDER = /^0+$/;

/** A reference for SkyQuick's tracker: eight to twenty letters and digits with at least one digit, not all zeros. */
export function normalizeSkyquickNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number) || PLACEHOLDER.test(number)) throw new InvalidInputError(PROVIDER, 'SkyQuick air waybills are eight to twenty letters and digits');
  return number;
}

export const SKYQUICK: GetOnlineMember = {
  carrier: 'skyquick', provider: PROVIDER, name: 'SkyQuick', stid: 'skyquick', tracker: SKYQUICK_TRACKER,
  normalize: normalizeSkyquickNumber, stage: skyquickStage,
};

/** The tracker's page for one air waybill, `go/plm-tracking?stid=skyquick&cn=`. */
export const parseSkyquick = (html: string, rawNumber: string): CarrierResult => parseGetOnline(html, rawNumber, SKYQUICK);
