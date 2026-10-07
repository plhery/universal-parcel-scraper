import { DateTime } from 'luxon';
import { CarrierError, ChallengeError, IndeterminateError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import type { ClassifiedStatus } from '../../core/status/index.js';
import { clean, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { xmlDocument, type XmlNode } from '../../core/transport/xml.js';
import { normalizeLbcNumber } from './parser.js';

export const LBC_MOBILE_API = 'https://lbcapigateway.lbcapps.com/lbctrackingapi2/v2';
const SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const SERVICE = 'http://tempuri.org/';
const MAX_BYTES = 1_000_000;
// Shared guest-tracking application key, distributed with the maintainer's approval.
const APPLICATION_KEY = '4dc2cebad70043c79346dc66d5a94fa8';

function invalidXml(): never { throw new SchemaError('lbc-express', 'LBC returned invalid tracking XML'); }

function children(node: XmlNode, name: string, uri = SERVICE): XmlNode[] {
  return node.children.filter(child => child.name === name && child.uri === uri);
}

function one(node: XmlNode, name: string, uri = SERVICE): XmlNode {
  const matches = children(node, name, uri);
  if (matches.length !== 1) invalidXml();
  return matches[0]!;
}

function scalar(node: XmlNode, name: string, required = true, max = 1000): string {
  const matches = children(node, name);
  if (matches.length > 1 || (!matches.length && required)) invalidXml();
  if (!matches.length) return '';
  if (matches[0]!.children.length) invalidXml();
  const value = clean(matches[0]!.text, max);
  if (required && !value) invalidXml();
  return value;
}

const CODES: Readonly<Record<string, ClassifiedStatus>> = {
  '1': { status: 'delivered', stage: 'delivered' },
  '4': { status: 'exception', stage: 'failed_attempt' },
  '8000': { status: 'in_transit', stage: 'accepted' },
  '8002': { status: 'out_for_delivery', stage: 'out_for_delivery' },
  '8810': { status: 'in_transit', stage: 'in_transit' },
  '8820': { status: 'in_transit', stage: 'in_transit' },
  '1004': { status: 'in_transit', stage: 'in_transit' },
};

function scanClock(day: string, time: string): string | null {
  if (!time) return null;
  if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(day) || !/^\d{1,2}:\d{2}:\d{2} [AP]M$/.test(time)) invalidXml();
  const parsed = DateTime.fromFormat(`${day} ${time}`, 'M/d/yyyy h:mm:ss a', { locale: 'en', zone: 'UTC' });
  if (!parsed.isValid) invalidXml();
  // UTC only validates calendar digits; the provider gives no offset.
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

export function parseLbcMobile(xml: string, raw: string): CarrierResult {
  const number = normalizeLbcNumber(raw);
  const root = xmlDocument(xml, MAX_BYTES) ?? invalidXml();
  if (root.name !== 'Envelope' || root.uri !== SOAP) invalidXml();
  const body = one(root, 'Body', SOAP);
  if (children(body, 'Fault', SOAP).length) throw new IndeterminateError('lbc-express', 'LBC returned a tracking service fault');
  const response = one(body, 'LBCTrackAndTraceResponse');
  const result = one(response, 'LBCTrackAndTraceResult');
  const status = one(result, 'TrackingStatus');
  const code = scalar(status, 'StatusCode', true, 16);
  // Remittances and unbound service errors do not establish parcel absence.
  if (code !== '0001') throw new IndeterminateError('lbc-express', 'LBC returned no confirmed parcel history');
  const details = one(one(status, 'TrackingDetails'), 'TrackingDetails');
  if (scalar(details, 'TrackingNo', true, 40) !== number) {
    throw new SchemaError('lbc-express', 'LBC returned a different shipment');
  }
  const rows = children(one(status, 'TrackingHistory'), 'TrackingHistory');
  if (!rows.length) throw new IndeterminateError('lbc-express', 'LBC returned no shipment scans');
  if (rows.length > 500) invalidXml();
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const code = scalar(row, 'StatusId', true, 32);
    const wording = scalar(row, 'StatusandLocation');
    const mapped = CODES[code];
    const description = code === '1' ? 'Delivered' : /^Delivered to\b/i.test(wording) ? 'Delivery update' : wording;
    const day = scalar(row, 'DatePosted', true, 64);
    const time = scalar(row, 'DatePostedTime', false, 64);
    const local = scanClock(day, time);
    const event: CarrierEvent = { description, provider_code: code, provider_time_text: `${day}${time ? ` ${time}` : ''}`,
      ...(local ? { local_time: local } : {}), ...(mapped ? { stage: mapped.stage, stage_source: 'carrier_map' } : {}) };
    // Branch, remarks, coordinates and recipient/sender fields are not projected.
    const identity = JSON.stringify(event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    events.push(event);
  }
  // The mobile service supplies oldest-first scans; valid local clocks can sort them.
  events.reverse();
  if (events.every(event => typeof event.local_time === 'string')) {
    events.sort((a, b) => String(b.local_time).localeCompare(String(a.local_time)));
  }
  const current = events[0]!;
  const mapped = CODES[String(current.provider_code)];
  return { status: mapped?.status ?? 'unknown', ...(mapped ? { current_stage: mapped.stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: current.description, last_update: null, ...(current.local_time ? { last_update_local: current.local_time } : {}),
    timezone: 'Asia/Manila', events: events.slice(0, 100) };
}

export async function readLbcMobile(number: string, options: {
  key?: string | null; fetcher?: typeof fetch; userAgent?: string; signal: AbortSignal; timeoutMs: number;
}): Promise<CarrierResult> {
  const normalized = normalizeLbcNumber(number);
  const key = options.key === undefined ? APPLICATION_KEY : options.key?.trim();
  if (!key || !/^[\w.~+/=-]{8,512}$/.test(key)) throw new ChallengeError('lbc-express', 'LBC tracking API key is unavailable');
  const body = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="${SOAP}"><soap:Body><LBCTrackAndTrace xmlns="${SERVICE}"><TrackingNo>${normalized}</TrackingNo></LBCTrackAndTrace></soap:Body></soap:Envelope>`;
  try {
    const { response, bytes } = await fetchBounded(LBC_MOBILE_API, { method: 'POST', signal: options.signal, body,
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `${SERVICE}LBCTrackAndTrace`,
        Accept: 'text/xml', lbcOAKey: key, 'User-Agent': userAgentOf(options.userAgent) } }, {
      provider: 'lbc-express', maxBytes: MAX_BYTES, timeoutMs: options.timeoutMs, fetcher: options.fetcher,
      allowHttpStatuses: [401, 403, 404, 410],
    });
    if ([401, 403].includes(response.status)) throw new ChallengeError('lbc-express', 'LBC refused the tracking API credential');
    if ([404, 410].includes(response.status)) throw new TransportError('lbc-express', 'LBC tracking API is unavailable', { status: response.status });
    const xml = decodeText(bytes);
    if (/<(?:html|!doctype html)\b/i.test(xml) && /captcha|cloudflare|access denied|challenge/i.test(xml)) throw new ChallengeError('lbc-express');
    if (response.status !== 200) throw new UpstreamHttpError('lbc-express', response.status);
    return parseLbcMobile(xml, normalized);
  } catch (error) {
    options.signal.throwIfAborted();
    // Transport diagnostics include the key, barcode and possibly recipient XML.
    // Preserve the failure contract without forwarding request/body data or causes.
    if (error instanceof CarrierError) throw new CarrierError(error.kind, 'lbc-express', `LBC tracking failed (${error.kind})`, {
      status: error.status, retryAfterMs: error.retryAfterMs, reason: error.reason,
    });
    throw new TransportError('lbc-express', 'LBC tracking API request failed');
  }
}
