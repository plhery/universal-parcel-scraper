import type { Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { jtMexicoKey } from '../gzyl/jt-mexico-rows.js';
import statuses from './statuses.json' with { type: 'json' };

export const ENTRIES: readonly { readonly wording: string; readonly stage: string }[] = statuses.entries;
// The flight row names the day it is due to land: "航班起飞，预计航班落地时间(10.22)".
const LANDING_DAY = /^(航班起飞[，,] ?预计航班落地时间[(（])\d{1,2}[./]\d{1,2}([)）])$/;
// The page writes some accented letters as "?": "Din leverans ?r bokad med Early Bird.".
const ACCENTED = /[\u00C0-\u024F]/g;

/**
 * The key a row's `normalizeStatusWording` wording is mapped under: the flight's landing day becomes an ellipsis,
 * J&T Express Mexico's towns, sites, courier and phone too, and an accented Latin letter the "?" the page can
 * write in its place, so either spelling finds the row.
 */
export const huayaScanKey = (wording: string): string => jtMexicoKey(wording).replace(LANDING_DAY, '$1…$2').replace(ACCENTED, '?');

const WORDINGS = new Map<string, Stage>(ENTRIES.map((entry) => [huayaScanKey(normalizeStatusWording(entry.wording)), entry.stage as Stage]));

/**
 * The stage Huaya Express's map gives a row, by its `normalizeStatusWording` wording.
 * A row's kind code, when it has one, groups many wordings and decides nothing.
 */
export function huayaStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.get(huayaScanKey(wording));
}

// DHL's sentences the tracker copies on the line into Germany, on DHL's wall clock where it scanned the parcel.
const DHL_SENTENCE = /^(?:the (?:international )?shipment\b|the instruction data for this shipment\b|unfortunately\b|the recipient could not be found\b)/i;
// DHL's rows from Germany before the parcel leaves for the destination country, and the shipment announced to it.
const DHL_GERMAN_ROW = /^the instruction data\b|\b(?:of origin|export parcel center|transported to the destination country|in transit to dhl)\b/i;

/** Whether a row is one the tracker copies from DHL, on DHL's wall clock. */
export const isHuayaDhlRow = (wording: string): boolean => DHL_SENTENCE.test(wording.trim());
/** Whether a DHL row is one from Germany, before the parcel leaves for the destination country. */
export const isHuayaDhlGermanRow = (wording: string): boolean => DHL_GERMAN_ROW.test(wording);

// The US delivery partner's rows name the country, the town and the partner's facility: "US, BENSENVILLE, ORD HUB".
// The destination carrier's label row at "US, SYSTEM, SYSTEM" names no town.
const US_PLACE = /^\s*US\s*,(?!\s*SYSTEM\s*,)[^,]*[A-Z][^,]*,/i;
/** Whether a row is the US delivery partner's, at a town in the United States, on that town's wall clock. */
export const isHuayaUsRow = (place: string): boolean => US_PLACE.test(place);

// The destination's carrier's rows the tracker copies under the country's code alone ("FR"), in its language: Colissimo's,
// PostNL's, Early Bird's. The tracker's own steps abroad under such a code are in Chinese ("航班落地，清关中" at "DE").
const COUNTRY_PLACE = /^\s*([A-Z]{2})\s*$/;
const HAN = /\p{Script=Han}/u;
/** Whether a row is the destination carrier's under a country's code other than China's, on that country's wall clock. */
export const isHuayaDestinationRow = (content: string, place: string): boolean => {
  const country = COUNTRY_PLACE.exec(place)?.[1];
  return country !== undefined && country !== 'CN' && countryCode(country) === country && !HAN.test(content);
};

// The Italian last mile's rows the tracker copies under the town and its province's code, as Poste Italiane writes
// them: "ROMA (RM)", "BENTIVOGLIO (BO)".
const PROVINCE_PLACE = /^\s*[A-Z][A-Z' .-]{0,60}\(([A-Z]{2})\)\s*$/;
const ITALIAN_PROVINCES = new Set(('AG AL AN AO AP AQ AR AT AV BA BG BI BL BN BO BR BS BT BZ CA CB CE CH CI CL CN CO CR CS CT CZ '
  + 'EN FC FE FG FI FM FR GE GO GR IM IS KR LC LE LI LO LT LU MB MC ME MI MN MO MS MT NA NO NU OG OR OT PA PC PD PE PG PI '
  + 'PN PO PR PT PU PV PZ RA RC RE RG RI RM RN RO SA SI SO SP SR SS SU SV TA TE TN TO TP TR TS TV UD VA VB VC VE VI VR VS '
  + 'VT VV').split(' '));
/** Whether a row is placed at a town and an Italian province's code, as the Italian last mile's rows are, outside the tracker's Chinese steps. */
export const isHuayaItalianRow = (content: string, place: string): boolean => {
  const province = PROVINCE_PLACE.exec(place)?.[1];
  return province !== undefined && ITALIAN_PROVINCES.has(province) && !HAN.test(content);
};

export const statusMap: CarrierStatusMap = { stage: huayaStage, gaps: [] };
