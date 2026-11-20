import type { Stage } from '../../core/status/index.js';
import { statusWordings } from '../../core/status/english.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = statusWordings(statuses.entries);
// A flight row names the day it expects the flight as month-day: "预计10-22飞".
const FLIGHT_DAY = /(预计)\d{1,2}-\d{1,2}(飞)$/u;

// The depot hand-over row starts with a month-day: "10-31 已交仓 留意官网更新", or "11-17 已全部交仓 留意官网更新"
// once every parcel of the shipment is there.
const HANDED_OVER_DAY = /^\d{1,2}-\d{1,2}( 已(?:全部)?交仓 留意官网更新)$/u;

// DHL's row from the destination country ends with the destination post's tracking link in brackets:
// "… destination area. (Homepage / online shipment tracking: https://…)".
const LINK = /\s*\([^()]*https?:\/\/[^()]*\)$/;

/**
 * The key a row's `normalizeStatusWording` wording is mapped under: a flight's or a hand-over's day becomes an
 * ellipsis, and a relayed row's tracking link is left out.
 */
export const mesoGlobalScanKey = (wording: string): string => wording.replace(FLIGHT_DAY, '$1…$2').replace(HANDED_OVER_DAY, '…$1')
  .replace(LINK, '');

// DHL relays the destination post's delivery run and delivery twice: in its own words to the minute, and
// in the post's short words to the second.
const SHORT_WORDINGS: ReadonlyMap<string, string> = new Map([
  ['Item is out for delivery', 'The shipment has been loaded onto the delivery vehicle'],
  ['Item delivered', 'The shipment has been successfully delivered'],
].map(([short, long]) => [normalizeStatusWording(short!), normalizeStatusWording(long!)]));

/**
 * DHL's row from the destination country written again with another tracking link, or a scan in the
 * destination post's short words beside DHL's own wording of it: one scan.
 */
export const repeatsMesoGlobalRow = (wording: string, other: string): boolean => wording !== other
  && ((LINK.test(wording) && LINK.test(other) && wording.replace(LINK, '') === other.replace(LINK, ''))
    || SHORT_WORDINGS.get(normalizeStatusWording(wording)) === normalizeStatusWording(other));

/**
 * The stage Meso-global's map gives a row, by its whole `normalizeStatusWording`
 * wording: Meso-global's own, or the English the adapter shows for it.
 * A row's kind code, when it has one, groups many wordings and decides nothing.
 */
export function mesoGlobalStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.stage(mesoGlobalScanKey(wording));
}

/**
 * The English the adapter shows for a row Meso-global words only in Chinese, by
 * its `normalizeStatusWording` wording; a flight row's without the day it
 * expects, which is still to come, and a hand-over row's without its day.
 */
export const mesoGlobalEnglish = (_code: string | null, wording: string): string | undefined =>
  WORDINGS.english(mesoGlobalScanKey(wording));

export const statusMap: CarrierStatusMap = { stage: mesoGlobalStage, gaps: [] };
