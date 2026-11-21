import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, TAKESEND_LOOKUP, TakesendTracker } from './adapter.js';
import { normalizeTakesendNumber, parseTakesend } from './parser.js';
import { statusMap, takesendStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// Synthetic numbers in Take Send's layout and in YWE's.
const NUMBER = 'TS2609049999980';
const PARTNER = 'YWE99999999999904';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.xml`, import.meta.url), 'utf8');
const reply = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/xml;charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Take Send HTTP adapter', () => {
  it('posts the tracking page’s lookup for the whole number in capitals, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TakesendTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' ts 2609049999980 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(String(url)).toBe(TAKESEND_LOOKUP);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ index: '0', billid: NUMBER, isRepeat: 'false', language: 'en' });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'takesend', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the scans on Beijing time, stages them by their wording and names YWE’s number', () => {
    const result = parseTakesend(fixture('in-transit'), NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Packaged', last_update: '2026-09-06T19:28:04+08:00', expected_delivery: null,
      destination_country: 'US', delivery_carrier: 'ywe', delivery_tracking_number: PARTNER });
    expect(result.events!.map((event) => [event.time, event.description, event.stage])).toEqual([
      ['2026-09-06T19:28:04+08:00', 'Packaged', 'in_transit'],
      ['2026-09-06T15:56:50+08:00', 'Scan receipt', 'in_transit'],
      ['2026-09-06T06:09:59+08:00', 'Leaving the distribution center', 'in_transit'],
      ['2026-09-05T20:34:17+08:00', 'Enter the distribution center', 'accepted'],
      ['2026-09-04T22:17:08+08:00', 'Shipment information received', 'registered'],
      ['2026-09-04T22:16:57+08:00', 'The Item is at the shippers warehouse', 'registered'],
    ]);
    expect(result.events![0]).toMatchObject({ local_time: '2026-09-06T19:28:04', time_zone: 'Asia/Shanghai' });
    // Take Send's own name in the place column is no place.
    expect(result.events!.some((event) => event.location)).toBe(false);
    expect(detectCarrierMatch(PARTNER)).toMatchObject({ carrier: 'ywe', confidence: 'high' });
  });

  it.each([
    ['Arrived at destination airport', 'in_transit'],
    ['Custom clearance in process - import', 'customs'],
    ['Customs clearance completed', 'in_transit'],
    ['Next stop destination airport', 'in_transit'],
  ] as const)('reads %s as %s in the shipment history', (description, stage) => {
    const payload = fixture('in-transit').replace('intro="Packaged" statusname="" ', `intro="${description}" statusname="" `);
    expect(parseTakesend(payload, NUMBER).events![0]).toMatchObject({ description, stage, stage_source: 'carrier_map' });
  });

  it('falls back to the record’s status code, and names no partner for its own number', () => {
    const coded = fixture('in-transit').replace(/intro="Packaged" statusname="" /, 'intro="Synthetic note" statusname="" ')
      .replace(/transbillid="[^"]*"/, 'transbillid=""').replace(/ billid="YWE\d+"/, ` billid="${NUMBER}"`)
      .replace('trackstatus="110"', 'trackstatus="200"');
    const result = parseTakesend(coded, NUMBER);
    expect(takesendStage('Synthetic note')).toBeNull();
    expect(result).toMatchObject({ last_status_text: 'Synthetic note', current_stage: 'delivered', current_stage_source: 'carrier_map' });
    expect(result.events![0]).not.toHaveProperty('stage');
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(parseTakesend(coded.replace('trackstatus="200"', 'trackstatus="109"'), NUMBER))
      .toMatchObject({ status: 'unknown', last_status_text: 'Synthetic note' });
  });

  it('reads only the tracker’s echo as not found, and binds the reply to the number asked', () => {
    expect(() => parseTakesend(fixture('not-found'), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found', provider: 'Take Send' }));
    expect(() => parseTakesend(fixture('in-transit').replace(/<trackitem [^>]*\/>/g, ''), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseTakesend(fixture('in-transit'), 'TS2609049999981'))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'Take Send answered for another number' }));
    expect(() => parseTakesend(fixture('in-transit').replace('2026-09-06 19:28:04" place', '06/09/2026" place'), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTakesend('<xdoc><xout></xout></xdoc>', NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: NUMBER });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'http://www.takesend.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Just a moment...</title></head></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>HTTP Status 500</title></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind });
    });

  it('rejects what is no Take Send number, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['TS26090499', 'SAMPLETRACKING', PARTNER, `TS${'0'.repeat(40)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: NUMBER }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeTakesendNumber('ts 260904-9999980')).toBe(NUMBER);
  });

  it('sends a read that hangs once more inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: NUMBER }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(ended).toEqual([60, 120]);
  });

  it('routes a number filed or linked under Take Send to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('in-transit')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: NUMBER, carrier: 'takesend' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'takesend', source: 'takesend', result: { current_stage: 'in_transit' } });
    expect(parseTrackingInput(`http://k5.takesend.com:8180/WebTrack?action=list&bills=${NUMBER}`))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'takesend', source: 'link' });
  });

  it('recognizes a known number and the echo, and asks nothing for what is no Take Send number', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('in-transit')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(NUMBER)).resolves.toMatchObject({ known: true, lastActivityAt: expect.any(String) });
    await expect(carrier(fetcher).recognize!(NUMBER)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('TS-0')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).recognize!(NUMBER)).rejects.toMatchObject({ kind });
    });
});

describe('Take Send status vocabulary', () => {
  type Entry = { code?: string; wording: string; stage?: string };
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as Entry[]) {
      if (entry.code) {
        if (!entry.stage) {
          expect(statusMap.stage(entry.code, normalizeStatusWording(entry.wording)), entry.code).toBeUndefined();
          expect(statusMapAnswer({ carrier: 'takesend', providerCode: entry.code, description: entry.wording }), entry.code)
            .toMatchObject({ kind: 'intentional_gap' });
          continue;
        }
        expect(statusMap.stage(entry.code, normalizeStatusWording(entry.wording)), entry.code).toBe(entry.stage);
        continue;
      }
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(takesendStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'takesend', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
  });
});

it('follows the transfer number when Take Send lists no scans', async () => {
  const upstream = fixture('in-transit').replace(/<trackitem [^>]*\/>/g, '');
  const partner = JSON.parse(readFileSync(new URL('../ywe/fixtures/returned.json', import.meta.url), 'utf8'));
  partner[0].expressCode = PARTNER;
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(upstream)).mockResolvedValueOnce(Response.json(partner));
  const result = await createTracker({ fetcher, providers: [], env: {} }).track({ number: NUMBER, carrier: 'takesend' });
  expect(result).toMatchObject({ source: 'ywe', handoff: { number: PARTNER, confirmed: true } });
});
