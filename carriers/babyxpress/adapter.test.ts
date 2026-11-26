import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { DELYVA_TRACK, DelyvaTracker } from './delyva.js';
import { BABYXPRESS, normalizeBabyXpressNumber, parseBabyXpress } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public samples' replies; the tests derive invented consignments from them.
const SAMPLE = 'SC0060659', HUB_SAMPLE = 'SC0060117';
const NUMBER = 'SC9900001';

type Order = Record<string, unknown> & { histories: Record<string, unknown>[] };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as { data: Order };
/** The first sample's order under an invented number, with its fields and scans replaced when given. */
const order = (changes: Partial<Order> = {}, number = NUMBER) => {
  const { data } = fixture(`consignment-${SAMPLE}`);
  const histories = data.histories.map((row) => ({ ...row, consignmentNo: number }));
  return { data: { ...data, consignmentNo: number, histories, ...changes } };
};
const scan = (statusCode: number, createdAt: string, extra: Record<string, unknown> = {}) =>
  ({ consignmentNo: NUMBER, statusCode, statusText: '', description: null, location: '-', createdAt, ...extra });
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('BabyXpress numbers', () => {
  it('takes letters and digits, as the tracker does', () => {
    expect(normalizeBabyXpressNumber(` ${SAMPLE.toLowerCase()} `)).toBe(SAMPLE);
    for (const other of ['', 'SC1', 'SCSCSCSC', 'SC00606!9', `SC${'1'.repeat(40)}`]) {
      expect(() => normalizeBabyXpressNumber(other), other).toThrow('BabyXpress consignment number');
    }
  });

  it('refuses a tenant whose company id is not a GUID', () => {
    expect(() => new DelyvaTracker({ ...BABYXPRESS, companyId: 'babyxpress-my' })).toThrow('not a GUID');
  });
});

describe('BabyXpress tracking adapter', () => {
  it('posts the number with the tenant’s company id, as its tracker page does', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture(`consignment-${SAMPLE}`)));
    await expect(carrier(fetcher).track({ number: SAMPLE.toLowerCase() })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(DELYVA_TRACK);
    expect(JSON.parse(String(init!.body))).toEqual({ companyId: 'f273c9c9-6420-42d8-84ce-a83fc3b96fde', consignmentNo: SAMPLE, resultType: 'latestFirst' });
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: expect.objectContaining({ 'Content-Type': 'application/json' }) });
    expect(carrier(fetcher)).toMatchObject({ id: 'babyxpress', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the service’s false data as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('not-found')));
    await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps refusals, error pages and bot checks apart from a missing consignment', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: NUMBER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    expect(await answer(() => json({}, { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => json({ error: { message: '"companyId" must be a valid GUID' } }, { status: 400 }))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => new Response('<h1>Bad Gateway</h1>', { status: 502, headers: { 'Content-Type': 'text/html' } })))
      .not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => new Response('<title>Just a moment...</title>', { headers: { 'Content-Type': 'text/html' } }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response('{', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response(null, { status: 204 }))).toMatchObject({ kind: 'transport' });
    for (const status of [404, 410]) {
      expect(await answer(() => new Response('<h1>Not Found</h1>', { status, headers: { 'Content-Type': 'text/html' } }))).toMatchObject({ kind: 'transport' });
    }
  });
});

describe('BabyXpress replies', () => {
  it('reads the public sample: its scans at their instants, the branches and the country it went to', () => {
    const result = parseBabyXpress(fixture(`consignment-${SAMPLE}`), SAMPLE);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', provider_code: '700',
      last_status_text: 'Delivered', last_update: '2023-01-04T03:54:47Z', expected_delivery: null,
      delivered_at: '2023-01-04T03:54:47Z', destination_country: 'MY',
      events: [
        { time: '2023-01-04T03:54:47Z', description: 'Delivery success', provider_code: '700', stage: 'delivered', stage_source: 'carrier_map' },
        { time: '2022-12-29T01:16:33Z', description: 'Arrived at branch', location: 'BX Kudat (BBXS13)',
          original_description: 'Arrived at branch - BX Kudat (BBXS13)', provider_code: '555', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2022-12-19T08:12:29Z', description: 'Departed from branch', location: 'BX Tawau (BBXS34)',
          original_description: 'Departed from branch - BX Tawau (BBXS34)', provider_code: '556', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2022-12-19T08:12:17Z', description: 'Arrived at branch', location: 'BX Tawau (BBXS34)',
          original_description: 'Arrived at branch - BX Tawau (BBXS34)', provider_code: '555', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2022-12-19T08:04:32Z', description: 'Order ready', provider_code: '110', stage: 'registered', stage_source: 'carrier_map' },
        { time: '2022-12-19T08:04:22Z', description: 'Record created', provider_code: '100', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
  });

  it('keeps a branch the company names after itself', () => {
    const result = parseBabyXpress(fixture(`consignment-${HUB_SAMPLE}`), HUB_SAMPLE);
    expect(result.events).toHaveLength(9);
    expect(result.events!.map((event) => event.location ?? null)).toEqual([null, 'BX Kota Belud (BBXS17)', 'BX Kota Belud (BBXS17)',
      'Baby Xpress Sdn.Bhd', 'Baby Xpress Sdn.Bhd', 'BX Penampang (BBXS02)', 'BX Penampang (BBXS02)', null, null]);
  });

  it('leaves the delivering staff and any other note behind, and keeps the status text', () => {
    const result = parseBabyXpress(order({ statusCode: 650, statusText: 'Failed', histories: [
      scan(650, '2023-01-05T02:00:00.000Z', { statusText: 'Failed', description: 'Recipient Example Person not at home - Example Street' }),
      scan(700, '2023-01-04T03:54:47.625Z', { statusText: 'Delivered', description: 'Delivery success - Example Driver' }),
      scan(600, '2023-01-04T01:00:00.000Z', { description: 'Out with Example Driver' }),
    ] }), NUMBER);
    expect(result).toMatchObject({ current_stage: 'failed_attempt', provider_code: '650', last_status_text: 'Failed' });
    expect(result.delivered_at).toBeUndefined();
    expect(result.events).toEqual([
      { time: '2023-01-05T02:00:00Z', description: 'Failed', provider_code: '650', stage: 'failed_attempt', stage_source: 'carrier_map' },
      { time: '2023-01-04T03:54:47Z', description: 'Delivery success', provider_code: '700', stage: 'delivered', stage_source: 'carrier_map' },
      { time: '2023-01-04T01:00:00Z', description: 'In transit / delivery start', provider_code: '600', stage: 'out_for_delivery', stage_source: 'carrier_map' },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Example|phone|coord/);
  });

  it('keeps the stage of the scan before a code that sets none, and answers an order without scans by its status', () => {
    const closed = parseBabyXpress(order({ statusCode: 1000, statusText: '', histories: [
      scan(1000, '2023-01-06T00:00:00.000Z'), scan(701, '2023-01-05T00:00:00.000Z', { statusText: 'Return successful' }),
    ] }), NUMBER);
    expect(closed).toMatchObject({ current_stage: 'returned', provider_code: '1000', last_status_text: 'Order completed' });
    expect(closed.events![0]).toEqual({ time: '2023-01-06T00:00:00Z', description: 'Order completed', provider_code: '1000' });
    expect(parseBabyXpress(order({ statusCode: 100, statusText: 'Record created', histories: [] }), NUMBER))
      .toMatchObject({ status: 'pending', current_stage: 'registered', summary_only: true, events: [] });
    expect(parseBabyXpress(order({ statusCode: 1000, histories: [] }), NUMBER)).toMatchObject({ status: 'unknown', summary_only: true });
  });

  it('answers only for the number and the company asked', () => {
    expect(() => parseBabyXpress(order({}, 'SC9900002'), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseBabyXpress(order({ companyId: '00000000-0000-4000-8000-000000000000' }), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseBabyXpress(order({ histories: [scan(100, '2023-01-01T00:00:00.000Z', { consignmentNo: 'SC9900002' })] }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps a long courier note to its first characters instead of refusing the history', () => {
    const reply = order({ histories: [scan(700, '2023-01-04T03:54:47Z', { description: `Delivery success - ${'x'.repeat(400)}` })] });
    expect(parseBabyXpress(reply, NUMBER).events?.[0]).toMatchObject({ stage: 'delivered' });
  });

  it('refuses a changed reply', () => {
    for (const reply of [null, {}, { data: true }, { data: [] }, order({ statusCode: '700' }), order({ histories: {} as never }),
      order({ histories: [scan(700, '2023-01-04 03:54:47')] }), order({ histories: [scan(700, '2023-01-04T03:54:47+08:00')] }),
      order({ histories: [scan(700.5, '2023-01-04T03:54:47Z')] }), order({ histories: ['row' as never] }),
      order({ histories: [scan(700, '2023-01-04T03:54:47Z', { description: 7 })] })]) {
      expect(() => parseBabyXpress(reply, NUMBER), JSON.stringify(reply)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('BabyXpress statuses', () => {
  it('maps each Delyva code it records, and leaves the codes that set no stage as gaps', () => {
    for (const entry of statuses.entries) {
      const stage = (entry as { stage?: string }).stage;
      expect(statusMap.stage(entry.code, entry.wording), `${entry.code} ${entry.wording}`).toBe(stage);
      expect(statusMapAnswer({ carrier: 'babyxpress', providerCode: entry.code, description: entry.wording }), entry.code)
        .toMatchObject(stage ? { stage } : { kind: 'intentional_gap' });
    }
    expect(statusMap.stage('123', 'anything')).toBeUndefined();
    expect(statusMap.stage(null, 'Delivered')).toBeUndefined();
  });
});
