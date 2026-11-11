import type { Stage } from '../../core/status/index.js';
import { statusWordings } from '../../core/status/english.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { countryCode } from '../../core/time/index.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = statusWordings(statuses.entries);
// The airport row names the day of the booked flight in both halves.
const FLIGHT_DAY = /^(货物已交机场,预计)\d{1,2}(号的航班 goods delivered to airport, scheduled on flight of the )\d{1,2}(?:st|nd|rd|th)$/;
// Its later wording waits for that flight: "等待23号的航班起飞 … pending departure on the flight on the 23rd.".
const AWAITED_FLIGHT_DAY = /^(货物已交机场,等待)\d{1,2}(号的航班起飞 goods have been delivered to the airport, pending departure on the flight on the )\d{1,2}(?:st|nd|rd|th)\.?$/;

// So does the export clearance row, in both halves: "等待27号航班起飞 … on flight of the 27th".
const CLEARED_FLIGHT_DAY = /^(报关已放行等待)\d{1,2}(号航班起飞 customs released,awaiting departure on flight of the )\d{1,2}(?:st|nd|rd|th)$/;

// The English row of a booked flight names its day, sometimes with a question mark for the space ("November?3").
const TAKE_OFF_DAY = /^(flight is expected to take off on )[a-z]+[ ?]{1,2}\d{1,2}$/;

// The newer English rows name the flight's days as month.day: "expected to depart on 10.27 and land on 10.27".
const FLIGHT_DATES = /^(the flight is expected to depart on )\d{1,2}\.\d{1,2}( and land on )\d{1,2}\.\d{1,2}$/;
const LANDING_DATE = /^(the flight has departed and is expected to )\d{1,2}\.\d{1,2}( land)$/;

// On the line into the United States JRT books the flight by its month and day alone: "10/22号航班".
const BOOKED_FLIGHT = /^\d{1,2}\/\d{1,2}(号航班)$/;

// The English rows of a booked flight name its departure and arrival days: "Estimated departure is October 23th".
const ESTIMATED_DAY = /^(estimated (?:departure|arrival date) is )[a-z]+ \d{1,2}(?:st|nd|rd|th)$/;

// The bilingual row of a booked flight names its day in both halves: "预计10.29航班/Flight scheduled for October 29th".
const SCHEDULED_FLIGHT = /^(预计)\d{1,2}\.\d{1,2}(航班\/flight scheduled for )[a-z]+ \d{1,2}(?:st|nd|rd|th)$/;

// On the line into Mexico the booked flight is in Spanish, naming the destination and the day:
// "Se espera que el vuelo salga hacia México el 3 de noviembre". The flight then names the destination.
const SPANISH_FLIGHT = /^(se espera que el vuelo salga hacia )[^\d…]{1,40}?( el )\d{1,2} de [a-z]+$/;
const FLIGHT_EN_ROUTE = /^(the flight is en route to the airport in )[^\d…]{1,40}$/;

// A delayed flight names its new day in both halves: "航班延误，预计11/1号飞出 Flight delayed, estimated departure on Nov 1.",
// sometimes with the month's full stop for the space ("Oct.24.").
const DELAYED_FLIGHT = /^(航班延误[，,] ?预计)\d{1,2}\/\d{1,2}(号飞出 flight delayed, estimated departure on )[a-z]{3,9}(?:\. ?| )\d{1,2}(?:st|nd|rd|th)?\.?$/;

// J&T Express Mexico's rows, which the tracker copies on the line into Mexico: its sentence after the town and
// the site in brackets, "【Town】Tu envío ha salido de【SITE.pdv】con destino a【MEXICO.sc】".
const JT_MEXICO_ROW = /【[^【】]{1,80}】\s*(?:【[^【】]{1,80}】\s*)?(?:tu envío\b|[¡?]?recolección exitosa\b|el mensajero de j&t\b)/i;
const BRACKETED = /【[^【】]{1,80}】/g;
// Its collection names the courier and J&T's phone, and the platform's GBK turns its "¡" into "?".
const JT_MEXICO_COLLECTION = /^((?:【…】){1,2})[¡?]?(recolección exitosa!\. el mensajero de j&t asignado )\S.*?( recolectó tu envío\.).*$/;

/** Whether a row is one J&T Express Mexico wrote that the tracker copies, on J&T's clock in Mexico. */
export const isJrtJtMexicoRow = (wording: string): boolean => JT_MEXICO_ROW.test(wording);

/** A J&T Express Mexico row's key: its towns and sites, and the courier and phone of its collection, as ellipses. */
const jtMexicoKey = (wording: string): string => (JT_MEXICO_ROW.test(wording)
  ? wording.replace(BRACKETED, '【…】').replace(JT_MEXICO_COLLECTION, '$1¡$2…$3') : wording);

/** The key a row's `normalizeStatusWording` wording is mapped under: a booked flight's day becomes an ellipsis. */
export const jrtScanKey = (wording: string): string => jtMexicoKey(wording).replace(FLIGHT_DAY, '$1…$2…').replace(AWAITED_FLIGHT_DAY, '$1…$2…')
  .replace(CLEARED_FLIGHT_DAY, '$1…$2…').replace(TAKE_OFF_DAY, '$1…')
  .replace(FLIGHT_DATES, '$1…$2…').replace(LANDING_DATE, '$1…$2').replace(BOOKED_FLIGHT, '…$1').replace(ESTIMATED_DAY, '$1…')
  .replace(SCHEDULED_FLIGHT, '$1…$2…').replace(SPANISH_FLIGHT, '$1…$2…').replace(FLIGHT_EN_ROUTE, '$1…')
  .replace(DELAYED_FLIGHT, '$1…$2…');

/**
 * The stage JRT's map gives a row, by its whole `normalizeStatusWording` wording:
 * JRT's own, or the English the adapter shows for it.
 * A row's kind code, when it has one, groups many wordings and decides nothing.
 */
export function jrtStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.stage(jrtScanKey(wording));
}

/**
 * The English the adapter shows, by a row's `normalizeStatusWording` wording,
 * for a row JRT words only in Chinese, and for the airport row without the
 * flight it books, which is still to come.
 */
export const jrtEnglish = (_code: string | null, wording: string): string | undefined => WORDINGS.english(jrtScanKey(wording));

// UPS's rows, which the tracker copies in Chinese on UPS's wall clock on the line into the United States.
const UPS_ROWS = new Set(['发件人已创建标签，但是 UPS 尚未收到包裹。', '抵达设施', '离开设施', '已提取', 'UPS 设施处理', '已装上递送车辆',
  '准备今天递送', '已递送'].map(normalizeStatusWording));

/** Whether a row is one UPS wrote, by its wording or its place in the United States: it is on UPS's wall clock. */
export const isJrtUpsRow = (wording: string, place: string): boolean =>
  UPS_ROWS.has(normalizeStatusWording(wording)) || /(?:^|,)\s*US$/.test(place.trim());

// DHL's English sentences, as the tracker copies them on the line into Europe: "The shipment has arrived at the parcel center."
const DHL_SENTENCE = /^the (?:international )?shipment\b|^the instruction data for this shipment\b/i;
// DHL's rows from Germany, before the parcel leaves for the destination country: the sender's data, the transport to
// DHL, the parcel centre of origin, the export parcel centre and the transport abroad.
const DHL_GERMAN_ROW = /^the instruction data\b|\b(?:in transit to dhl|of origin|export parcel center|transported to the destination country)\b/i;

// DHL's own event texts, in lower case, as the tracker copies them: "loaded to movement / tour vehicle", and
// its sentences shortened, as "shipment in transit to dhl".
const DHL_EVENT = /^(?:(?:un)?loaded (?:to|from) movement \/ tour vehicle|movement \/ tour vehicle arrived|pick-up was successful|sorted$|not delivered-(?:consignee|bad address)\b|held for consignee collection|shipment will be returned to origin\b|shipment in transit to dhl$)/i;

/**
 * Whether a row is one DHL wrote that the tracker copies, on DHL's wall clock where it scanned the parcel: its
 * sentences, to the minute and without a place, and its event texts and sentences with a town or a country's code.
 */
export const isJrtDhlRow = (wording: string): boolean => DHL_SENTENCE.test(wording.trim()) || DHL_EVENT.test(wording.trim());

/** Whether a DHL row is one from Germany, before the parcel leaves for the destination country. */
export const isJrtDhlGermanRow = (wording: string): boolean => DHL_GERMAN_ROW.test(wording);

export const statusMap: CarrierStatusMap = { stage: jrtStage, gaps: [] };

/** A country's code the tracker writes in lower case beside DHL's rows ("de"), as other places name a country: "DE". */
export const jrtCountryPlace = (location: string): string =>
  /^[a-z]{2}$/.test(location.trim()) && countryCode(location) ? location.trim().toUpperCase() : location;
