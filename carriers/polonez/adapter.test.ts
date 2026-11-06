import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdapterRegistry } from '../../core/adapter/index.js';
import { hasDirectHandoffAdapter } from '../../core/catalog/handoff.js';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { isPolonezReference } from '../../core/detection/polonez.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { REGISTRY } from '../../generated/registry.js';
import { meestLookupUrl, MEEST_PAGE } from '../meest/client.js';
import { adapter, PolonezTracker } from './adapter.js';
import { normalizePolonezNumber, parsePolonez, POLONEZ_MAX_BYTES } from './parser.js';

const NUMBER = 'PIE482MP905731';
const UNKNOWN = 'POL904MP752683';
const PARTNER = '97468251360';
const SALT = '0123456789abcdef0123456789abcdef';
const NEW_SALT = 'fedcba9876543210fedcba9876543210';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const xml = fixture('tracking.xml');
const page = (salt = SALT) => new Response(fixture('page.html').replace(SALT, salt));
const reply = (body = xml) => new Response(body);
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, userAgent: 'SyntheticHost/1.0', env: {}, trawl: null, browserExecutablePath: null });
const site = (body = xml) => vi.fn<typeof fetch>(async input => String(input) === MEEST_PAGE ? page() : reply(body));
const rows = (body: string) => [...body.matchAll(/<items>[\s\S]*?<\/items>/g)].map(match => match[0]);
const withRows = (body: string, items: string[]) => body.replace(/<result_table>[\s\S]*?<\/result_table>/, `<result_table>${items.join('')}</result_table>`);

afterEach(() => vi.restoreAllMocks());

describe('Polonez bound guest history', () => {
  it('keeps origin delivery, final-mile pre-advice and recipient delivery separate', () => {
    const result = parsePolonez(xml, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      delivery_carrier: 'gls-pl', delivery_tracking_number: PARTNER,
      last_update: null, last_update_local: '2026-01-22', expected_delivery: null });
    expect(result.events).toHaveLength(16);
    expect(result.events!.every(event => event.local_time && !event.time && !event.provider_code)).toBe(true);
    const origin = result.events!.find(event => event.description === 'Delivered to origin warehouse')!;
    expect(origin).toMatchObject({ stage: 'in_transit', local_time: '2026-01-05T15:20:21' });
    expect(result.events!.find(event => event.description === 'On delivery route to origin warehouse')?.stage).toBe('in_transit');
    expect(result.events!.find(event => event.description === 'Arrived at EU distribution center')?.stage).toBe('in_transit');
    for (const text of ['Final-mile information received', 'Delivery expected today']) {
      expect(result.events!.find(event => event.description === text)?.stage).toBeUndefined();
      expect(statusMapAnswer({ carrier: 'polonez', description: text })).toMatchObject({ kind: 'intentional_gap' });
    }
    expect(result.events!.filter(event => event.stage === 'delivered')).toHaveLength(2);
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC PERSON|Example Road|example\.invalid|SYNTHETIC-PRIVATE|On the Ship/);
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('names GLS Poland only with consistent Polish destination evidence', () => {
    const otherCountry = xml.replaceAll('<Country_EN>PL</Country_EN>', '<Country_EN>DE</Country_EN>');
    expect(parsePolonez(otherCountry, NUMBER).delivery_carrier).toBeUndefined();
    const statedElsewhere = xml.replace('<StatusCode />', '<StatusCode /><CountryDel>FR</CountryDel>');
    expect(parsePolonez(statedElsewhere, NUMBER).delivery_carrier).toBeUndefined();
    expect(parsePolonez(xml.replaceAll('<Country_EN>PL</Country_EN>', '<Country_EN />'), NUMBER).delivery_carrier).toBeUndefined();
  });

  it('retains custody before final delivery and never completes an origin-only leg', () => {
    const source = rows(xml);
    const result = parsePolonez(withRows(xml, source.slice(0, 5)), NUMBER);
    expect(result.current_stage).toBe('in_transit');
    expect(result.delivery_carrier).toBeUndefined();
    expect(parsePolonez(withRows(xml, source.slice(0, 12)), NUMBER).current_stage).toBe('in_transit');
    const ambiguous = withRows(xml, [source[4]!.replace('PORT READING', 'Unknown')]);
    expect(parsePolonez(ambiguous, NUMBER).current_stage).toBeUndefined();
  });

  it('does not release unrelated Meest services or unsupported older labels as Polonez', () => {
    for (const number of ['UPS482LE905731', 'ABC482MP905731', '97468251360', 'RR583920174PL']) {
      expect(isPolonezReference(number)).toBe(false);
      expect(() => normalizePolonezNumber(number)).toThrow();
    }
    expect(normalizePolonezNumber('pie 482 mp 905731')).toBe(NUMBER);
    expect(() => parsePolonez(xml.replace('<StatusCode />', '<StatusCode>1622</StatusCode>'), NUMBER)).toThrow();
  });

  it.each(['ShipmentNumber', 'ShipmentNumberSender', 'Barcode'])('binds every whole %s before projecting rows or applying a cap', field => {
    for (const value of [UNKNOWN, NUMBER + '9', NUMBER + '-9', '']) {
      const wrong = xml.replace(`<${field}>${NUMBER}</${field}>`, `<${field}>${value}</${field}>`);
      expect(() => parsePolonez(wrong, NUMBER)).toThrow();
    }
    const source = rows(xml);
    const many = Array.from({ length: 101 }, (_, i) => source[0]!.replace('2026-01-04 08:10:00', `2026-01-04 08:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`));
    many.push(source.at(-1)!.replace(`<${field}>${NUMBER}</${field}>`, `<${field}>${UNKNOWN}</${field}>`));
    expect(() => parsePolonez(withRows(xml, many), NUMBER)).toThrow();
  });

  it('rejects mixed schemas, duplicate identity fields, invalid clocks and conflicting partners', () => {
    for (const body of [
      xml.replace('<ShipmentNumber>', '<ShipmentNumber><nested/>'),
      xml.replace('</Barcode>', `</Barcode><Barcode>${NUMBER}</Barcode>`),
      xml.replace('2026-01-04 08:10:00', '2026-02-30 08:10:00'),
      xml.replace('2026-01-04 08:10:00', '2026-01-04 24:10:00'),
      xml.replace('<result_table>', '<result_table><unexpected/>'),
      xml.replace('<code>000</code>', '<code>changed</code>'),
      xml.replace('<return>', '<return xmlns="https://example.invalid/changed">'),
      withRows(xml, rows(xml).reverse()),
    ]) expect(() => parsePolonez(body, NUMBER)).toThrow();
    const partnerRow = rows(xml)[9]!.replaceAll(PARTNER, '97468251379');
    expect(() => parsePolonez(withRows(xml, [...rows(xml).slice(0, 10), partnerRow]), NUMBER)).toThrow();
  });

  it('keeps empty retained history and upstream errors inconclusive', () => {
    for (const body of [fixture('empty.xml'), xml.replace('<code>000</code>', '<code>101</code>')]) {
      expect(() => parsePolonez(body, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('retains day precision, removes exact duplicates and validates all rows before truncation', () => {
    expect(parsePolonez(xml.replace('2026-01-22', '2026-01-22 00:00:01'), NUMBER).events![0]!.local_time).toBe('2026-01-22');
    expect(parsePolonez(withRows(xml, [...rows(xml), rows(xml).at(-1)!]), NUMBER).events).toHaveLength(16);
    const source = rows(xml)[0]!;
    const many = Array.from({ length: 110 }, (_, i) => source.replace('2026-01-04 08:10:00', `2026-01-04 08:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`));
    const result = parsePolonez(withRows(xml, many), NUMBER);
    expect(result.events).toHaveLength(100); expect(result.history_truncated).toBe(true);
    expect(() => parsePolonez(withRows(xml, Array.from({ length: 501 }, () => source)), NUMBER)).toThrow();
  });

  it('keeps unfamiliar or private wording generic and omits mixed locations', () => {
    const body = xml.replace('The parcel has been delivered..', 'SYNTHETIC PERSON signed: +19995550143 sender@example.invalid')
      .replace('<City_EN>Czeladz</City_EN>', '<City_EN>19 Example Road</City_EN>');
    const result = parsePolonez(body, NUMBER);
    expect(result.events!.some(event => event.description === 'Tracking update')).toBe(true);
    expect(result.history_truncated).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC PERSON|19995550143|example\.invalid|Example Road/);
  });
});

describe('Polonez transport and routing', () => {
  it('uses the supplied transport, whole-number signed lookup, identity, signal and step recorder', async () => {
    const fetcher = site();
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const instance = adapter({ ...environment(fetcher), recorder });
    expect((await instance.track({ number: NUMBER })).events).toHaveLength(16);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([MEEST_PAGE, meestLookupUrl(NUMBER, SALT)]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init?.redirect).toBe('manual'); expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers); expect(headers.get('User-Agent')).toBe('SyntheticHost/1.0');
      expect(headers.has('Cookie')).toBe(false); expect(headers.has('Authorization')).toBe(false);
    }
    expect(fetcher.mock.calls[1]![1]?.method).toBe('POST');
    expect(fetcher.mock.calls[1]![1]?.body ?? null).toBeNull();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'polonez', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('refreshes only an expired cached salt once and attributes the recovery to Polonez', async () => {
    let salt = SALT;
    const fetcher = vi.fn<typeof fetch>(async input => String(input) === MEEST_PAGE ? page(salt)
      : String(input) === meestLookupUrl(NUMBER, salt) ? reply() : new Response('', { status: 400 }));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    const tracker = new PolonezTracker({ fetcher, recorder });
    await tracker.fetch(NUMBER); salt = NEW_SALT; fetcher.mockClear();
    await tracker.fetch(NUMBER);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([meestLookupUrl(NUMBER, SALT), MEEST_PAGE, meestLookupUrl(NUMBER, NEW_SALT)]);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'polonez', step: 'refresh', outcome: 'ok', fallbackReason: 'indeterminate' }));
    const refused = vi.fn<typeof fetch>(async input => String(input) === MEEST_PAGE ? page() : new Response('', { status: 400 }));
    await expect(new PolonezTracker({ fetcher: refused }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    expect(refused).toHaveBeenCalledTimes(2);
  });

  it('retries one network failure, never an HTTP reply or malformed response', async () => {
    const fetcher = site(); fetcher.mockRejectedValueOnce(new TypeError('connection failed'));
    expect((await new PolonezTracker({ fetcher }).fetch(NUMBER)).events).toHaveLength(16);
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const [status, body, kind] of [[403, 'refused', 'challenge'], [429, 'slow down', 'rate_limited'],
      [503, 'unavailable', 'maintenance'], [302, '', 'transport'], [404, 'missing page', 'transport'],
      [200, '<title>Just a moment</title>', 'challenge'], [200, 'changed page', 'schema']] as const) {
      const fetcher = vi.fn<typeof fetch>(async () => new Response(body, { status }));
      await expect(new PolonezTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps lookup rejection, body limits and cancellation separate without extra requests', async () => {
    for (const [status, body, kind] of [[403, 'refused', 'challenge'], [429, 'slow down', 'rate_limited'],
      [200, 'changed XML', 'schema'], [200, '<title>Access denied</title>', 'challenge'],
      [200, 'x'.repeat(POLONEZ_MAX_BYTES + 1), 'indeterminate']] as const) {
      const fetcher = vi.fn<typeof fetch>(async input => String(input) === MEEST_PAGE ? page() : new Response(body, { status }));
      await expect(new PolonezTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
    const controller = new AbortController(); controller.abort(); const fetcher = site();
    await expect(new PolonezTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(new PolonezTracker({ fetcher }).fetch('UPS482LE905731')).rejects.toMatchObject({ kind: 'indeterminate', reason: 'unsupported_reference' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('registers native history and shares eligibility without claiming numeric or postal identifiers', async () => {
    expect(hasDirectHandoffAdapter('polonez', NUMBER)).toBe(true);
    expect(hasDirectHandoffAdapter('polonez', PARTNER)).toBe(false);
    expect(hasDirectHandoffAdapter('polonez', 'UPS482LE905731')).toBe(false);
    expect(recognitionAskedCarriers(NUMBER)).not.toContain('polonez');
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'polonez', confidence: 'high' });
    expect(parseTrackingInput(`https://tracking-iframe.meest.com/t/en/${NUMBER}`)).toMatchObject({ carrier: 'polonez', trackingNumber: NUMBER, source: 'link' });
    const fetcher = site();
    expect((await new AdapterRegistry(REGISTRY, environment(fetcher)).for('polonez')!.track({ number: NUMBER })).current_stage).toBe('delivered');
    const facade = await createTracker({ fetcher: site(withRows(xml, rows(xml).slice(0, 5))), providers: [], env: {} }).track({ carrier: 'polonez', number: NUMBER });
    expect(facade.source).toBe('polonez'); expect(facade.result.current_stage).toBe('in_transit');
    expect(facade.result.events.every(event => event.local_time && (!event.time || event.time_zone_basis))).toBe(true);
  });
});
