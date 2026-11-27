import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, DD_EXPRESS_LOOKUP } from './adapter.js';
import { normalizeDdExpressNumber, parseDdExpress } from './parser.js';
import { ddExpressWording, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample's whole reply, and invented numbers far from it.
const SAMPLE = '55536223691';
const OTHER = '90000000199';

type Parcel = Record<string, unknown> & { info: Record<string, unknown>[] };
type Reply = { status: number; message: string; data: Parcel[] };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const row = (status: unknown, created_at: unknown, extra: Record<string, unknown> = {}) => ({ tracking_id: OTHER, status, created_at, images: [], ...extra });
/** The sample's parcel under another number, with its statuses replaced when given. */
const parcel = (changes: { info?: unknown[]; number?: unknown; reference?: unknown } = {}): Parcel => {
  const sample = fixture(SAMPLE).data[0]!;
  return { tracking_id: 'number' in changes ? changes.number : OTHER, reference_id: 'reference' in changes ? changes.reference : '000001',
    info: (changes.info ?? sample.info.map((item) => ({ ...item, tracking_id: OTHER }))) as Record<string, unknown>[] };
};
const reply = (...data: unknown[]) => ({ status: 200, message: 'SUCCESS', data });
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('DD Express numbers', () => {
  it('takes letters and digits with a digit, spaces and dashes as separators', () => {
    expect(normalizeDdExpressNumber(` ${SAMPLE.slice(0, 5)}-${SAMPLE.slice(5)} `)).toBe(SAMPLE);
    expect(normalizeDdExpressNumber('dd100000017')).toBe('DD100000017');
    for (const other of ['', '12345', 'ABCDEFGH', `${SAMPLE},${OTHER}`, `${SAMPLE}/1`, 'X1'.repeat(21)]) {
      expect(() => normalizeDdExpressNumber(other), other).toThrow('Enter the DD Express tracking number');
    }
  });

  it('reads a number from the tracker’s links, old and new', () => {
    for (const link of [`https://tracking.dd.express/v2/?tracking_ids=${SAMPLE}`, `https://tracking.dd.express/?tracking_ids=${SAMPLE}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: SAMPLE, carrier: 'dd-express', source: 'link' });
    }
  });
});

describe('DD Express tracking adapter', () => {
  it('asks the lookup behind the tracking page for the one number', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture(SAMPLE)));
    await expect(carrier(fetcher).track({ number: ` ${SAMPLE} ` })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${DD_EXPRESS_LOOKUP}?tracking_ids=${SAMPLE}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: expect.objectContaining({ Accept: 'application/json' }) });
    expect(init?.method ?? 'GET').toBe('GET');
    expect(carrier(fetcher)).toMatchObject({ id: 'dd-express', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads an empty parcel list as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('not-found')));
    await expect(carrier(fetcher).track({ number: OTHER })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps refusals, failures, pages and moved routes apart from a missing parcel', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: OTHER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    // The old tracker's lookup, apiv2.dd.express, answers every number so.
    const refused = { timestamp: '2026-11-27T03:51:20.703+00:00', status: 401, error: 'Unauthorized', message: '', path: `/tracking/query/${OTHER}` };
    expect(await answer(() => json(refused, { status: 401 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => json({ status: 500, message: 'ERROR', data: [] }))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => json({ status: 200, message: 'FAILED', data: [] }))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => json({ message: 'Too Many Requests' }, { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    const check = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    expect(await answer(() => new Response(check, { status: 403, headers: { 'Content-Type': 'text/html' } }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => new Response(check, { headers: { 'Content-Type': 'text/html' } }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => new Response('<html><body>nginx</body></html>', { headers: { 'Content-Type': 'text/html' } }))).toMatchObject({ kind: 'schema' });
    // The page's other hosts answer Cloudflare's origin errors.
    expect(await answer(() => new Response('error code: 521', { status: 521, headers: { 'Content-Type': 'text/plain' } })))
      .not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => new Response('<html>Not Found</html>', { status: 404, headers: { 'Content-Type': 'text/html' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: 'https://tracking.dd.express/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => new Response('{', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
  });
});

describe('DD Express replies', () => {
  it('reads the public sample: its statuses newest first, as instants, with the delivery', () => {
    const result = parseDdExpress(fixture(SAMPLE), SAMPLE);
    const event = (time: string, description: string, stage: string) => ({ time, description, stage, stage_source: 'carrier_map' });
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Parcel has been delivered', last_update: '2023-01-30T07:13:35.142Z', expected_delivery: null,
      delivered_at: '2023-01-30T07:13:35.142Z',
      events: [
        event('2023-01-30T07:13:35.142Z', 'Parcel has been delivered', 'delivered'),
        event('2023-01-17T10:44:50.160Z', 'Shipment Scheduled Out For Delivery', 'in_transit'),
        event('2023-01-17T10:23:43.916Z', 'Parcel has been collected', 'accepted'),
        event('2023-01-16T07:02:54.575Z', 'Shipment info received.', 'registered'),
      ],
    });
    expect(JSON.stringify(result)).not.toContain('325969');
  });

  it('answers its own parcel and no other, whatever the lookup found under the number', () => {
    // The lookup also finds a parcel by its shipper's reference, and lists it beside the one asked.
    expect(parseDdExpress(reply(parcel({ number: '90000000299', reference: OTHER }), parcel()), OTHER)).toMatchObject({ current_stage: 'delivered' });
    for (const data of [[parcel({ number: '90000000299', reference: OTHER })], [parcel({ number: null })], [parcel(), parcel()]]) {
      expect(() => parseDdExpress(reply(...data), OTHER), JSON.stringify(data).slice(0, 80)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    const stray = parcel({ info: [row('Parcel has been collected', '2024-05-02T01:00:00.000Z', { tracking_id: '90000000299' })] });
    expect(() => parseDdExpress(reply(stray), OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('dates a status by its own time when it has one, keeps its photos out and stages new wording by the shared rules', () => {
    const result = parseDdExpress(reply(parcel({ info: [
      row('Parcel has been collected', '2024-05-02T01:00:00.000Z'),
      row('Out for delivery', '2024-05-03T00:30:00.000Z', { images: ['https://example.com/pod.jpg'] }),
      row('Parcel has been delivered', '2024-05-03T09:00:00.000Z', { status_time: '2024-05-03T14:15:00+08:00', images: ['https://example.com/pod.jpg'] }),
      row('Remark updated', '2024-05-03T01:00:00.000Z'),
    ] })), OTHER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2024-05-03T14:15:00+08:00',
      last_status_text: 'Parcel has been delivered', last_update: '2024-05-03T14:15:00+08:00' });
    expect(result.events).toEqual([
      { time: '2024-05-03T14:15:00+08:00', description: 'Parcel has been delivered', written_at: '2024-05-03T09:00:00Z', stage: 'delivered', stage_source: 'carrier_map' },
      { time: '2024-05-03T01:00:00Z', description: 'Remark updated' },
      { time: '2024-05-03T00:30:00Z', description: 'Out for delivery', stage: 'out_for_delivery', stage_source: expect.stringMatching(/^wording:/) },
      { time: '2024-05-02T01:00:00Z', description: 'Parcel has been collected', stage: 'accepted', stage_source: 'carrier_map' },
    ]);
    expect(JSON.stringify(result)).not.toContain('example.com');
  });

  it('reads a parcel without statuses as no history', () => {
    for (const info of [[], undefined]) {
      expect(() => parseDdExpress(reply({ ...parcel(), info }), OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
    }
  });

  it('refuses a changed reply', () => {
    for (const changed of [null, {}, { status: '200', message: 'SUCCESS', data: [] }, { status: 200, message: 'SUCCESS', data: null },
      { status: 200, message: 'SUCCESS', data: {} }, reply(null), reply(parcel({ info: {} as unknown[] })), reply(parcel({ info: [null] })),
      reply(parcel({ info: [row('', '2024-05-02T01:00:00.000Z')] })), reply(parcel({ info: [row(['Parcel has been delivered'], '2024-05-02T01:00:00.000Z')] })),
      reply(parcel({ info: [row('Parcel has been collected', '2024-05-02 01:00:00')] })), reply(parcel({ info: [row('Parcel has been collected', null)] })),
      reply(parcel({ info: [row('Parcel has been collected', '2024-05-02T01:00:00Z', { status_time: '2024-05-02 09:00' })] })),
      reply(parcel({ info: Array.from({ length: 301 }, () => row('Parcel has been collected', '2024-05-02T01:00:00Z')) })),
      reply(...Array.from({ length: 51 }, () => parcel()))]) {
      expect(() => parseDdExpress(changed, OTHER), JSON.stringify(changed)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('DD Express statuses', () => {
  it('maps each wording it records, with or without the tracker’s stray bracket', () => {
    for (const entry of statuses.entries) {
      for (const wording of [entry.wording, `[${entry.wording} `]) {
        expect(statusMap.stage(null, wording.toLowerCase()), wording).toBe(entry.stage);
        expect(statusMapAnswer({ carrier: 'dd-express', providerCode: null, description: ddExpressWording(wording) })).toMatchObject({ stage: entry.stage });
      }
    }
    expect(statusMap.stage(null, 'anything')).toBeUndefined();
    expect(ddExpressWording('[On hold] at hub')).toBe('[On hold] at hub');
  });
});
