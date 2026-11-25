import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { rtb56Json } from '../yypost/rtb56.js';
import { adapter, CHENGCHAIN_API, CHENGCHAIN_CALLBACK, ChengchainTracker, chengchainLookupUrl } from './adapter.js';
import { normalizeChengchainNumber, parseChengchain } from './parser.js';
import { chengchainStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample from an archived capture of ParcelPanel's ChengChain page.
const SAMPLE = 'CC2640007786GY';
type Name = 'cancelled' | 'not-found';
const raw = (name: Name) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
interface Reply { data: { server_hawbcode: unknown; channel_hawbcode: unknown;
  details: { track_occur_date: unknown; track_description_en: unknown; gmt_offset: unknown }[] }[] }
const fixture = (name: Name) => rtb56Json(raw(name), CHENGCHAIN_CALLBACK, 'test') as Reply;
const changed = (change: (reply: Reply) => void) => { const reply = fixture('cancelled'); change(reply); return reply; };
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });

describe('Chengchuang Supply Chain numbers', () => {
  it('offers no carrier for the waybill alone and reads the number out of a link to its tracking page', () => {
    expect(detectCarrierMatch(SAMPLE).candidates ?? []).not.toContain('chengchain');
    expect(parseTrackingInput(`http://zjcc.rtb56.com/track_query.aspx?track_number=${SAMPLE}`))
      .toMatchObject({ trackingNumber: SAMPLE, carrier: 'chengchain' });
  });
});

describe('Chengchuang Supply Chain tracking lookup', () => {
  it('asks the tenant’s lookup for the whole waybill without naming a referring page', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('cancelled')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new ChengchainTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' cc 2640-0077-86 gy ', { budgetMs: 5000 });
    expect(result.current_stage).toBe('exception');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(chengchainLookupUrl(SAMPLE));
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(CHENGCHAIN_API);
    expect(asked.protocol).toBe('http:');
    expect(Object.fromEntries(asked.searchParams)).toMatchObject({ callbackparam: CHENGCHAIN_CALLBACK, method: 'track',
      param: JSON.stringify({ sp: '', nums: [SAMPLE] }) });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    // Another tenant of the platform answers null to a request that names a referring page.
    expect(Object.keys((init as RequestInit).headers as Record<string, string>).map((key) => key.toLowerCase())).not.toContain('referer');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'chengchain', step: 'direct', outcome: 'ok' }));
  });

  it('reads a parcel whose delivering label was cancelled, on the wall clocks its scans give, in the tracker’s order', () => {
    const result = parseChengchain(fixture('cancelled'), SAMPLE);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map',
      last_status_text: 'Label Cancelled', last_update: null, last_update_local: '2026-06-22T00:51:05', expected_delivery: null,
      destination_country: 'US' });
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(result.events).toHaveLength(34);
    expect(result.events![1]).toMatchObject({ local_time: '2026-06-11T10:52:41', location: 'US', description: 'The shipment is in domestic transit', stage: 'in_transit' });
    expect(result.events!.at(-1)).toMatchObject({ local_time: '2026-04-29T18:47:15', description: 'Shipment information received', stage: 'registered' });
    expect(result.events!.at(-2)).toMatchObject({ location: 'YIWU', description: 'Shipment arrived at facility', stage: 'accepted' });
    expect(result.events!.every((event) => event.local_time && !event.time && !event.provider_code)).toBe(true);
    const at = result.events!.map((event) => event.local_time!);
    expect(at).toEqual([...at].sort().reverse());
    // The merchant's reference is never read.
    expect(JSON.stringify(result)).not.toMatch(/XM0000000000/);
  });

  it('keeps the delivering network’s label and the line’s data record without a stage, so they move nothing', () => {
    const label = parseChengchain(changed((reply) => { reply.data[0]!.details.splice(0, 30); }), SAMPLE);
    expect(label.events![0]).toMatchObject({ description: 'Shipping Label Created' });
    expect(label.events![0]).not.toHaveProperty('stage');
    expect(label).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Shipping Label Created' });
    const record = parseChengchain(changed((reply) => { reply.data[0]!.details.splice(0, 28); }), SAMPLE);
    expect(record.events!.slice(0, 2).map((event) => [event.description, event.stage])).toEqual([
      ['The electronic information of the goods has been received', undefined],
      ['The goods have been sent to the next station', 'in_transit'],
    ]);
    expect(record).toMatchObject({ current_stage: 'in_transit' });
  });

  it('keeps the delivering network’s number once the line gives one, without naming the network', () => {
    const onward = (channel: string) => parseChengchain(changed((reply) => { reply.data[0]!.channel_hawbcode = channel; }), SAMPLE);
    expect(onward('GFUS01000000000000')).toMatchObject({ delivery_tracking_number: 'GFUS01000000000000' });
    expect(onward('GFUS01000000000000')).not.toHaveProperty('delivery_carrier');
    for (const channel of ['', SAMPLE, 'https://example.invalid/x']) {
      expect(onward(channel), channel).not.toHaveProperty('delivery_tracking_number');
    }
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseChengchain(fixture('not-found'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseChengchain(null, SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseChengchain(changed((r) => { r.data[0]!.server_hawbcode = 'ZZ0000000000ZZ'; }), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseChengchain(changed((r) => { r.data.push(r.data[0]!); }), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseChengchain({ success: 0, enmessage: 'Try again later' }, SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseChengchain(changed((r) => { r.data[0]!.details = []; }), SAMPLE)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseChengchain(changed((r) => { r.data[0]!.details[0]!.track_occur_date = '2026-06-31 00:51:05'; }), SAMPLE))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseChengchain(changed((r) => { r.data[0]!.details[0]!.track_description_en = 42; }), SAMPLE))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new ChengchainTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(SAMPLE, { budgetMs: 5000 });
    await expect(lookup(raw('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('null')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(raw('cancelled'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>验证码</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('retries only a request that fails to reach the tracker', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('synthetic network'))
      .mockResolvedValueOnce(response(raw('cancelled')));
    await expect(new ChengchainTracker({ fetcher: flaky }).fetch(SAMPLE, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'exception' });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('accepts the waybill shape only, without a request', async () => {
    expect(normalizeChengchainNumber('cc2640007786gy')).toBe(SAMPLE);
    for (const number of ['2640007786', 'CC264000778GY', 'CC26400077860GY', 'CC2640007786', 'CC2640007786CN', 'C2640007786GY', 'ZZ0000000000ZZ']) {
      expect(() => normalizeChengchainNumber(number), number).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new ChengchainTracker({ fetcher }).fetch('LA123456789CN')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'chengchain', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('recognizes by the same lookup', async () => {
    const known = vi.fn<typeof fetch>().mockResolvedValue(response(raw('cancelled')));
    await expect(adapter({ fetcher: known, recorder: NOOP_RECORDER } as never).recognize!(SAMPLE)).resolves.toMatchObject({ known: true });
    const unknown = vi.fn<typeof fetch>().mockResolvedValue(response(raw('not-found')));
    await expect(adapter({ fetcher: unknown, recorder: NOOP_RECORDER } as never).recognize!(SAMPLE)).resolves.toEqual({ known: false });
  });

  it('maps every wording it lists, the records after dispatch to nothing', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe('stage' in entry ? entry.stage : undefined);
    }
    expect(statusMap.gaps.map((gap) => gap.wording)).toEqual(['shipping label created', 'the electronic information of the goods has been received']);
    expect(chengchainStage('Shipping Label Created')).toBeNull();
    expect(chengchainStage('仓库作业')).toBeNull();
  });
});
