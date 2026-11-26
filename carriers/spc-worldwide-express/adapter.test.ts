import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, spcTrackerUrl } from './adapter.js';
import { normalizeSpcNumber, parseSpc } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// Public samples from numbers.json, and the tracker's answer for an invented number.
const SAMPLE = '51362737';
const TEN_DIGITS = '8281425806';
const UNKNOWN = '99999999';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const delivered = fixture('delivered');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, userAgent: 'SPC test agent', recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('SPC Worldwide Express numbers', () => {
  it('takes a consignment number in letters and digits', () => {
    expect(normalizeSpcNumber(` ${SAMPLE} `)).toBe(SAMPLE);
    expect(normalizeSpcNumber('spc-123456')).toBe('SPC123456');
    for (const other of ['', '12345', 'ABCDEFGH', '5136,2737', '1'.repeat(21)]) {
      expect(() => normalizeSpcNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('SPC Worldwide Express tracking adapter', () => {
  it('asks the result page the tracking form redirects to, over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => html(delivered));
    await expect(carrier(fetcher).track({ number: SAMPLE })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`http://www.spcworldwidexp.com/tracking2.aspx?ref=${SAMPLE}`);
    expect(spcTrackerUrl(SAMPLE)).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(new Headers(init?.headers).get('User-Agent')).toBe('SPC test agent');
    expect(carrier(fetcher)).toMatchObject({ id: 'spc-worldwide-express', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the tracker’s "No Record Found!" for the number asked as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => html(fixture('not-found')));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps refusals, error pages and moved routes apart from a missing consignment', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: SAMPLE }, { budgetMs: 2000 }).catch((error: unknown) => error);
    expect(await answer(() => html('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => html('<title>Runtime Error</title>', { status: 500 }))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => html('<title>404</title>', { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: 'http://www.spcworldwidexp.com/default.aspx' } })))
      .toMatchObject({ kind: 'transport' });
    expect(await answer(() => new Response('{}', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => html('<title>Just a moment...</title>'))).toMatchObject({ kind: 'challenge' });
  });
});

describe('SPC Worldwide Express result pages', () => {
  it('reads the public sample: status codes at their stations on the station’s wall clock', () => {
    expect(parseSpc(delivered, SAMPLE)).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', provider_code: 'DELIVERED',
      last_status_text: 'DELIVERED', last_update: null, last_update_local: '2023-03-13T10:00:00', expected_delivery: null,
      events: [
        { local_time: '2023-03-13T10:00:00', description: 'DELIVERED', provider_code: 'DELIVERED', location: 'SPC-KPG', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2023-03-13T09:38:00', description: 'OUT4DELIV', provider_code: 'OUT4DELIV', location: 'SPC-KPG', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { local_time: '2023-03-13T07:40:00', description: 'ARRIVAL', provider_code: 'ARRIVAL', location: 'SPC-KPG', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2023-03-10T16:45:00', description: 'IN_TRANSIT', provider_code: 'IN_TRANSIT', location: 'SPC-KCH', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2023-03-10T16:43:00', description: 'REGISTER', provider_code: 'REGISTER', location: 'SPC-KCH', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
  });

  it('keeps the tracker’s numbering for rows of one minute', () => {
    const result = parseSpc(fixture('redirected'), TEN_DIGITS);
    expect(result).toMatchObject({ current_stage: 'in_transit', provider_code: 'PROCESSED', last_update_local: '2020-01-07T12:48:00' });
    expect(result.events!.map((event) => [event.provider_code, event.location])).toEqual([
      ['PROCESSED', 'SPC-KPG'], ['REDIRECT', 'SPC-KPG'], ['ARRIVAL', 'SPC-KPG'], ['IN_TRANSIT', 'SBW'], ['REGISTER', 'SBW'],
    ]);
    // The same rows listed oldest first come out in the same order.
    const rows = [...delivered.matchAll(/<tr>\s*<td align="center">.*?<\/tr>/g)].map((match) => match[0]);
    const reversed = delivered.replace(rows.join('        '), [...rows].reverse().join('        '));
    expect(reversed).not.toBe(delivered);
    expect(parseSpc(reversed, SAMPLE).events).toEqual(parseSpc(delivered, SAMPLE).events);
  });

  it('stages a later delivery attempt and leaves an unknown code to the scans before it', () => {
    const attempt = parseSpc(delivered.replace('>DELIVERED<', '>ATTEMPT2ND<'), SAMPLE);
    expect(attempt).toMatchObject({ current_stage: 'failed_attempt', provider_code: 'ATTEMPT2ND' });
    const unknown = parseSpc(delivered.replace('>DELIVERED<', '>HOLD_AT_STN<'), SAMPLE);
    expect(unknown).toMatchObject({ current_stage: 'out_for_delivery', provider_code: 'HOLD_AT_STN', last_status_text: 'HOLD_AT_STN' });
    expect(unknown.events![0]).toEqual({ local_time: '2023-03-13T10:00:00', description: 'HOLD_AT_STN', provider_code: 'HOLD_AT_STN', location: 'SPC-KPG' });
  });

  it('needs the page to name the number asked', () => {
    expect(() => parseSpc(delivered, '51362738')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseSpc(fixture('not-found'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a changed page', () => {
    const changed = [
      '<html><body>Server Error</body></html>',
      delivered.replace('>Location<', '>Station<'),
      delivered.replace('2023-Mar-13 10:00', '13/03/2023 10:00'),
      delivered.replace('2023-Mar-13 10:00', '2023-Feb-30 10:00'),
      delivered.replace('>DELIVERED<', '>delivered<'),
      delivered.replace('>SPC-KPG<', '>SPC/KPG?<'),
      delivered.replace('<b>CN: 51362737</b>', '<b>CN: 51362737</b><b>CN: 51362737</b>'),
      delivered.replace('</table>', '</table><font color="Red">No Record Found!</font>'),
      fixture('not-found').replace('No Record Found!', 'Please try again later'),
    ];
    for (const page of changed) {
      expect(() => parseSpc(page, page.includes('CN: 99999999') ? UNKNOWN : SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('SPC Worldwide Express statuses', () => {
  it('maps each status code the tracker printed', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'spc-worldwide-express', providerCode: entry.code, description: entry.wording }))
        .toMatchObject({ stage: entry.stage });
    }
    expect(statusMap.stage('ATTEMPT3RD', 'attempt3rd')).toBe('failed_attempt');
    expect(statusMap.stage('XYZ', 'xyz')).toBeUndefined();
  });
});
