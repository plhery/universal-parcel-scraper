import type { Stage } from '../../core/status/index.js';
import { statusWordings } from '../../core/status/english.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { countryCode } from '../../core/time/index.js';
import { isJtMexicoRow, jtMexicoKey } from '../gzyl/jt-mexico-rows.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = statusWordings(statuses.entries);
// The airport row names the day of the booked flight in both halves.
const FLIGHT_DAY = /^(货物已交机场,预计)\d{1,2}(号的航班 goods delivered to airport, scheduled on flight of the )\d{1,2}(?:st|nd|rd|th)$/;
// Its later wording waits for that flight: "等待23号的航班起飞 … pending departure on the flight on the 23rd.", also without 的.
const AWAITED_FLIGHT_DAY = /^(货物已交机场,等待)\d{1,2}(号的?航班起飞 goods have been delivered to the airport, pending departure on the flight on the )\d{1,2}(?:st|nd|rd|th)\.?$/;

// So does the export clearance row, in both halves: "等待27号航班起飞 … on flight of the 27th".
const CLEARED_FLIGHT_DAY = /^(报关已放行等待)\d{1,2}(号航班起飞 customs released,awaiting departure on flight of the )\d{1,2}(?:st|nd|rd|th)$/;

// The English row of a booked flight names its day, sometimes with a question mark for the space ("November?3").
const TAKE_OFF_DAY = /^(flight is expected to take off on )[a-z]+[ ?]{1,2}\d{1,2}$/;

// The newer English rows name the flight's days as month.day: "expected to depart on 10.27 and land on 10.27",
// and so does a delayed connecting flight: "Sorry, the second flight has been delayed and is expected to 11.12 land".
const FLIGHT_DATES = /^(the flight is expected to depart on )\d{1,2}\.\d{1,2}( and land on )\d{1,2}\.\d{1,2}$/;
// It can name the departure day alone: "The flight is expected to depart on 11.17".
const DEPARTURE_DATE = /^(the flight is expected to depart on )\d{1,2}\.\d{1,2}$/;
const LANDING_DATE = /^(the flight has departed and is expected to |sorry, the second flight has been delayed and is expected to )\d{1,2}\.\d{1,2}( land)$/;

// On the line into the United States JRT books the flight by its month and day alone: "10/22号航班".
const BOOKED_FLIGHT = /^\d{1,2}\/\d{1,2}(号航班)$/;
// So do its rows at the port of departure, the day with its year, "货物到达口岸，预计2026/11/17号航班起飞",
// or as month.day, "预计11.11号航班飞".
const PORT_FLIGHT_DAY = /^货物到达口岸[，,] ?预计(?:\d{4}\/)?\d{1,2}\/\d{1,2}号航班起飞$/;
const EXPECTED_FLIGHT_DAY = /^(预计)\d{1,2}[./]\d{1,2}(号航班飞)$/;

// The English rows of a booked flight name its departure and arrival days: "Estimated departure is October 23th".
const ESTIMATED_DAY = /^(estimated (?:departure|arrival date) is )[a-z]+ \d{1,2}(?:st|nd|rd|th)$/;

// The bilingual row of a booked flight names its day in both halves: "预计10.29航班/Flight scheduled for October 29th",
// or "预计11.21航班/Scheduled flight on November 21st".
const SCHEDULED_FLIGHT = /^(预计)\d{1,2}\.\d{1,2}(航班\/(?:flight scheduled for|scheduled flight on) )[a-z]+ \d{1,2}(?:st|nd|rd|th)$/;
// So does the row of the flight the parcel is loaded for, the day as month and day: "预计配载航班11月11日,Expected flight on November 11th".
const LOADED_FLIGHT = /^(预计配载航班)\d{1,2}月\d{1,2}日[,，] ?(expected flight on )[a-z]+ \d{1,2}(?:st|nd|rd|th)$/;
// Its English half also comes alone, the month cut short: "Expected flight on Nov. 20th".
const EXPECTED_FLIGHT = /^(expected flight on )[a-z]{3,9}\.? ?\d{1,2}(?:st|nd|rd|th)$/;
// Another wording of it names the day as month-day, then by the month's name, the outer bracket left open:
// "预计配载11-26航班（Estimated flight departure time (ETD:November 26)".
const ETD_FLIGHT = /^预计配载\d{1,2}-\d{1,2}航班[（(] ?estimated flight departure time \(etd: ?[a-z]{3,9}\.? ?\d{1,2}(?:st|nd|rd|th)?\)[）)]?$/;
// The destination's customs release names the day of the expected hand-over to the warehouse: "已清关放行，预计11/27号交仓".
const RELEASED_HANDOVER_DAY = /^已清关放行[，,] ?预计(?:\d{4}\/)?\d{1,2}[./]\d{1,2}号交仓$/;
// On the line into Canada the hand-over to the delivering courier names it: "Your package has been handed over to the courier Example".
const HANDED_TO_COURIER = /^(your package has been handed over to the courier )\S.*$/;
// DHL's record of the recipient's choice of another address names it: "The recipient has selected a new one-time delivery address: …".
const NEW_ADDRESS = /^(the recipient has selected a new one-time delivery address: )\S.*$/;
// USPS's round on the line into the United States names its delivery window: "Out for Delivery, Expected Delivery by 9:00pm".
const DELIVERY_WINDOW = /^(out for delivery, expected delivery )(?:by \d{1,2}:\d{2} ?[ap]m|between \d{1,2}:\d{2} ?[ap]m and \d{1,2}:\d{2} ?[ap]m)$/;

// On the line into Mexico the booked flight is in Spanish, naming the destination and the day:
// "Se espera que el vuelo salga hacia México el 3 de noviembre". The flight then names the destination.
const SPANISH_FLIGHT = /^(se espera que el vuelo salga hacia )[^\d…]{1,40}?( el )\d{1,2} de [a-z]+$/;
const FLIGHT_EN_ROUTE = /^(the flight is en route to the airport in )[^\d…]{1,40}$/;
// The parcel on its way to the destination: "During transportation to Spain".
const TRANSPORTED_TO = /^(during transportation to )[^\d…]{1,40}$/;

// A delayed flight names its new day in both halves: "航班延误，预计11/1号飞出 Flight delayed, estimated departure on Nov 1.",
// sometimes with the month's full stop for the space ("Oct.24.").
const DELAYED_FLIGHT = /^(航班延误[，,] ?预计)\d{1,2}\/\d{1,2}(号飞出 flight delayed, estimated departure on )[a-z]{3,9}(?:\. ?| )\d{1,2}(?:st|nd|rd|th)?\.?$/;

/** Whether a row is one J&T Express Mexico wrote that the tracker copies, on J&T's clock in Mexico. */
export const isJrtJtMexicoRow = isJtMexicoRow;

/** The key a row's `normalizeStatusWording` wording is mapped under: a booked flight's day becomes an ellipsis. */
export const jrtScanKey = (wording: string): string => jtMexicoKey(wording).replace(FLIGHT_DAY, '$1…$2…').replace(AWAITED_FLIGHT_DAY, '$1…$2…')
  .replace(CLEARED_FLIGHT_DAY, '$1…$2…').replace(TAKE_OFF_DAY, '$1…')
  .replace(FLIGHT_DATES, '$1…$2…').replace(DEPARTURE_DATE, '$1…').replace(LANDING_DATE, '$1…$2').replace(BOOKED_FLIGHT, '…$1').replace(ESTIMATED_DAY, '$1…')
  .replace(PORT_FLIGHT_DAY, '货物到达口岸，预计…号航班起飞').replace(EXPECTED_FLIGHT_DAY, '$1…$2')
  .replace(SCHEDULED_FLIGHT, '$1…$2…').replace(LOADED_FLIGHT, '$1…月…日,$2…').replace(EXPECTED_FLIGHT, '$1…').replace(HANDED_TO_COURIER, '$1…').replace(NEW_ADDRESS, '$1…').replace(DELIVERY_WINDOW, '$1…').replace(SPANISH_FLIGHT, '$1…$2…').replace(FLIGHT_EN_ROUTE, '$1…')
  .replace(TRANSPORTED_TO, '$1…').replace(DELAYED_FLIGHT, '$1…$2…')
  .replace(ETD_FLIGHT, '预计配载…航班（estimated flight departure time (etd:…)').replace(RELEASED_HANDOVER_DAY, '已清关放行，预计…号交仓');

// USPS's status followed by its sentence, which names the time, day and town: "Departed Shipping Partner Facility -> Your
// item departed a shipping partner facility at … in …". The status before the arrow takes its own entry, keyed as it is alone.
const USPS_SENTENCE = /^([^>]{1,80}?) -> your item\b/;
const uspsSentenceStage = (key: string): Stage | undefined => {
  const status = USPS_SENTENCE.exec(key)?.[1];
  return status ? WORDINGS.stage(jrtScanKey(status)) : undefined;
};

/**
 * The stage JRT's map gives a row, by its whole `normalizeStatusWording` wording:
 * JRT's own, or the English the adapter shows for it.
 * A row's kind code, when it has one, groups many wordings and decides nothing.
 */
export function jrtStage(_code: string | null, wording: string): Stage | undefined {
  const key = jrtScanKey(wording);
  return WORDINGS.stage(key) ?? uspsSentenceStage(key);
}

/**
 * The English the adapter shows, by a row's `normalizeStatusWording` wording,
 * for a row JRT words only in Chinese, and for the airport row without the
 * flight it books, which is still to come.
 */
export const jrtEnglish = (_code: string | null, wording: string): string | undefined => WORDINGS.english(jrtScanKey(wording));

// UPS's rows, which the tracker copies in Chinese on UPS's wall clock on the lines UPS delivers: its label, its note
// that the parcel goes to an access point, its scans and its delivery.
const UPS_ROWS = new Set(['发件人已创建标签，但是 UPS 尚未收到包裹。', '等待递送至 UPS Access Point? 地点。', '抵达设施', '离开设施', '已提取',
  'UPS 设施处理', '已装上递送车辆', '准备今天递送', '已递送'].map(normalizeStatusWording));

/** Whether a row is one UPS wrote, by its wording or its place in the United States: it is on UPS's wall clock. */
export const isJrtUpsRow = (wording: string, place: string): boolean =>
  UPS_ROWS.has(normalizeStatusWording(wording)) || /(?:^|,)\s*US$/.test(place.trim());

// DHL's English sentences, as the tracker copies them on the line into Europe: "The shipment has arrived at the parcel center.",
// the recipient's preferred location for its delivery, a round that found no one, or no such recipient, at the address,
// and the recipient's choice of another address.
const DHL_SENTENCE = /^the (?:international )?shipment\b|^the instruction data for this shipment\b|^a preferred location was designated as a reception option for this shipment\b|^the recipient (?:was not present|could not be found|has selected)\b/i;

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

/**
 * Whether a row, by its `normalizeStatusWording` wording, is one the map lists without a stage: a flight booked,
 * expected or delayed, before it flies. A forecast, not a movement, so it keeps the stage of the scan before it.
 */
export const isJrtFlightNotice = (wording: string): boolean => WORDINGS.unstaged(jrtScanKey(wording));

const FLIGHT_NOTE = 'A flight booked, expected or delayed, before it flies: a forecast, so the parcel keeps the stage of the scan before it.';

export const statusMap: CarrierStatusMap = { stage: jrtStage, gaps: [],
  gapNote: (_code, wording) => (isJrtFlightNotice(wording) ? FLIGHT_NOTE : undefined) };

/** A country's code the tracker writes in lower case beside DHL's rows ("de"), as other places name a country: "DE". */
export const jrtCountryPlace = (location: string): string =>
  /^[a-z]{2}$/.test(location.trim()) && countryCode(location) ? location.trim().toUpperCase() : location;
