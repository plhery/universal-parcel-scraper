import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { languageStageStatus, STAGES } from '../../core/status/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, MASSPACK, masspackTracker } from './adapter.js';
import { auOpsUrl, normalizeAuOpsNumber, parseAuOps, parseAuOpsReply } from './auOps.js';
import { auOpsNode, auOpsState } from './auOpsStatus.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// A synthetic number: no public page shows a Masspack order.
const NUMBER = 'MP0000000001';
// UPS's documented example number, as the order's synthetic hand-over.
const UPS = '1Z999AA10123456784';
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const changed = (edit: (order: ReturnType<typeof fixture>[number]) => void) => { const reply = fixture('synthetic-order'); edit(reply[0]); return reply; };
const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(typeof data === 'string' ? data : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const parse = (reply: unknown, language: 'en' | 'zh' = 'en') => parseAuOps(MASSPACK, reply, NUMBER, language);
const row = (node: unknown, eventTime: unknown, context: unknown = null) => ({ node, context, time: '2026-03-02 09:05', eventTime });

describe('Masspack Express tracking adapter', () => {
  it('asks the tenant’s tracker for the whole number once, with the supplied transport and budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('synthetic-order')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    const result = await masspackTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1' }).fetch(` ${NUMBER.toLowerCase()} `, { budgetMs: 4000 });
    expect(result.events).toHaveLength(6);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://mp.masspack-express.com/edi/pubTracking?soNum=${NUMBER}&url=%2Fpublic-tracking&host=mp.masspack-express.com&noSubTracking=true`);
    expect(String(url)).toBe(auOpsUrl(MASSPACK.host, NUMBER));
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal),
      headers: expect.objectContaining({ Accept: 'application/json, text/plain, */*', 'User-Agent': 'SyntheticHost/1' }) });
    expect(init!.method ?? 'GET').toBe('GET');
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'masspack', step: 'direct', outcome: 'ok' }));
    expect(carrier(fetcher)).toMatchObject({ id: 'masspack', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('words the rows in Chinese for a Chinese reader', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('synthetic-order')));
    const result = await carrier(fetcher).track({ number: NUMBER, language: 'zh-CN' });
    expect(result).toMatchObject({ last_status_text: '派送中' });
    expect(result.events!.map((event) => event.description)).toContain('海关放行(进口)');
  });

  it('refuses a number the tracker does not take without asking', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: 'MP01' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    for (const number of ['', 'MP01', 'ABCDEFGHIJ', 'MP0000000001?', 'MP 0000/0001', `${'A'.repeat(40)}1`, 'X'.repeat(70)]) {
      expect(() => normalizeAuOpsNumber('masspack', number), number).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    for (const number of [NUMBER, 'mp0000000001', '123456', 'MP-0000-000-001']) expect(normalizeAuOpsNumber('masspack', ` ${number} `)).toMatch(/^[A-Z0-9]+$/);
  });

  it('reads the order the service marks as not found as a missing one', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('not-found')));
    await expect(carrier(fetcher).track({ number: '0000000000' })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([[401, 'challenge'], [403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [404, 'transport'], [302, 'transport']] as const)(
    'keeps HTTP %i apart from a missing order, without another request', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
        status === 302 ? new Response(null, { status, headers: { Location: '/' } }) : json(fixture('not-found'), status, { 'retry-after': '60' }));
      await expect(carrier(fetcher).track({ number: '0000000000' }, { budgetMs: 2000 })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    });

  it('reads a verification page as a challenge and another page as a changed service', async () => {
    const answer = async (body: string) => carrier(vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(body, { headers: { 'Content-Type': 'text/html' } }))).track({ number: NUMBER }).catch((error: unknown) => error);
    expect(await answer('<title>Just a moment...</title><script>window._cf_chl_opt={}</script>')).toMatchObject({ kind: 'challenge' });
    expect(await answer('<html><head><title>滑动验证</title></head></html>')).toMatchObject({ kind: 'challenge' });
    expect(await answer('<!DOCTYPE html><html ng-app="autopsApp"><head><title>AU-OPS</title></head><body><div ui-view></div></body></html>')).toMatchObject({ kind: 'schema' });
    expect(await answer('')).toMatchObject({ kind: 'schema' });
    expect(() => parseAuOpsReply(MASSPACK, 200, JSON.stringify(fixture('not-found')), '0000000000')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('honors cancellation before I/O and in a pending request', async () => {
    const before = new AbortController(); before.abort(); const never = vi.fn();
    await expect(masspackTracker({ fetcher: never }).fetch(NUMBER, { signal: before.signal })).rejects.toThrow();
    expect(never).not.toHaveBeenCalled();
    const during = new AbortController();
    const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }); during.abort(new Error('synthetic cancellation'));
    });
    await expect(masspackTracker({ fetcher }).fetch(NUMBER, { signal: during.signal })).rejects.toThrow('synthetic cancellation');
  });

  it('routes an explicit selection, proposes the hand-over, and offers no number rule', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      new URL(String(url)).host === MASSPACK.host ? json(fixture('synthetic-order')) : new Response('', { status: 503 }));
    const answer = await createTracker({ fetcher, env: {}, providers: [] }).track({ carrier: 'masspack', number: NUMBER });
    expect(answer).toMatchObject({ carrier: 'masspack', source: 'masspack', result: { delivery_carrier: 'ups', delivery_tracking_number: UPS } });
    expect(answer.result.events).toHaveLength(6);
    expect(new URL(String(fetcher.mock.calls[0]![0])).host).toBe(MASSPACK.host);
    expect(detectCarrierMatch(NUMBER).candidates ?? []).not.toContain('masspack');
    expect(recognitionCandidates(NUMBER).map((candidate) => candidate.carrier)).not.toContain('masspack');
  });
});

describe('Masspack Express replies', () => {
  it('reads the order’s state, its rows newest first and the number it was handed over under', () => {
    const result = parse(fixture('synthetic-order'));
    expect(result).toMatchObject({ status: languageStageStatus('out_for_delivery'), current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      last_status_text: 'Dispatching', provider_code: '5', last_update: '2026-03-11T03:00:00Z', expected_delivery: null,
      delivery_carrier: 'ups', delivery_tracking_number: UPS, destination_country: 'US',
      planned_events: [{ time: '2026-03-12T00:00:00Z', description: 'Estimated arrival at Los Angeles' }] });
    expect(result.events!.map((event) => [event.time, event.description, event.provider_code, event.stage])).toEqual([
      ['2026-03-11T03:00:00Z', 'Handed to UPS for delivery', 'transferOut', 'in_transit'],
      // A row without a context shows its node's wording; its clock keeps the offset the reply gives.
      ['2026-03-10T20:00:00+08:00', 'Import Cleared', 'customCleared', 'in_transit'],
      [expect.stringMatching(/^2026-03-10T08:00:00(?:\.000)?Z$/), 'Arrived at Los Angeles', 'arrivedPod', 'in_transit'],
      ['2026-03-04T15:20:00Z', 'Departed Shenzhen Flight SYN001', 'atd', 'in_transit'],
      ['2026-03-02T09:30:00Z', 'Cargo received at the Shenzhen warehouse', 'wmsIn', 'accepted'],
      ['2026-03-02T01:05:00Z', '订单已确认', 'confirm', 'registered'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !('local_time' in event))).toBe(true);
    expect(result.delivered_at).toBeUndefined();
    // The order's references, carton count and proof of delivery stay out.
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETICPO|SYNJOB|9000001|9100001|recordingTime/);
  });

  it('lets a row further along, or a delivery, outrank the state, and reads the rows alone when the state says least', () => {
    const delivered = parse(changed((order) => { order.trackings.push(row('Deliveried', '2026-03-12T05:00:00Z', 'Signed')); }));
    expect(delivered).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Signed', delivered_at: '2026-03-12T05:00:00Z' });
    expect(delivered.provider_code).toBeUndefined();
    const taken = parse(changed((order) => { order.state = '1'; }));
    expect(taken).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Handed to UPS for delivery' });
    expect(taken.provider_code).toBeUndefined();
    for (const state of ['0', '', null, '99']) {
      const result = parse(changed((order) => { order.state = state; }));
      expect(result, String(state)).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Handed to UPS for delivery' });
      expect(result.provider_code).toBeUndefined();
    }
    expect(parse(changed((order) => { order.state = '2'; }))).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'Difficult', provider_code: '2' });
    expect(parse(changed((order) => { order.state = '3'; }))).toMatchObject({ status: 'delivered', provider_code: '3' });
    // A row that waits for an update moves nothing.
    const waiting = parse(changed((order) => { order.state = '0'; order.trackings.push(row('waiting', '2026-03-12T05:00:00Z')); }));
    expect(waiting).toMatchObject({ current_stage: 'in_transit', last_status_text: 'To be updated' });
    expect(waiting.events![0]).toEqual({ time: '2026-03-12T05:00:00Z', description: 'To be updated', provider_code: 'waiting' });
  });

  it('keeps a node of the tenant’s own and reads its wording by the shared rules', () => {
    const result = parse(changed((order) => {
      order.state = '0';
      order.trackings = [row('lastMile', '2026-03-11T03:00:00Z', 'Out for delivery'), row('remark', '2026-03-10T03:00:00Z', 'Synthetic remark'), row(null, '2026-03-09T03:00:00Z', 'Departed')];
    }));
    expect(result.events!.map((event) => [event.provider_code, event.description])).toEqual([['lastMile', 'Out for delivery'], ['remark', 'Synthetic remark'], [undefined, 'Departed']]);
    expect(result.events![0]!.stage).toBe('out_for_delivery');
    expect(result.events![0]!.stage_source).toMatch(/^wording/);
    expect(result.events![1]!.stage).toBeUndefined();
    expect(result.current_stage).toBe('out_for_delivery');
  });

  it('keeps the order of rows on one clock, whichever way the reply lists them', () => {
    const steps = [row('wmsIn', '2026-03-02T09:30:00Z'), row('checkOut', '2026-03-02T09:30:00Z'), row('atd', '2026-03-04T15:20:00Z')];
    const oldestFirst = parse(changed((order) => { order.trackings = steps; }));
    const newestFirst = parse(changed((order) => { order.trackings = [...steps].reverse(); }));
    expect(oldestFirst.events!.map((event) => event.provider_code)).toEqual(['atd', 'checkOut', 'wmsIn']);
    expect(newestFirst.events!.map((event) => event.provider_code)).toEqual(['atd', 'checkOut', 'wmsIn']);
    expect(parse(changed((order) => { order.trackings = [row('atd', 1772637600000)]; })).events![0]!.time).toMatch(/^2026-03-04T15:20:00(?:\.000)?Z$/);
  });

  it('reads a listed order without a row from its state, else as no history', () => {
    const summary = parse(changed((order) => { order.state = '3'; order.trackings = []; }));
    expect(summary).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Deliveried', provider_code: '3',
      summary_only: true, last_update: null, delivery_carrier: 'ups', events: [] });
    for (const state of ['0', null, '99']) {
      let error: unknown;
      try { parse(changed((order) => { order.state = state; order.trackings = order.trackings.filter((entry: { node: string }) => entry.node === 'eta'); })); } catch (caught) { error = caught; }
      expect(error, String(state)).toMatchObject({ kind: 'indeterminate', name: 'NoHistoryError', reason: 'listed', deliveryCarrier: 'ups', deliveryTrackingNumber: UPS,
        plannedEvents: [{ time: '2026-03-12T00:00:00Z', description: 'Estimated arrival at Los Angeles' }] });
    }
  });

  it('names the partner only for one hand-over number its rules fit', () => {
    const handedTo = (edit: (order: ReturnType<typeof fixture>[number]) => void) => {
      const result = parse(changed(edit));
      return [result.delivery_carrier, result.delivery_tracking_number];
    };
    expect(handedTo((order) => { order.subTrackings[0].carrier = null; order.subTrackings[0].carrierCode = null; })).toEqual(['ups', UPS]);
    expect(handedTo((order) => { order.subTrackings[0].carrier = 'FEDEX'; order.subTrackings[0].carrierCode = 'fedex'; order.carrier = null; order.carrierCode = null; })).toEqual([undefined, UPS]);
    expect(handedTo((order) => { order.subTrackings[0].carrier = 'Synthetic Courier'; order.carrier = null; order.carrierCode = null; order.subTrackings[0].carrierCode = null; })).toEqual([undefined, UPS]);
    expect(handedTo((order) => { order.subTrackings.push({ ...order.subTrackings[0], trackingNum: '1Z999AA10123456795' }); })).toEqual([undefined, undefined]);
    expect(handedTo((order) => { order.subTrackings.push({ ...order.subTrackings[0] }); })).toEqual(['ups', UPS]);
    expect(handedTo((order) => { order.subTrackings = [{ ...order.subTrackings[0], trackingNum: NUMBER }]; })).toEqual([undefined, undefined]);
    expect(handedTo((order) => { order.subTrackings = null; })).toEqual([undefined, undefined]);
  });

  it('reads the destination as the page shows it', () => {
    expect(parse(changed((order) => { order.destCountry = 'United States'; })).destination_country).toBe('US');
    expect(parse(changed((order) => { order.destCountry = 'Synthetic Land'; }))).toMatchObject({ destination_country_name: 'Synthetic Land' });
    expect(parse(changed((order) => { order.destCountry = null; })).destination_country).toBeUndefined();
  });

  it('takes the people and phone numbers out of a row', () => {
    const result = parse(changed((order) => {
      order.trackings.push(row('Delivering', '2026-03-12T05:00:00Z', '【合成市】派件员：合成名 电话：13800138000 正在为您派件'));
    }));
    expect(result.events![0]!.description).toBe('【合成市】正在为您派件');
    expect(JSON.stringify(result)).not.toMatch(/合成名|13800138000/);
  });

  it('checks the number the order names', () => {
    expect(parse(changed((order) => { order.trackingNum = 'mp-0000000001'; })).events).toHaveLength(6);
    expect(parseAuOps(MASSPACK, changed((order) => { order.trackingNum = 'SYNTHETIC1'; }), 'SYNJOB000001').events).toHaveLength(6);
    for (const reply of [
      changed((order) => { order.trackingNum = 'MP0000000002'; }),
      changed((order) => { order.trackingNum = null; order.jobNum = 'SYNJOB000002'; }),
      [...fixture('synthetic-order'), ...fixture('synthetic-order')],
    ]) expect(() => parse(reply)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a changed reply', () => {
    for (const reply of [
      changed((order) => { order.trackingNum = null; order.jobNum = null; }),
      changed((order) => { order.notFound = true; }),
      changed((order) => { order.notFound = 'false'; }),
      changed((order) => { order.trackings[2].eventTime = '2026-03-04 23:20'; }),
      changed((order) => { order.trackings[2].eventTime = '2026-03-04T15:20:00'; }),
      changed((order) => { order.trackings[2].eventTime = '2026-03-04T25:20:00Z'; }),
      changed((order) => { order.trackings[2].eventTime = 1772637600; }),
      changed((order) => { order.trackings[2].eventTime = null; }),
      changed((order) => { order.trackings[2] = row(null, '2026-03-04T15:20:00Z', ''); }),
      changed((order) => { order.trackings = {}; }),
      changed((order) => { order.trackings = ['atd']; }),
      changed((order) => { order.subTrackings = 'UPS'; }),
      changed((order) => { order.headNodes = [null]; }),
      changed((order) => { order.trackings = Array(501).fill(row('atd', '2026-03-04T15:20:00Z')); }),
      fixture('synthetic-order')[0],
      [null], [], null, 'order', {},
    ]) expect(() => parse(reply), JSON.stringify(reply)?.slice(0, 120)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // A number the service does not have names nothing else.
    for (const edit of [(order: Record<string, unknown>) => { order.jobNum = 'SYNJOB000001'; }, (order: Record<string, unknown>) => { order.trackings = [row('atd', '2026-03-04T15:20:00Z')]; }]) {
      const reply = fixture('not-found'); edit(reply[0]);
      expect(() => parseAuOps(MASSPACK, reply, '0000000000')).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('answers each node and state statuses.json records by its stage', () => {
    expect(statuses.entries).toHaveLength(94);
    for (const { code, wording, stage, language } of statuses.entries as { code: string; wording: string; stage?: string; language: 'en' | 'zh' }[]) {
      const known = auOpsNode(code) ?? auOpsState(code);
      expect(known?.[language], code).toBe(wording);
      expect(statusMap.stage(code, wording)).toBe(stage);
      expect(statusMapAnswer({ carrier: 'masspack', providerCode: code, description: wording }), `${code} ${wording}`)
        .toEqual(stage ? { kind: 'mapped', stage } : expect.objectContaining({ kind: 'intentional_gap' }));
      if (stage) expect(STAGES).toContain(stage);
    }
    expect(statusMap.stage('eta', 'ETA')).toBeUndefined();
    expect(statusMap.stage(null, 'Deliveried')).toBeUndefined();
  });
});
