import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, SENDY_LOOKUP } from './adapter.js';
import { normalizeSendyNumber, parseSendy } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample's reply, with the recipient, the captain, his phone, the plate and the images replaced.
const SAMPLE = 'SDS1703325';
const OTHER = 'SDS9000001';

type Reply = Record<string, unknown> & { trackings: Record<string, unknown>[]; info: Record<string, unknown> };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
/** The sample's reply under another number, with its parcel status and scans replaced when given. */
const reply = (changes: { status?: unknown; trackings?: Record<string, unknown>[]; number?: string } = {}): Reply => {
  const sample = fixture(SAMPLE);
  return { ...sample, track_no: changes.number ?? OTHER, parcel_json: [], info: { ...sample.info, ...('status' in changes ? { status: changes.status } : {}) },
    trackings: changes.trackings ?? sample.trackings };
};
const scan = (enName: string, content: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
  content, name: content, en_name: enName, location: 'Kulai Hub', full_info: null, date: '', time: '', pod: null, gps: null,
  attachments: [], created_at: createdAt, formatted_datetime: '', ...extra,
});
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Sendy Express numbers', () => {
  it('takes letters and digits as the tracker’s page does', () => {
    expect(normalizeSendyNumber(` ${SAMPLE.toLowerCase()} `)).toBe(SAMPLE);
    for (const other of ['', 'SD1', 'SDS17033/25', 'SDS1703325?x=1', 'X'.repeat(41)]) {
      expect(() => normalizeSendyNumber(other), other).toThrow('Enter the Sendy tracking number');
    }
  });
});

describe('Sendy Express tracking adapter', () => {
  it('asks the lookup behind the tracking page', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture(SAMPLE)));
    await expect(carrier(fetcher).track({ number: SAMPLE.toLowerCase() })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${SENDY_LOOKUP}${SAMPLE}?lang=en`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: expect.objectContaining({ Accept: 'application/json' }) });
    expect(carrier(fetcher)).toMatchObject({ id: 'sendy-express', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the tracker’s “no update” answer as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('not-found'), { status: 422 }));
    await expect(carrier(fetcher).track({ number: OTHER })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps rate limits, refusals, challenges and moved routes apart from a missing parcel', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: OTHER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    expect(await answer(() => json({ message: 'Too Many Attempts.' }, { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => json({ error: 'invalid_tracking_number' }, { status: 422 }))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => json({ message: 'The given data was invalid.' }, { status: 422 }))).toMatchObject({ kind: 'indeterminate' });
    const check = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    expect(await answer(() => new Response(check, { status: 403, headers: { 'Content-Type': 'text/html' } }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => new Response(check, { headers: { 'Content-Type': 'text/html' } }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => new Response('<html><body>Sendy</body></html>', { headers: { 'Content-Type': 'text/html' } }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response('<html>Server Error</html>', { status: 500, headers: { 'Content-Type': 'text/html' } })))
      .not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => new Response('<html>Not Found</html>', { status: 404, headers: { 'Content-Type': 'text/html' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: 'https://www.sendy.com.my/en' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => new Response('{', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
  });
});

describe('Sendy Express replies', () => {
  it('reads the public sample: its scans on their instants, its hub, and no person', () => {
    const result = parseSendy(fixture(SAMPLE), SAMPLE);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', provider_code: 'delivered',
      last_status_text: 'Parcel Delivered', last_update: '2023-03-21T07:39:18Z', expected_delivery: null, weight_kg: 2.4,
      events: [
        { time: '2023-03-21T07:39:18Z', description: 'Parcel Delivered', provider_code: 'delivered', stage: 'delivered', stage_source: 'carrier_map' },
        { time: '2023-03-21T01:21:28Z', description: 'Parcel Out for Delivery', provider_code: 'out_for_delivery', location: 'Selangor Hub', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2023-03-20T16:28:37Z', description: 'Parcel Arrived Hub', provider_code: 'sorting_scanned', location: 'Selangor Hub', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2023-03-20T13:54:09Z', description: 'Parcel Sorting Completed', provider_code: 'sorting_completed', location: 'Selangor Hub', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2023-03-20T13:54:04Z', description: 'Parcel Arrived Hub', provider_code: 'sorting_scanned', location: 'Selangor Hub', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2023-03-14T07:52:32Z', description: 'Parcel Order Placed', provider_code: 'order_placed', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/Example|CAPTAIN|60100000000|ZZZ0000|Jalan|attachments|3\.1,101\.6/);
  });

  it('answers a piece of the shipment or its reference, and no other number', () => {
    expect(parseSendy({ ...reply(), parcel_json: [{ track_no: 'SDS9000002' }] }, 'SDS9000002')).toMatchObject({ current_stage: 'delivered' });
    expect(parseSendy({ ...reply(), ref_no: 'ORDER123' }, 'ORDER123')).toMatchObject({ current_stage: 'delivered' });
    expect(() => parseSendy(reply(), 'SDS9000003')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('cuts a scan’s wording before any person it names, wherever the details put it', () => {
    const result = parseSendy(reply({ status: 'attempt_fail', trackings: [
      scan('delivery_failed', 'Delivery failed, recipient Tan Ah Kow not at home', '2024-05-02T06:00:00.000000Z',
        { full_info: { description: 'Delivery failed, recipient Tan Ah Kow not at home', info: { receiver_name: 'Tan Ah Kow' } } }),
      scan('out_for_delivery', 'Parcel Out for Delivery by Captain ALI, 0123456789', '2024-05-02T01:00:00.000000Z'),
      scan('out_for_delivery', 'Parcel Out for Delivery, call 012-345 6789', '2024-05-02T00:30:00.000000Z'),
      scan('transfer_to_3rd_party', 'Parcel Transferred to 3rd Party', '2024-05-01T10:00:00.000000Z',
        { full_info: { description: 'Parcel Transferred to 3rd Party', info: { agent: 'Example Courier' } } }),
    ] }), OTHER);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', provider_code: 'attempt_fail', last_status_text: 'Delivery failed, recipient' });
    expect(result.events).toMatchObject([
      { description: 'Delivery failed, recipient', provider_code: 'delivery_failed' },
      { description: 'Parcel Out for Delivery', stage: 'out_for_delivery' },
      { description: 'Parcel Out for Delivery', stage: 'out_for_delivery' },
      { description: 'Parcel Transferred to 3rd Party (Example Courier)', provider_code: 'transfer_to_3rd_party' },
    ]);
    expect(result.events![0]).not.toHaveProperty('stage');
    expect(JSON.stringify(result)).not.toMatch(/Tan Ah Kow|ALI|345/);
    const delivered = parseSendy(reply({ trackings: [scan('delivered', 'Parcel Delivered to Tan Ah Kow', '2024-05-02T06:00:00.000000Z')] }), OTHER);
    expect(delivered.events).toMatchObject([{ description: 'Parcel Delivered', stage: 'delivered' }]);
  });

  it('stages an unknown parcel status by its newest staged scan', () => {
    expect(parseSendy(reply({ status: 'somewhere_new' }), OTHER)).toMatchObject({ current_stage: 'delivered', provider_code: 'somewhere_new' });
    expect(parseSendy(reply({ status: null }), OTHER)).toMatchObject({ current_stage: 'delivered' });
    expect(parseSendy(reply({ status: 'Delivered' }), OTHER)).toMatchObject({ provider_code: 'delivered' });
  });

  it('reads a listed parcel without scans as no history', () => {
    expect(() => parseSendy(reply({ status: 'info_received', trackings: [] }), OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('refuses a changed reply', () => {
    const sample = fixture(SAMPLE);
    for (const changed of [null, {}, { ...reply(), trackings: {} }, { ...reply(), info: null }, reply({ status: 7 }),
      reply({ trackings: [scan('Delivered!', 'x', '2024-05-01T10:00:00Z')] }), reply({ trackings: [scan('delivered', 'x', '2024-05-01 10:00:00')] }),
      reply({ trackings: [null as unknown as Record<string, unknown>] }), reply({ trackings: Array.from({ length: 301 }, () => sample.trackings[0]!) })]) {
      expect(() => parseSendy(changed, OTHER), JSON.stringify(changed)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('Sendy Express statuses', () => {
  it('maps each scan and parcel key it records', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'sendy-express', providerCode: entry.code, description: entry.wording })).toMatchObject({ stage: entry.stage });
    }
    expect(statusMap.stage('somewhere_new', 'anything')).toBeUndefined();
  });
});
