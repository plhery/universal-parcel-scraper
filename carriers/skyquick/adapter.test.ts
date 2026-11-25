import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SkyquickTracker } from './adapter.js';
import { normalizeSkyquickNumber, parseSkyquick, SKYQUICK_TRACKER } from './parser.js';
import { skyquickStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The Trustpilot sample in numbers.json, whose reply is delivered.html.
const DELIVERED = '711952411623';
const UNKNOWN = '999999999990';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const lookup = (body: string, init?: ResponseInit, number = DELIVERED) =>
  carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number });

describe('SkyQuick International HTTP adapter', () => {
  it('reads SkyQuick’s page for the whole number once, under its member id, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SkyquickTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 7119 5241 1623 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${SKYQUICK_TRACKER}?stid=skyquick&cn=${DELIVERED}`);
    expect(String(url)).toMatch(/^https:\/\/tracking\.frontierforce\.com\/go\/plm-tracking\?/);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'skyquick', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('dates the scans in London and Singapore on their clocks and stages a delivery after failed attempts', () => {
    const result = parseSkyquick(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Successful Delivery', last_update: '2022-01-03T11:04:00+08:00', expected_delivery: null, destination_country: 'SG' });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage ?? null, event.location])).toEqual([
      ['2022-01-03T11:04:00+08:00', '1', 'delivered', 'SINGAPORE'],
      // A message to the recipient moves nothing.
      ['2022-01-03T09:13:00+08:00', '148', null, 'SINGAPORE'],
      ['2022-01-03T08:24:00+08:00', '148', null, 'SINGAPORE'],
      ['2022-01-03T08:20:00+08:00', '15', 'out_for_delivery', 'SINGAPORE'],
      ['2021-12-31T19:58:00+08:00', '53', 'failed_attempt', 'SINGAPORE'],
      ['2021-12-31T16:03:00+08:00', '148', null, 'SINGAPORE'],
      ['2021-12-31T08:31:00+08:00', '148', null, 'SINGAPORE'],
      ['2021-12-31T08:19:00+08:00', '15', 'out_for_delivery', 'SINGAPORE'],
      ['2021-12-29T16:39:00+08:00', '262', 'in_transit', 'SINGAPORE'],
      ['2021-12-29T16:36:00+08:00', '262', 'in_transit', 'SINGAPORE'],
      ['2021-12-29T16:15:00+08:00', '4', 'in_transit', 'SINGAPORE'],
      // Back to the depot after a failed attempt: the wording also fits a return to the origin.
      ['2021-12-29T09:21:00+08:00', '45', null, 'SINGAPORE'],
      ['2021-12-28T13:46:00+08:00', '18', 'failed_attempt', 'SINGAPORE'],
      ['2021-12-28T08:04:00+08:00', '15', 'out_for_delivery', 'SINGAPORE'],
      ['2021-12-27T17:30:00+08:00', '3', 'in_transit', 'SINGAPORE'],
      ['2021-12-27T17:15:00+08:00', '4', 'in_transit', 'SINGAPORE'],
      ['2021-12-27T11:49:00+08:00', '262', 'in_transit', 'SINGAPORE'],
      ['2021-12-27T10:54:00+08:00', '4', 'in_transit', 'SINGAPORE'],
      ['2021-12-27T05:13:00+08:00', '4', 'in_transit', 'SINGAPORE'],
      ['2021-12-20T21:43:00+00:00', '14', 'in_transit', 'London - UNITED KINGDOM'],
      ['2021-12-18T15:00:00+00:00', '3', 'in_transit', 'London - UNITED KINGDOM'],
      ['2021-12-18T11:36:00+08:00', '148', null, 'SINGAPORE'],
    ]);
    expect(result.events!.every((event) => !event.local_time)).toBe(true);
    expect(result.events![0]!.description).toBe('Successful Delivery');
    expect(result.events!.at(-2)!.description).toBe('Departed SkyQuick Facility');
    // The masked signatory, the service type and the sender's reference are not kept.
    expect(JSON.stringify(result)).not.toMatch(/M\*{7}|Worldwide Express Non Documents|131510698/);
    expect(result).not.toHaveProperty('signed_by');
    expect(result).not.toHaveProperty('receiver_address');
  });

  it('counts a history only when every scan names the number asked', () => {
    expect(() => parseSkyquick(fixture('delivered'), '711952411624'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'SkyQuick answered for another shipment' }));
    const mixed = fixture('delivered').replace(`$(".cn").html("${DELIVERED}");`, `$(".cn").html("${UNKNOWN}");`);
    expect(() => parseSkyquick(mixed, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed page', () => {
    const page = fixture('delivered');
    for (const changed of [
      '<html><title>GETOnline</title></html>',
      page.replace('function js_getTrack()', 'function js_getTracking()'),
      page.replace('$(".trackingstatus-connote").show();', '').replace(/\$\("\.cn"\)\.html\("\d+"\);/g, ''),
      page.replace('03 Jan 2022</span>', '2022-01-03</span>'),
      page.replace('11:04 AM</span>', '11:04</span>'),
      page.replace(/langtag="event_' \+ 1\+'">' \+ "Successful Delivery"/, 'langtag="event_\' + 1+\'">\' + ""'),
      page.replace('var sno = 0;', 'var sno = 0;\n            $(".no-trackingstatus").show();'),
    ]) {
      expect(() => parseSkyquick(changed, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a block page, an empty page and a broken page apart', async () => {
    await expect(lookup(fixture('not-found'), {}, UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: '/tracking_search.aspx?stid=skyquick' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Access Denied</title></head><body>Request Rejected</body></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup('<html><title>GETOnline</title></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('sends a read that did not reach the tracker once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('sends only a whole reference: no short one, pattern, punctuation or placeholder', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['7119524', '711952411623000000000', '71195241162%', '71195241162*', 'ABCDEFGHIJ', '000000000000']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number), number).resolves.toEqual({ known: false });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeSkyquickNumber('7119-5241-1623')).toBe(DELIVERED);
    expect(normalizeSkyquickNumber('zz0000000001')).toBe('ZZ0000000001');
  });

  it('recognizes a known number by its last scan and an unknown one by the tracker’s notice', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      reply(fixture(String(url).endsWith(DELIVERED) ? 'delivered' : 'not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2022-01-03T03:04:00.000Z', finished: true });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
  });

  it('routes a number filed under SkyQuick to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'skyquick' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'skyquick', source: 'skyquick', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(SKYQUICK_TRACKER))).toBe(true);
  });
});

describe('SkyQuick International numbers', () => {
  it('claims no bare digits: other carriers print them too', () => {
    const match = detectCarrierMatch(DELIVERED);
    expect(match.carrier).not.toBe('skyquick');
    expect(match.candidates).not.toContain('skyquick');
  });
});

describe('SkyQuick International status vocabulary', () => {
  it('records every event number the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBeUndefined();
        expect(skyquickStage(entry.code, entry.wording), entry.code).toBeNull();
        expect(statusMapAnswer({ carrier: 'skyquick', providerCode: entry.code, description: entry.wording }), entry.code)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(skyquickStage(entry.code, entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'skyquick', providerCode: '999', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // An event number the map does not know falls to the shared wording rules.
    expect(skyquickStage('999', 'Out for Delivery')).toEqual({ stage: 'out_for_delivery', source: 'wording:language' });
    expect(skyquickStage('999', 'Synthetic note')).toBeNull();
  });
});
