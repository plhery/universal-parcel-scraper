import { createHash, randomBytes } from 'node:crypto';
import { CarrierError, ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult, CarrierStatus } from '../../core/result/index.js';
import type { ClassifiedStatus, Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { xmlDocument, type XmlNode } from '../../core/transport/xml.js';

export const DPD_DE_APP_API = 'https://api.paketnavigator.de/services/v1/Navigator3Service.asmx';
/** Activity the service places outside Germany; the app tier would read the same parcel. */
export const DPD_DE_OTHER_COUNTRY = 'other_country';
const SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const SERVICE = 'https://cloud.dpd.com/';
const MAX_BYTES = 2_000_000;
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
};

/** Scans carry wording only. The shared classifier misreads several of these, so each is mapped whole. */
export const DPD_DE_APP_SCANS: Readonly<Record<string, Stage>> = {
  'Order information has been transmitted to DPD.': 'registered',
  'Parcel handed to Pickup parcelshop by consignor.': 'accepted',
  'In transit.': 'in_transit',
  'At parcel delivery centre.': 'in_transit',
  'Transfer to DPD Pickup station by DPD driver.': 'in_transit',
  'Out for delivery.': 'out_for_delivery',
  'Unfortunately we have not been able to deliver your parcel.': 'failed_attempt',
  "We're sorry but your parcel couldn't be delivered as arranged.": 'exception',
  'Delivered by driver to DPD Pickup parcelshop/ station.': 'ready_for_pickup',
  'Picked up from DPD Pickup station by consignee.': 'delivered',
  'Delivered.': 'delivered',
};

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

const escaped = (value: string) => value.replace(/[<>&"']/g, character => `&#${character.charCodeAt(0)};`);

type Fields = { readonly [name: string]: string | Fields };
const elements = (fields: Fields): string => Object.entries(fields)
  .map(([name, value]) => `<${name}>${typeof value === 'string' ? escaped(value) : elements(value)}</${name}>`).join('');

class SessionExpired extends Error {}

function statusOf(stage: string | undefined): CarrierStatus {
  if (stage === 'delivered' || stage === 'out_for_delivery' || stage === 'exception') return stage;
  if (stage === 'registered') return 'pending';
  return stage ? 'in_transit' : 'unknown';
}

/** Scans arrive oldest first, with a facility's wall clock and no offset. */
export function parseDpdDeApp(data: XmlNode, scans: XmlNode, number: string): CarrierResult {
  const tracking = one(data, 'TrackingData');
  if (scalar(tracking, 'ParcelNo', 40) !== number) throw new SchemaError('DPD Germany', 'DPD Germany returned a different parcel');
  // The service also answers for parcels delivered elsewhere in the group.
  const destination = scalar(one(tracking, 'ShipAddress'), 'Country', 8);
  if (/^[A-Z]{2}$/.test(destination) && destination !== 'DE') {
    throw new IndeterminateError('DPD Germany', 'DPD returned activity in another country', { reason: DPD_DE_OTHER_COUNTRY });
  }
  const rows = children(one(scans, 'TrackingScanList'), 'TrackingScan');
  if (rows.length > 500) invalid();
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const wording = scalar(row, 'StatusText', 500);
    const day = scalar(row, 'ScanDate', 16);
    const time = scalar(row, 'ScanTime', 16);
    if (!wording || !/^\d{2}\.\d{2}\.\d{4}$/.test(day) || !/^\d{2}:\d{2}$/.test(time)) invalid();
    // An announced delivery day is not a scan.
    if (/^Your parcel is estimated to be delivered\b/i.test(wording)) continue;
    const place = /^(.{1,120}) \(([A-Z]{2})\)$/.exec(scalar(row, 'Location'));
    // German facilities keep German civil time; a clock elsewhere has no established zone.
    const clock = zonedTime(`${day} ${time}`, 'dd.MM.yyyy HH:mm', place?.[2] === 'DE' ? 'Europe/Berlin' : 'UTC');
    if (!clock) invalid();
    const stage = DPD_DE_APP_SCANS[wording];
    const event: CarrierEvent = {
      ...(place?.[2] === 'DE' ? { time: clock.iso } : { local_time: clock.iso.slice(0, 19), provider_time_text: `${day} ${time}` }),
      ...(place ? { location: `${place[1]}, ${place[2]}` } : {}),
      description: /\b(?:delivered to|signed (?:for )?by|received by)\b/i.test(wording) ? 'Delivery update' : wording,
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    };
    // Reason codes, shop names and service descriptions are not projected.
    const identity = JSON.stringify(event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    events.push(event);
  }
  if (!events.length) throw new IndeterminateError('DPD Germany', 'DPD Germany returned no parcel scans');
  events.reverse();
  const current = events[0]!;
  const rail = DPD_DE_APP_RAIL[scalar(one(tracking, 'LastStatusInfo'), 'StatusID', 64)];
  const stage = current.stage ?? rail?.stage;
  const kilograms = Number(scalar(one(tracking, 'OrderInfo'), 'Weight', 16).replace(',', '.'));
  return {
    status: rail?.status ?? statusOf(current.stage), ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: current.description ?? null, last_update: current.time ?? null,
    ...(current.time ? {} : { last_update_local: current.local_time }),
    ...(Number.isFinite(kilograms) && kilograms > 0 ? { weight_kg: kilograms } : {}),
    events: events.slice(0, 100),
  };
}

/**
 * The German app's SOAP service. Tracking needs an anonymous device session, which the
 * service takes tens of seconds to open and then accepts for hours: one is kept per client.
 */
export class DpdDeAppClient {
  readonly #partner: DpdDePartner;
  readonly #fetcher?: typeof fetch;
  readonly #userAgent: string;
  readonly #now: () => number;
  readonly #device = randomBytes(8).toString('hex');
  #session = '';
  #opening: Promise<string> | null = null;

  constructor(options: { partner?: DpdDePartner; fetcher?: typeof fetch; userAgent?: string; now?: () => number } = {}) {
    this.#partner = options.partner ?? PARTNER;
    this.#fetcher = options.fetcher;
    this.#userAgent = userAgentOf(options.userAgent);
    this.#now = options.now ?? Date.now;
  }

  async track(number: string, options: { signal: AbortSignal; timeoutMs: number }): Promise<CarrierResult> {
    if (!/^\d{14}$/.test(number)) throw new TypeError('DPD Germany app tracking takes 14 digits');
    const deadline = performance.now() + options.timeoutMs;
    const left = () => Math.max(1, Math.floor(deadline - performance.now()));
    try {
      for (let attempt = 0; ; attempt += 1) {
        const session = await this.session(options.signal, left());
        try {
          const data = await this.call('getTrackingData', { SessionToken: session, ParcelNo: number, DeliveryZipCode: '',
            UpdateNewDeliveryData: 'false', addParcelIfNoTrackingdataAvailable: 'false', ParcelFlowTypeID: 'receiving' }, options.signal, left());
          const scans = await this.call('getTrackingScanList', { SessionToken: session, ParcelNo: number, DeliveryZipCode: '' }, options.signal, left());
          return parseDpdDeApp(data, scans, number);
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

  /** One session for every lookup; the lookup that opens it lends its signal, the others only wait. */
  private async session(signal: AbortSignal, timeoutMs: number): Promise<string> {
    if (this.#session) return this.#session;
    if (!this.#opening) {
      const opening = this.call('getSessionFullState', { SessionToken: '', DeviceData: {
        HardwareID: this.#device, BootSystemID: 'Android_Phone', Version: '15', AppVersion: '4.2.0',
      } }, signal, timeoutMs).then(result => {
        const token = scalar(one(result, 'SessionFullState'), 'SessionToken', 600);
        if (!/^[A-Za-z0-9+/=]{16,512}$/.test(token)) invalid();
        return this.#session = token;
      });
      this.#opening = opening;
      void opening.catch(() => undefined).finally(() => { if (this.#opening === opening) this.#opening = null; });
    }
    const shared = this.#opening;
    signal.throwIfAborted();
    let leave!: () => void;
    const left = new Promise<never>((_resolve, reject) => { leave = () => reject(signal.reason as Error); });
    signal.addEventListener('abort', leave, { once: true });
    try { return await Promise.race([shared, left]); }
    finally { signal.removeEventListener('abort', leave); }
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
    // "No tracking data" also answers for parcels the scan list still knows: it proves no absence.
    if (scalar(result, 'Ack', 8) !== 'true') throw new IndeterminateError('DPD Germany', 'DPD Germany returned no confirmed parcel');
    return result;
  }
}
