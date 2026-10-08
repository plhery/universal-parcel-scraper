import { createHash, randomBytes } from 'node:crypto';
import { DateTime } from 'luxon';
import { CarrierError, ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult, CarrierStatus } from '../../core/result/index.js';
import type { ClassifiedStatus, Stage } from '../../core/status/index.js';
import { calendarDay, isoTime, zonedTime } from '../../core/time/index.js';
import { clean, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { xmlDocument, type XmlNode } from '../../core/transport/xml.js';

export const DPD_DE_APP_API = 'https://api.paketnavigator.de/services/v1/Navigator3Service.asmx';
/** Activity the service places outside Germany; the app tier would read the same parcel. */
export const DPD_DE_OTHER_COUNTRY = 'other_country';
/** The lookup stopped waiting for the session, which keeps opening for the next one. */
export const DPD_DE_SESSION_OPENING = 'session_opening';
const SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const SERVICE = 'https://cloud.dpd.com/';
const MAX_BYTES = 2_000_000;
/** Opening a session has taken up to 42 seconds. */
const SESSION_OPEN_MS = 75_000;
// Shared partner credentials of the public app, distributed with the maintainer's approval.
const PARTNER: DpdDePartner = { name: 'Android Paketnavigator3', token: 'A33363237662F5945576', password: '272 WetFd2mpXrgD' };

export interface DpdDePartner { name: string; token: string; password: string }

/** The app's progress rail: one coarse state for the whole parcel. */
export const DPD_DE_APP_RAIL: Readonly<Record<string, ClassifiedStatus>> = {
  ACCEPTED: { status: 'pending', stage: 'registered' },
  ON_THE_ROAD: { status: 'in_transit', stage: 'in_transit' },
  AT_DELIVERY_DEPOT: { status: 'in_transit', stage: 'in_transit' },
  OUT_FOR_DELIVERY: { status: 'out_for_delivery', stage: 'out_for_delivery' },
  DELIVERED: { status: 'delivered', stage: 'delivered' },
  // Set while the return travels and after it reaches the sender: its own scans tell them apart.
  RETURN_TO_SENDER: { status: 'exception', stage: 'exception' },
};

/**
 * Scans carry wording only. The shared classifier misreads several of these, so each is mapped
 * whole; a variable date is recorded as an ellipsis.
 */
export const DPD_DE_APP_SCANS: Readonly<Record<string, Stage>> = {
  'Order information has been transmitted to DPD.': 'registered',
  // The sender booked a collection, which has not happened yet.
  'Pickup ordered for: …': 'registered',
  'Pickup not possible No goods acceptance / goods pickup.': 'registered',
  'Parcel handed to DPD': 'accepted',
  'Parcel handed to Pickup parcelshop by consignor.': 'accepted',
  'In transit.': 'in_transit',
  'At parcel delivery centre.': 'in_transit',
  'Transfer to DPD Pickup station by DPD driver.': 'in_transit',
  'Out for delivery.': 'out_for_delivery',
  'Unfortunately we have not been able to deliver your parcel.': 'failed_attempt',
  'Back at parcel delivery centre after an unsuccessful delivery attempt.': 'failed_attempt',
  "We're sorry but your parcel couldn't be delivered as arranged.": 'exception',
  'Delivered by driver to DPD Pickup parcelshop/ station.': 'ready_for_pickup',
  'Picked up from DPD Pickup station by consignee.': 'delivered',
  'Parcel has been left in: mail box': 'delivered',
  'Delivered.': 'delivered',
  // The return's own scans: under way it stays nonterminal, then it reaches the sender.
  'At parcel delivery centre. (Return to sender)': 'exception',
  'Delivered. (Return to sender)': 'returned',
};

const scanKey = (wording: string) => wording.replace(/^(Pickup ordered for:) \d{2}\.\d{2}\.\d{4}$/, '$1 …');

function invalid(): never { throw new SchemaError('DPD Germany', 'DPD Germany returned invalid tracking XML'); }

function children(node: XmlNode, name: string, uri = SERVICE): XmlNode[] {
  return node.children.filter(child => child.name === name && child.uri === uri);
}

function one(node: XmlNode, name: string, uri = SERVICE): XmlNode {
  const matches = children(node, name, uri);
  return matches.length === 1 ? matches[0]! : invalid();
}

function scalar(node: XmlNode, name: string, max = 200): string {
  const matches = children(node, name);
  if (matches.length > 1 || matches[0]?.children.length) invalid();
  return clean(matches[0]?.text ?? '', max);
}

function optional(node: XmlNode, name: string): XmlNode | undefined {
  const matches = children(node, name);
  if (matches.length > 1) invalid();
  return matches[0];
}

const affirmative = (value: string) => value === 'true' || value === '1';
const placeholderDay = (day: string) => day === '2000-01-01' || day === '0001-01-01';

/** Validate source digits without assigning a zone to an offset-less estimate. */
function estimateClock(raw: string) {
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/.test(raw)
    || placeholderDay(raw.slice(0, 10))) return null;
  return isoTime(raw, 'UTC');
}

function estimateDay(raw: string): string | null {
  if (estimateClock(raw)) return raw.slice(0, 10);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const display = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(raw);
  const day = iso ? calendarDay(Number(iso[1]), Number(iso[2]), Number(iso[3]))
    : display ? calendarDay(Number(display[3]), Number(display[2]), Number(display[1])) : null;
  return day && !placeholderDay(day) ? day : null;
}

function announcedDay(wording: string): string | null {
  const date = /^Your parcel is estimated to be delivered on:\s*(?:[A-Za-z]+,\s*)?(\d{2}\.\d{2}\.\d{4})$/i.exec(wording)?.[1];
  return date ? estimateDay(date) : null;
}

/** Specified dates are forecasts, never scans; delivered display dates are actuals. */
function deliveryEstimate(tracking: XmlNode, announced: string | null): string | null {
  const planned = optional(tracking, 'NewDeliveryInfo');
  const day = planned && affirmative(scalar(planned, 'PlannedDeliveryDateSpecified', 8))
    ? estimateDay(scalar(planned, 'PlannedDeliveryDate', 64)) : null;
  // The app displays a changed delivery day ahead of its previous forecast.
  if (day && planned && affirmative(scalar(planned, 'DateChanged', 8))) return day;
  const live = optional(tracking, 'LiveTracking');
  if (live && affirmative(scalar(live, 'EstimatedDeliveryDateTimeSpecified', 8))) {
    const from = scalar(live, 'EstimatedDeliveryDateTimeFrom', 64);
    const to = scalar(live, 'EstimatedDeliveryDateTimeTo', 64);
    const start = estimateClock(from);
    const end = estimateClock(to);
    const hasOffset = (value: string) => /(?:Z|[+-]\d{2}:\d{2})$/.test(value);
    if (start && end && hasOffset(from) === hasOffset(to) && end.timestamp >= start.timestamp) {
      // An explicit instant can be shown on the German delivery clock. Unresolved
      // wall clocks retain their digits, without receiving an invented offset.
      const display = (raw: string, timestamp: number) => hasOffset(raw)
        ? DateTime.fromMillis(timestamp, { zone: 'Europe/Berlin' }).toFormat('yyyy-MM-dd HH:mm')
        : raw.slice(0, 16).replace('T', ' ');
      const first = display(from, start.timestamp);
      const last = display(to, end.timestamp);
      return `${first}–${first.slice(0, 10) === last.slice(0, 10) ? last.slice(11) : last}`;
    }
  }
  // DeliveryDateTime is display text and can omit the year: never invent it.
  return day ?? announced ?? estimateDay(scalar(tracking, 'DeliveryDateTime', 64));
}

const escaped = (value: string) => value.replace(/[<>&"']/g, character => `&#${character.charCodeAt(0)};`);

type Fields = { readonly [name: string]: string | Fields };
const elements = (fields: Fields): string => Object.entries(fields)
  .map(([name, value]) => `<${name}>${typeof value === 'string' ? escaped(value) : elements(value)}</${name}>`).join('');

class SessionExpired extends Error {}
class PostcodeRejected extends Error {}

/** A two-letter country, where the service puts a placeholder three-letter one for an unknown depot. */
function countryOf(node: XmlNode | undefined): string {
  const country = node ? scalar(node, 'Country', 8) : '';
  return /^[A-Z]{2}$/.test(country) ? country : '';
}

/** As on the guest API: a parcel waiting at a shop is out for delivery, and a failed attempt stays in transit. */
function statusOf(stage: string | undefined): CarrierStatus {
  if (stage === 'delivered' || stage === 'out_for_delivery' || stage === 'exception') return stage;
  if (stage === 'ready_for_pickup') return 'out_for_delivery';
  if (stage === 'returned') return 'exception';
  if (stage === 'registered') return 'pending';
  return stage ? 'in_transit' : 'unknown';
}

/** The shop a scan names, as `<PUDO id>|<shop name>` under additional code 999. */
function shopOf(row: XmlNode): { id: string; name: string } | undefined {
  for (const entry of children(row, 'TrackingScanAdditionalList').flatMap(list => children(list, 'TrackingScanAdditionalType'))) {
    const named = scalar(entry, 'AdditionalCode', 8) === '999' && /^([A-Z]{2}\d{1,12})\|(.{1,120})$/.exec(scalar(entry, 'Description', 200));
    if (named && named[2]!.trim()) return { id: named[1]!, name: named[2]!.trim() };
  }
  return undefined;
}

/** The street and town of the shop that `getParcelShopByID` returns, a line each, if it is the requested one. */
function addressOf(result: XmlNode, id: string): string {
  const shop = one(result, 'ParcelShop');
  if (scalar(shop, 'PUDOID', 40) !== id) return '';
  const address = one(shop, 'ShopAddress');
  const street = scalar(address, 'Street', 120);
  const city = scalar(address, 'City', 80);
  if (!street || !city) return '';
  return `${[street, scalar(address, 'HouseNo', 20)].filter(Boolean).join(' ')}\n${[scalar(address, 'ZipCode', 16), city].filter(Boolean).join(' ')}`;
}

/** The measured length, width and height, in millimetres; the shipper's own figures are not read. */
function dimensionsOf(order: XmlNode): string | null {
  const sides = ['Length', 'Width', 'Height'].map(name => scalar(order, name, 16));
  if (!sides.every(side => /^\d{1,5}$/.test(side) && Number(side) > 0)) return null;
  return `${sides.map(side => Number(side) / 10).join(' × ')} cm`;
}

/**
 * Scans arrive oldest first, with a facility's wall clock and no offset. `shop` is the PUDO id of
 * the shop the result names as its pickup point, else empty.
 */
export function parseDpdDeApp(data: XmlNode, scans: XmlNode, number: string): { result: CarrierResult; shop: string } {
  const tracking = one(data, 'TrackingData');
  if (scalar(tracking, 'ParcelNo', 40) !== number) throw new SchemaError('DPD Germany', 'DPD Germany returned a different parcel');
  const rows = children(one(scans, 'TrackingScanList'), 'TrackingScan');
  if (rows.length > 500) invalid();
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  let placed = '';
  let announced: string | null = null;
  let shop: ReturnType<typeof shopOf>;
  for (const row of rows) {
    const wording = scalar(row, 'StatusText', 500);
    if (!wording) invalid();
    // These rows may carry no scan clock. The date is in the announcement itself.
    if (/^Your parcel is estimated to be delivered\b/i.test(wording)) {
      announced = announcedDay(wording);
      continue;
    }
    const day = scalar(row, 'ScanDate', 16);
    const time = scalar(row, 'ScanTime', 16);
    if (!/^\d{2}\.\d{2}\.\d{4}$/.test(day) || !/^\d{2}:\d{2}$/.test(time)) invalid();
    const place = /^(.{1,120}) \(([A-Z]{2})\)$/.exec(scalar(row, 'Location'));
    if (place) placed = place[2]!;
    // German facilities keep German civil time; a clock elsewhere has no established zone.
    const clock = zonedTime(`${day} ${time}`, 'dd.MM.yyyy HH:mm', place?.[2] === 'DE' ? 'Europe/Berlin' : 'UTC');
    if (!clock) invalid();
    const key = scanKey(wording);
    const stage = Object.hasOwn(DPD_DE_APP_SCANS, key) ? DPD_DE_APP_SCANS[key] : undefined;
    if (stage === 'ready_for_pickup') shop = shopOf(row);
    const event: CarrierEvent = {
      ...(place?.[2] === 'DE' ? { time: clock.iso } : { local_time: clock.iso.slice(0, 19), provider_time_text: `${day} ${time}` }),
      ...(place ? { location: `${place[1]}, ${place[2]}` } : {}),
      description: /\b(?:delivered to|signed (?:for )?by|received by)\b/i.test(wording) ? 'Delivery update' : wording,
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    };
    // Reason codes and service descriptions are not projected.
    const identity = JSON.stringify(event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    events.push(event);
  }
  if (!events.length) throw new IndeterminateError('DPD Germany', 'DPD Germany returned no parcel scans');
  // The service also answers for parcels elsewhere in the group, and its recipient address reads
  // Germany for them too. Where the parcel is now, as the guest API's current country: the newest
  // placed scan, else the depot of the last status.
  const depot = children(tracking, 'LastStatusInfo').flatMap(info => children(info, 'DepotData')).flatMap(data => children(data, 'Address'))[0];
  const country = placed || countryOf(depot);
  if (country && country !== 'DE') {
    throw new IndeterminateError('DPD Germany', 'DPD returned activity in another country', { reason: DPD_DE_OTHER_COUNTRY });
  }
  events.reverse();
  const current = events[0]!;
  const railId = scalar(one(tracking, 'LastStatusInfo'), 'StatusID', 64);
  const rail = Object.hasOwn(DPD_DE_APP_RAIL, railId) ? DPD_DE_APP_RAIL[railId] : undefined;
  const stage = current.stage ?? rail?.stage;
  const status = rail?.status ?? statusOf(current.stage);
  const order = one(tracking, 'OrderInfo');
  const kilograms = Number(scalar(order, 'Weight', 16).replace(',', '.'));
  const dimensions = dimensionsOf(order);
  const deliveredAt = status === 'delivered' ? events.find(event => event.stage === 'delivered')?.time : undefined;
  // The shop holding the parcel, while it waits there.
  const pickup = stage === 'ready_for_pickup' ? shop : undefined;
  const result: CarrierResult = {
    status, ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: current.description ?? null, last_update: current.time ?? null,
    expected_delivery: affirmative(scalar(tracking, 'Delivered', 8)) || status === 'delivered' || status === 'exception'
      || stage === 'delivered' || stage === 'ready_for_pickup' ? null : deliveryEstimate(tracking, announced),
    ...(current.time ? {} : { last_update_local: current.local_time }),
    ...(Number.isFinite(kilograms) && kilograms > 0 ? { weight_kg: kilograms } : {}),
    ...(dimensions ? { dimensions_text: dimensions } : {}),
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    ...(pickup ? { pickup_point: pickup.name } : {}),
    events: events.slice(0, 100),
  };
  return { result, shop: pickup?.id ?? '' };
}

/**
 * The German app's SOAP service. Tracking needs an anonymous device session, which the
 * service takes tens of seconds to open and then accepts for hours: one is kept per client.
 * The opening runs on its own clock, so a lookup that stops waiting leaves it to the next.
 */
export class DpdDeAppClient {
  readonly #partner: DpdDePartner;
  readonly #fetcher?: typeof fetch;
  readonly #userAgent: string;
  readonly #now: () => number;
  readonly #device = randomBytes(8).toString('hex');
  #session = '';
  #opening: { token: Promise<string>; holders: Set<AbortSignal>; release: () => void } | null = null;

  constructor(options: { partner?: DpdDePartner; fetcher?: typeof fetch; userAgent?: string; now?: () => number } = {}) {
    this.#partner = options.partner ?? PARTNER;
    this.#fetcher = options.fetcher;
    this.#userAgent = userAgentOf(options.userAgent);
    this.#now = options.now ?? Date.now;
  }

  /**
   * `sessionWaitMs` bounds the wait for a session still opening; the whole `timeoutMs` by default.
   * DPD checks a `postcode` against the recipient's: a rejected one gets one lookup without it, and
   * the result says which, as on the guest API.
   */
  async track(number: string, options: { signal: AbortSignal; timeoutMs: number; sessionWaitMs?: number; postcode?: string }): Promise<CarrierResult> {
    if (!/^\d{14}$/.test(number)) throw new TypeError('DPD Germany app tracking takes 14 digits');
    const postcode = options.postcode ?? '';
    if (postcode && !/^\d{5}$/.test(postcode)) throw new TypeError('DPD Germany app tracking takes a 5-digit postcode');
    const deadline = performance.now() + options.timeoutMs;
    const left = () => Math.max(1, Math.floor(deadline - performance.now()));
    try {
      for (let attempt = 0; ; attempt += 1) {
        const session = await this.session(options.signal, Math.min(left(), options.sessionWaitMs ?? Infinity));
        // Read-only: the parcel is neither added to the session nor redirected.
        const tracking = (zip: string) => this.call('getTrackingData', { SessionToken: session, ParcelNo: number, DeliveryZipCode: zip,
          UpdateNewDeliveryData: 'false', addParcelIfNoTrackingdataAvailable: 'false', ParcelFlowTypeID: 'receiving' }, options.signal, left());
        try {
          let data: XmlNode;
          let verified: boolean | undefined;
          try {
            data = await tracking(postcode);
            if (postcode) verified = ['DeliveryZipCode_isValid', 'Owner'].includes(scalar(one(data, 'TrackingData'), 'DataViewStatus', 40));
          } catch (error) {
            // Also the answer for an unknown parcel, which the lookup without it then reports.
            if (!(error instanceof PostcodeRejected)) throw error;
            data = await tracking('');
            verified = false;
          }
          const scans = await this.call('getTrackingScanList', { SessionToken: session, ParcelNo: number,
            DeliveryZipCode: verified ? postcode : '' }, options.signal, left());
          const { result, shop } = parseDpdDeApp(data, scans, number);
          // The scans name the shop without its address, which the shop's own record adds.
          if (shop) {
            const address = await this.shopAddress(session, shop, options.signal, left());
            if (address) result.pickup_point = `${result.pickup_point}\n${address}`;
          }
          if (verified !== undefined) result.dpd_postcode_verified = verified;
          return result;
        } catch (error) {
          if (!(error instanceof SessionExpired) || attempt) throw error;
          if (this.#session === session) this.#session = '';
        }
      }
    } catch (error) {
      options.signal.throwIfAborted();
      // Transport diagnostics include the credentials, the session and recipient XML.
      // Preserve the failure contract without forwarding request or body data.
      if (error instanceof CarrierError) throw new CarrierError(error.kind, 'DPD Germany', `DPD Germany app tracking failed (${error.kind})`, {
        status: error.status, retryAfterMs: error.retryAfterMs, reason: error.reason,
      });
      throw new TransportError('DPD Germany', 'DPD Germany app request failed');
    }
  }

  /** The shop's street and town, or nothing: the parcel is found, and its pickup point keeps its name without them. */
  private async shopAddress(session: string, id: string, signal: AbortSignal, timeoutMs: number): Promise<string> {
    try {
      return addressOf(await this.call('getParcelShopByID', { SessionToken: session, ParcelShopID: '0', PudoID: id,
        ParcelShopOnly: 'false' }, signal, timeoutMs), id);
    } catch {
      signal.throwIfAborted();
      return '';
    }
  }

  /**
   * One session for every lookup. The opening runs while a lookup that asked for it is still
   * running, even one that stopped waiting; each lookup waits until its signal or `waitMs` ends.
   */
  private async session(signal: AbortSignal, waitMs: number): Promise<string> {
    if (this.#session) return this.#session;
    signal.throwIfAborted();
    if (!this.#opening) {
      const controller = new AbortController();
      const holders = new Set<AbortSignal>();
      const token = this.call('getSessionFullState', { SessionToken: '', DeviceData: {
        HardwareID: this.#device, BootSystemID: 'Android_Phone', Version: '15', AppVersion: '4.2.0',
      } }, controller.signal, SESSION_OPEN_MS).then(result => {
        const value = scalar(one(result, 'SessionFullState'), 'SessionToken', 600);
        if (!/^[A-Za-z0-9+/=]{16,512}$/.test(value)) invalid();
        return this.#session = value;
      });
      const release = () => {
        for (const holder of holders) if (holder.aborted) holders.delete(holder);
        if (!holders.size) controller.abort(new Error('No lookup is waiting for the DPD Germany session'));
      };
      const opening = { token, holders, release };
      this.#opening = opening;
      void token.catch(() => undefined).finally(() => {
        if (this.#opening === opening) this.#opening = null;
        for (const holder of holders) holder.removeEventListener('abort', release);
      });
    }
    const { token, holders, release } = this.#opening;
    if (!holders.has(signal)) {
      holders.add(signal);
      signal.addEventListener('abort', release, { once: true });
    }
    let leave!: () => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const left = new Promise<never>((_resolve, reject) => {
      leave = () => reject(signal.reason as Error);
      timer = setTimeout(() => reject(new IndeterminateError('DPD Germany', 'DPD Germany app session is still opening', {
        reason: DPD_DE_SESSION_OPENING,
      })), Math.max(0, Math.min(waitMs, SESSION_OPEN_MS)));
    });
    signal.addEventListener('abort', leave, { once: true });
    try { return await Promise.race([token, left]); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', leave); }
  }

  private async call(operation: string, fields: Fields, signal: AbortSignal, timeoutMs: number): Promise<XmlNode> {
    // The service checks a key derived from the minute of the UTC day.
    const now = new Date(this.#now());
    const phase = String((now.getUTCHours() * 60 + now.getUTCMinutes() + 1000) * 3);
    const key = phase + createHash('md5').update(`${phase}${this.#partner.name}0${operation}${this.#partner.password}`).digest('base64').slice(0, 16);
    const body = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="${SOAP}"><soap:Body><${operation} xmlns="${SERVICE}"><${operation}Request>${elements({
      Version: '100', Language: 'de_EN', PartnerCredentials: { Name: this.#partner.name, Token: this.#partner.token, KeyPhase: key }, ...fields,
    })}</${operation}Request></${operation}></soap:Body></soap:Envelope>`;
    const { response, bytes } = await fetchBounded(DPD_DE_APP_API, { method: 'POST', signal, body,
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${SERVICE}${operation}"`, Accept: 'text/xml', 'User-Agent': this.#userAgent } }, {
      provider: 'DPD Germany', maxBytes: MAX_BYTES, timeoutMs, fetcher: this.#fetcher, allowHttpStatuses: [404, 410],
    });
    if (response.status !== 200) throw new TransportError('DPD Germany', 'DPD Germany app service is unavailable', { status: response.status });
    const root = xmlDocument(decodeText(bytes), MAX_BYTES) ?? invalid();
    if (root.name !== 'Envelope' || root.uri !== SOAP) invalid();
    const result = one(one(one(root, 'Body', SOAP), `${operation}Response`), `${operation}Result`);
    const codes = children(result, 'ErrorDataList').flatMap(list => children(list, 'ErrorData')).map(error => scalar(error, 'ErrorCode', 80));
    if (codes.some(code => code === 'ERROR_PARTNER' || code === 'ERROR_KEYPHASE')) {
      throw new ChallengeError('DPD Germany', 'DPD Germany refused the app credential');
    }
    if (codes.includes('ERROR_SESSION_NOT_VALID')) throw new SessionExpired();
    if (codes.includes('ERROR_TRACKING_DELIVERYZIPCODE_NOT_VALID')) throw new PostcodeRejected();
    // "No tracking data" also answers for parcels the scan list still knows: it proves no absence.
    if (scalar(result, 'Ack', 8) !== 'true') throw new IndeterminateError('DPD Germany', 'DPD Germany returned no confirmed parcel');
    return result;
  }
}
