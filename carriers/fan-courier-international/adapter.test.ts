import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { isRoyalMailDomesticReference } from '../../core/detection/royalMail.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { universalCarrierHints } from '../../providers/shared/hints.js';
import { adapter, FanCourierInternationalTracker } from './adapter.js';
import { parseFanCourierInternational } from './parser.js';
import { fanCourierInternationalStage, statusMap } from './status.js';

const NUMBER = '1000000000000001F0001';
const fixture = (name = 'in-transit') => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const environment = (fetcher: typeof fetch) => ({ fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
const reply = (body: unknown, status = 200, type = 'application/json') =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': type } });

describe('FAN Courier International events', () => {
  it('reads typed events newest first at their instants on Bucharest time, at the headline stage', () => {
    const result = normalizeCarrierResult(parseFanCourierInternational(fixture(), NUMBER));
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Received code: In Transit',
      last_update: '2026-01-09T21:10:37+02:00', timezone: 'Europe/Bucharest' });
    expect(result.events).toHaveLength(4);
    // The code arrived half an hour before the system wrote it; the page shows the earlier instant.
    expect(result.events?.[0]).toMatchObject({ description: 'The shipment is picked up', provider_code: 'StatusChanged:active',
      time: '2026-01-09T21:10:37+02:00', stage: 'accepted' });
    expect(result.events?.[1]).toMatchObject({ provider_code: 'CodeChanged:In Transit', time: '2026-01-09T21:10:37+02:00', stage: 'in_transit' });
    expect(result.events?.[2]).toMatchObject({ provider_code: 'StatusChanged:uncollected', location: 'Sample Hub', stage: 'registered' });
    expect(result.events?.[3]).toMatchObject({ provider_code: 'ShipmentCreated', time: '2026-01-05T10:00:04+02:00', stage: 'registered' });
    expect(JSON.stringify(result)).not.toMatch(/X00000001|4000000000010|1\.5|invoice_weight|all_numbers|franchisor/);
  });

  it('lets a settled headline status win over the last code, and reads the date without an epoch', () => {
    const payload = fixture();
    payload.status.status = 'delivered';
    payload.history.history.push({ ...payload.history.history[3], date: '2026-01-10 12:00:00', event_date: null,
      eventType: 'StatusChanged:delivered', description: 'The shipment has been delivered', status: 'livrata' });
    const result = normalizeCarrierResult(parseFanCourierInternational(payload, NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'The shipment has been delivered',
      last_update_local: '2026-01-10T12:00:00' });
    expect(result.events?.[0]).toMatchObject({ local_time: '2026-01-10T12:00:00', stage: 'delivered' });
    expect(result.events?.[0]).not.toHaveProperty('time');
  });

  it('reads a code that comes by its abbreviation, in the headline and the events', () => {
    const payload = fixture();
    payload.status = { ...payload.status, code: 'ADH', code_name: 'Arrived at Delivery Hub' };
    payload.history.history.push({ ...payload.history.history[3], date: '2026-01-10 08:00:00', event_date: null,
      eventType: 'CodeChanged:ADH', description: 'Received code: Arrived at Delivery Hub', status: '' });
    const result = parseFanCourierInternational(payload, NUMBER);
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Received code: Arrived at Delivery Hub' });
    expect(result.events?.[0]).toMatchObject({ provider_code: 'CodeChanged:ADH', stage: 'in_transit' });
    expect(fanCourierInternationalStage('CodeChanged:XYZ', 'Received code: Arrived at Delivery Hub')).toBe('in_transit');
  });

  it('reads the newest received code the map knows, not the opening status, behind a last code the map does not know', () => {
    const payload = fixture();
    payload.status = { ...payload.status, code: 'QQZ', code_name: 'Synthetic unknown code' };
    payload.history.history.push({ ...payload.history.history[3], date: '2026-01-11 08:00:00', event_date: null,
      eventType: 'CodeChanged:QQZ', description: 'Received code: Synthetic unknown code', status: '' });
    const result = parseFanCourierInternational(payload, NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Received code: In Transit' });
    expect(result.events?.[0]).toMatchObject({ provider_code: 'CodeChanged:QQZ' });
    expect(result.events?.[0]).not.toHaveProperty('stage');
    // A settled status still leads, and without a received code the map reads the opening status stands.
    expect(parseFanCourierInternational({ ...payload, status: { ...payload.status, status: 'exception' } }, NUMBER)).toMatchObject({ current_stage: 'exception' });
    const unread = fixture();
    unread.status = { ...unread.status, code: 'QQZ', code_name: 'Synthetic unknown code' };
    unread.history.history = unread.history.history.filter((row: { eventType: string }) => !row.eventType.startsWith('CodeChanged:'));
    expect(parseFanCourierInternational(unread, NUMBER)).toMatchObject({ current_stage: 'accepted', last_status_text: 'The shipment is picked up' });
  });

  it('falls back on the newest staged event without a headline', () => {
    const payload = fixture();
    delete payload.status;
    expect(parseFanCourierInternational(payload, NUMBER)).toMatchObject({ current_stage: 'accepted', last_status_text: 'The shipment is picked up' });
  });

  it('binds the reply to the whole number and refuses malformed events', () => {
    const other = fixture();
    other.history.no = 'X00000001';
    other.status.request_no = 'X00000001';
    expect(() => parseFanCourierInternational(other, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const untimed = fixture();
    untimed.history.history[0].event_date = 'soon';
    untimed.history.history[0].date = '';
    expect(() => parseFanCourierInternational(untimed, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const empty = fixture();
    empty.history.history = [];
    expect(() => parseFanCourierInternational(empty, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseFanCourierInternational({ history: [] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('maps the event types and the page sentences', () => {
    expect(fanCourierInternationalStage('StatusChanged:in-transit', '')).toBe('in_transit');
    expect(fanCourierInternationalStage('StatusChanged:returned', '')).toBe('returned');
    expect(fanCourierInternationalStage('CodeChanged:Delivery attempt', '')).toBe('failed_attempt');
    expect(fanCourierInternationalStage('CodeChanged:Delivery attempt - refused', '')).toBe('exception');
    expect(fanCourierInternationalStage('HubScan', 'The shipment arrived in the hub: Timisoara')).toBe('in_transit');
    expect(fanCourierInternationalStage('Other', 'The shipment is ready to be picked up')).toBe('registered');
    expect(fanCourierInternationalStage('StatusChanged:notified', 'Notified')).toBeUndefined();
    expect(statusMap.stage('StatusChanged:active', 'the shipment is picked up')).toBe('accepted');
  });
});

describe('FAN Courier International retrieval', () => {
  it('posts the whole number to the status API and reads its reply', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => reply(fixture()));
    const result = await new FanCourierInternationalTracker({ fetcher }).fetch(`${NUMBER.slice(0, 16)} f${NUMBER.slice(17)}`);
    expect(result.current_stage).toBe('in_transit');
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://fancourier.eu/API/status');
    expect(init).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(init?.body))).toEqual({ trackingNumber: NUMBER, locale: 'en' });
  });

  it('reads the tracker\'s NOT_FOUND for the same number as not found, and keeps other refusals apart', async () => {
    await expect(new FanCourierInternationalTracker({ fetcher: async () => reply(fixture('not-found'), 401) }).fetch(NUMBER))
      .rejects.toMatchObject({ kind: 'not_found' });
    const other = { ...fixture('not-found'), message: 'Shipment number was not found: 1000000000000002F0001' };
    await expect(new FanCourierInternationalTracker({ fetcher: async () => reply(other, 401) }).fetch(NUMBER))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(new FanCourierInternationalTracker({ fetcher: async () => reply({ message: 'Unauthenticated.' }, 401) }).fetch(NUMBER))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(new FanCourierInternationalTracker({ fetcher: async () => reply({ message: 'The tracking number field is required.' }, 422) }).fetch(NUMBER))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(new FanCourierInternationalTracker({ fetcher: async () => reply('<title>Just a moment...</title>', 403, 'text/html') }).fetch(NUMBER))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(new FanCourierInternationalTracker({ fetcher: async () => reply('<html>maintenance</html>', 200, 'text/html') }).fetch(NUMBER))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(new FanCourierInternationalTracker({ fetcher: async () => reply('', 429) }).fetch(NUMBER))
      .rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('refuses other shapes before any request, and recognizes through a lookup', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => reply(fixture()));
    await expect(new FanCourierInternationalTracker({ fetcher }).fetch('4000000000010')).rejects.toBeInstanceOf(InvalidInputError);
    expect(fetcher).not.toHaveBeenCalled();
    const instance = adapter(environment(fetcher));
    expect(instance.id).toBe('fan-courier-international');
    await expect(instance.recognize!(NUMBER, {})).resolves.toMatchObject({ known: true });
  });
});

describe('FAN Courier International numbers', () => {
  it('offers FAN Courier International, not Royal Mail, for sixteen digits, an F and four digits', () => {
    const detected = detectCarrierMatch(NUMBER);
    expect(detected.candidates).toContain('fan-courier-international');
    expect(detected.candidates).not.toContain('royal-mail');
    expect(isRoyalMailDomesticReference(NUMBER)).toBe(false);
    expect(isRoyalMailDomesticReference('1000000000000001FA001')).toBe(true);
  });

  it('turns Postal Ninja\'s FAN Courier into FAN Courier International for its numbers only', () => {
    expect(universalCarrierHints(['FAN Courier'], NUMBER)).toEqual({ reported_carriers: ['FAN Courier'], discovered_carrier: 'fan-courier-international' });
    expect(universalCarrierHints(['FAN Courier'], '4000000000010')).toMatchObject({ discovered_carrier: 'fan-courier' });
  });
});
