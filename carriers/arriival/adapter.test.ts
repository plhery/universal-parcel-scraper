import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, ARRIIVAL_LOOKUP } from './adapter.js';
import { normalizeArriivalNumber, parseArriival } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample's reply, with the sender, the recipient, the address, the driver's phone and the photo replaced.
const SAMPLE = 'TH113308688AF';
const OTHER = 'TH900000001AF';

type Waybill = Record<string, unknown> & { trackingtlist: Record<string, unknown>[] };
type Reply = Record<string, unknown> & { data: Waybill };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
/** The sample's reply under another number, with its scans replaced when given. */
const reply = (changes: { scans?: unknown[]; number?: unknown; data?: Record<string, unknown> } = {}): Reply => {
  const sample = fixture(SAMPLE);
  return { ...sample, data: { ...sample.data, wbno: 'number' in changes ? changes.number : OTHER,
    trackingtlist: (changes.scans ?? sample.data.trackingtlist) as Record<string, unknown>[], ...changes.data } };
};
const scan = (orderStatus: unknown, orderDescription: unknown, orderTime: unknown) => ({ orderTime, orderStatus, orderDescription });
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json;charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Arriival numbers', () => {
  it('takes letters and digits as the tracker’s page does, dashes as separators', () => {
    expect(normalizeArriivalNumber(` ${SAMPLE.toLowerCase()} `)).toBe(SAMPLE);
    expect(normalizeArriivalNumber('TH-113308688-AF')).toBe(SAMPLE);
    for (const other of ['', 'TH1', 'TH113308688/AF', 'TH113308688AF?x=1', 'X'.repeat(41)]) {
      expect(() => normalizeArriivalNumber(other), other).toThrow('Enter the Arriival tracking number');
    }
  });
});

describe('Arriival tracking adapter', () => {
  it('posts the number to the lookup behind the tracking page', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture(SAMPLE)));
    await expect(carrier(fetcher).track({ number: SAMPLE.toLowerCase() })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${ARRIIVAL_LOOKUP}?no=${SAMPLE}`);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: expect.objectContaining({ Accept: 'application/json' }) });
    expect(init?.body ?? null).toBeNull();
    expect(carrier(fetcher)).toMatchObject({ id: 'arriival', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the tracker’s code 301 as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('not-found')));
    await expect(carrier(fetcher).track({ number: OTHER })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps refusals, failures, pages and moved routes apart from a missing waybill', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: OTHER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    // The tracker's answer to a request without a number, or sent as GET.
    expect(await answer(() => json({ msg: 'Operation failed', code: 407, data: null, enMsg: 'Operation failed' }))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => json({ msg: 'error', code: 500, data: null }))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => json({ message: 'Too Many Requests' }, { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    const check = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    expect(await answer(() => new Response(check, { status: 403, headers: { 'Content-Type': 'text/html' } }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => new Response(check, { headers: { 'Content-Type': 'text/html' } }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => new Response('<html><body>nginx</body></html>', { headers: { 'Content-Type': 'text/html' } }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } })))
      .not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => new Response('<html>Not Found</html>', { status: 404, headers: { 'Content-Type': 'text/html' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: 'https://arriival.com/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => new Response('{', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
  });
});

describe('Arriival replies', () => {
  it('reads the public sample: its scans on their wall clocks, its service, and no person', () => {
    const result = parseArriival(fixture(SAMPLE), SAMPLE);
    const event = (local_time: string, code: string, description: string, stage: string) =>
      ({ local_time, description, provider_code: code, stage, stage_source: 'carrier_map' });
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', provider_code: '15',
      last_status_text: 'Parcel Delivered!', last_update: null, last_update_local: '2026-09-24T09:21:50', expected_delivery: null,
      service_name: 'WM EM Freight',
      events: [
        event('2026-09-24T09:21:50', '15', 'Parcel Delivered!', 'delivered'),
        event('2026-09-23T15:15:50', '14', 'Your parcel is out for delivery.', 'out_for_delivery'),
        event('2026-09-23T15:15:50', '13', 'Departed to recipient\'s address for parcel delivery', 'out_for_delivery'),
        event('2026-09-23T12:10:52', '10', 'Awaiting customs clearance', 'customs'),
        event('2026-09-22T18:29:18', '9', 'Departure to Kuala Lumpur International Airport', 'in_transit'),
        event('2026-09-22T18:24:06', '9', 'Departure to Kuala Lumpur International Airport', 'in_transit'),
        event('2026-09-22T18:22:21', '8', 'Parcel received at sorting facility', 'in_transit'),
        event('2026-09-22T18:22:21', '7', 'Parcel transit to sorting facility', 'in_transit'),
        event('2026-09-22T18:19:02', '1', 'Order Confirmed', 'registered'),
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/EXAMPLE|JALAN|0100000000|uploadfile|Sandakan|Kuala Lumpur"/);
  });

  it('answers its own waybill and no other', () => {
    expect(parseArriival(reply({ number: OTHER.toLowerCase() }), OTHER)).toMatchObject({ current_stage: 'delivered' });
    for (const number of ['TH900000002AF', null]) {
      expect(() => parseArriival(reply({ number }), OTHER), String(number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('drops the sentence with a phone, repeats, and orders scans of one second by code', () => {
    const result = parseArriival(reply({ scans: [
      scan('13', 'Departed to recipient\'s address for parcel delivery', '2024-05-02 09:00:00'),
      scan(14, 'Your parcel is out for delivery. Contact the driver at [+6012-345 6789].', '2024-05-02 09:00:00'),
      scan('14', 'Your parcel is out for delivery. Contact the driver at [+6012-345 6789].', '2024-05-02 09:00:00'),
      scan('16', 'Call 0123456789', '2024-05-02 12:00:00'),
      scan('12', 'Arrived at hub', '2024-05-02 08:00:00'),
    ] }), OTHER);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', provider_code: '16', last_status_text: '16',
      last_update_local: '2024-05-02T12:00:00' });
    expect(result.events).toEqual([
      { local_time: '2024-05-02T12:00:00', description: '16', provider_code: '16' },
      { local_time: '2024-05-02T09:00:00', description: 'Your parcel is out for delivery.', provider_code: '14', stage: 'out_for_delivery', stage_source: 'carrier_map' },
      { local_time: '2024-05-02T09:00:00', description: 'Departed to recipient\'s address for parcel delivery', provider_code: '13', stage: 'out_for_delivery', stage_source: 'carrier_map' },
      { local_time: '2024-05-02T08:00:00', description: 'Arrived at hub', provider_code: '12' },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/345|0123456789/);
  });

  it('reads the waybill’s scans without a service, and a waybill without scans as no history', () => {
    expect(parseArriival(reply({ data: { DeliveryType: null } }), OTHER)).not.toHaveProperty('service_name');
    for (const scans of [[], undefined]) {
      expect(() => parseArriival(reply({ data: { trackingtlist: scans } }), OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
    }
  });

  it('refuses a changed reply', () => {
    const sample = fixture(SAMPLE);
    for (const changed of [null, {}, { code: '200', data: sample.data }, { code: 200, data: null }, reply({ data: { trackingtlist: {} } }),
      reply({ scans: [null] }), reply({ scans: [scan('1', 'x', '2024-05-02T09:00:00Z')] }), reply({ scans: [scan('1', 'x', '2024-02-30 09:00:00')] }),
      reply({ scans: [scan('Delivered', 'x', '2024-05-02 09:00:00')] }), reply({ scans: Array.from({ length: 301 }, () => sample.data.trackingtlist[0]) })]) {
      expect(() => parseArriival(changed, OTHER), JSON.stringify(changed)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('Arriival statuses', () => {
  it('maps each scan code it records', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'arriival', providerCode: entry.code, description: entry.wording })).toMatchObject({ stage: entry.stage });
    }
    expect(statusMap.stage('99', 'anything')).toBeUndefined();
  });
});
