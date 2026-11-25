import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { rtb56Json } from '../yypost/rtb56.js';
import { adapter, SZCTC_API, SZCTC_CALLBACK, SzctcTracker, szctcLookupUrl } from './adapter.js';
import { normalizeSzctcNumber, parseSzctc } from './parser.js';
import { statusMap, szctcStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample from an archived capture of ParcelPanel's CTC page.
const SAMPLE = 'CTC202617802729';
type Name = 'hold' | 'not-found';
const raw = (name: Name) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
interface Reply { data: { server_hawbcode: unknown; channel_hawbcode: unknown; details: { track_occur_date: unknown; track_description_en: unknown }[] }[] }
const fixture = (name: Name) => rtb56Json(raw(name), SZCTC_CALLBACK, 'test') as Reply;
const changed = (change: (reply: Reply) => void) => { const reply = fixture('hold'); change(reply); return reply; };
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });

describe('CTC Supply Chain numbers', () => {
  it('offers no carrier for the waybill alone and reads the number out of a link to its tracking page', () => {
    expect(detectCarrierMatch(SAMPLE).candidates ?? []).not.toContain('szctc');
    // The tracking box on CTC's home page opens the page with `nums`.
    expect(parseTrackingInput(`http://szctc.rtb56.com/track_query.aspx?nums=${SAMPLE}`)).toMatchObject({ trackingNumber: SAMPLE, carrier: 'szctc' });
    expect(parseTrackingInput(`http://szctc.rtb56.com/track_query.aspx?track_number=${SAMPLE}`)).toMatchObject({ trackingNumber: SAMPLE, carrier: 'szctc' });
  });
});

describe('CTC Supply Chain tracking lookup', () => {
  it('asks the tenant’s lookup for the whole waybill without naming a referring page', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('hold')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new SzctcTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' ctc 2026-1780-2729 ', { budgetMs: 5000 });
    expect(result.current_stage).toBe('exception');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(szctcLookupUrl(SAMPLE));
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(SZCTC_API);
    expect(asked.protocol).toBe('http:');
    expect(Object.fromEntries(asked.searchParams)).toMatchObject({ callbackparam: SZCTC_CALLBACK, method: 'track',
      param: JSON.stringify({ sp: '', nums: [SAMPLE] }) });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    // Another tenant of the platform answers null to a request that names a referring page.
    expect(Object.keys((init as RequestInit).headers as Record<string, string>).map((key) => key.toLowerCase())).not.toContain('referer');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'szctc', step: 'direct', outcome: 'ok' }));
  });

  it('reads a parcel GOFO holds for instructions, on the offsets its scans state, and hands it to GOFO', () => {
    const result = parseSzctc(fixture('hold'), SAMPLE);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map',
      last_status_text: 'Hold for Instructions Requested.', last_update: '2026-04-14T08:57:45-04:00', expected_delivery: null,
      destination_country: 'US', delivery_carrier: 'gofo', delivery_tracking_number: 'GFUS01043163223170' });
    expect(result.events).toHaveLength(33);
    expect(result.events!.slice(4, 6).map(({ time, location, description, stage }) => [time, location, description, stage])).toEqual([
      ['2026-04-07T16:40:21-04:00', undefined, 'Delivery Exception, Incorrect/Insufficient Address.', 'failed_attempt'],
      ['2026-04-07T06:11:22-04:00', 'Travelers Rest, SC', 'Out for Delivery', 'out_for_delivery'],
    ]);
    expect(result.events!.at(-1)).toMatchObject({ time: '2026-03-27T20:12:04+08:00', description: 'Shipment information received', stage: 'registered' });
    expect(result.events!.every((event) => event.time && !event.local_time && !event.provider_code)).toBe(true);
    // GOFO's support line is dropped, and the merchant's reference never read.
    expect(JSON.stringify(result)).not.toMatch(/GOFO at|gofoexpress|XM0000000000/);
  });

  it('keeps the line’s record of the parcel’s data without a stage, so it moves nothing', () => {
    const result = parseSzctc(changed((reply) => { reply.data[0]!.details.splice(0, 28); }), SAMPLE);
    expect(result.events![0]).toMatchObject({ description: 'Parcel Data Received' });
    expect(result.events![0]).not.toHaveProperty('stage');
    expect(result).toMatchObject({ current_stage: 'accepted', last_status_text: 'Parcel Data Received' });
  });

  it('names GOFO only for a number its rule claims whole', () => {
    const onward = (channel: string) => parseSzctc(changed((reply) => { reply.data[0]!.channel_hawbcode = channel; }), SAMPLE);
    // GOFO's older series, which detection only suggests, and another network's number.
    expect(onward('GF1000000000000')).toMatchObject({ delivery_tracking_number: 'GF1000000000000' });
    expect(onward('GF1000000000000')).not.toHaveProperty('delivery_carrier');
    expect(onward('1Z999AA10123456784')).toMatchObject({ delivery_tracking_number: '1Z999AA10123456784' });
    expect(onward('1Z999AA10123456784')).not.toHaveProperty('delivery_carrier');
    for (const channel of ['', SAMPLE, 'https://example.invalid/x']) {
      expect(onward(channel), channel).not.toHaveProperty('delivery_tracking_number');
    }
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseSzctc(fixture('not-found'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseSzctc(null, SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseSzctc(changed((r) => { r.data[0]!.server_hawbcode = 'CTC202600000000'; }), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSzctc(changed((r) => { r.data.push(r.data[0]!); }), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSzctc({ success: 0, enmessage: 'Try again later' }, SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseSzctc(changed((r) => { r.data[0]!.details = []; }), SAMPLE)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseSzctc(changed((r) => { r.data[0]!.details[0]!.track_occur_date = '2026-04-31 08:57:45'; }), SAMPLE))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSzctc(changed((r) => { r.data[0]!.details[0]!.track_description_en = 42; }), SAMPLE))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new SzctcTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(SAMPLE, { budgetMs: 5000 });
    await expect(lookup(raw('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('null')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(raw('hold'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>验证码</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('retries only a request that fails to reach the tracker', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('synthetic network'))
      .mockResolvedValueOnce(response(raw('hold')));
    await expect(new SzctcTracker({ fetcher: flaky }).fetch(SAMPLE, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'exception' });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('accepts the waybill shape only, without a request', async () => {
    expect(normalizeSzctcNumber('ctc202617802729')).toBe(SAMPLE);
    for (const number of ['202617802729', 'CTC20261780272', 'CTC2026178027290', 'CTE202617802729', 'CTC20261780272A', 'ZZ0000000000ZZ']) {
      expect(() => normalizeSzctcNumber(number), number).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new SzctcTracker({ fetcher }).fetch('LA123456789CN')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'szctc', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('recognizes by the same lookup', async () => {
    const known = vi.fn<typeof fetch>().mockResolvedValue(response(raw('hold')));
    await expect(adapter({ fetcher: known, recorder: NOOP_RECORDER } as never).recognize!(SAMPLE)).resolves.toMatchObject({ known: true });
    const unknown = vi.fn<typeof fetch>().mockResolvedValue(response(raw('not-found')));
    await expect(adapter({ fetcher: unknown, recorder: NOOP_RECORDER } as never).recognize!(SAMPLE)).resolves.toEqual({ known: false });
  });

  it('maps every wording it lists, reading the numbers and reasons after a wording as an ellipsis', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe('stage' in entry ? entry.stage : undefined);
    }
    expect(statusMap.gaps).toEqual([expect.objectContaining({ wording: 'parcel data received' })]);
    expect(statusMap.stage(null, 'delivery exception, business closed.')).toBe('failed_attempt');
    expect(statusMap.stage(null, 'departed from export center. tracking no gfus01000000000000')).toBe('in_transit');
    expect(szctcStage('Parcel Data Received')).toBeNull();
    expect(szctcStage('仓库作业')).toBeNull();
  });
});
