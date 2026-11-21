import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError,
} from '../../core/errors/index.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, normalizeNumarkPro, parseNumark } from './adapter.js';
import { numarkStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'latin1');
const delivered = fixture('delivered');
const notFound = fixture('not-found');
const PRO = '138762265';
const UNKNOWN = '999999990';

const instance = (fetcher: typeof fetch) => adapter({
  fetcher, userAgent: 'NuMark test agent', env: {}, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null,
});

describe('NuMark Transportation PRO trace', () => {
  it('reads the statuses newest first, by day, with the delivery clock and terminals', () => {
    const result = parseNumark(delivered, PRO);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'DELIVERED', last_update: null, last_update_local: '2017-04-06T14:14:00',
      receiver_address: 'SAN CARLOS, CA',
    });
    expect(result.events).toEqual([
      { description: 'DELIVERED', local_time: '2017-04-06T14:14:00', stage: 'delivered', stage_source: 'carrier_map' },
      { description: 'OUT FOR DELVRY', local_time: '2017-04-06', location: 'SAN LEANDRO', stage: 'out_for_delivery', stage_source: 'carrier_map' },
      { description: 'TERMINAL XFR', local_time: '2017-04-05', location: 'VERNON', stage: 'in_transit', stage_source: 'carrier_map' },
      { description: 'PICK UP MADE', local_time: '2017-04-05', location: 'VERNON', stage: 'accepted', stage_source: 'carrier_map' },
      { description: 'PU', local_time: '2017-04-05', stage: 'registered', stage_source: 'carrier_map' },
    ]);
    // The signer, the manifest numbers, the parties and the references stay behind.
    const written = JSON.stringify(result);
    for (const hidden of ['PAUL', '00367382', 'GUARDION', 'BREWING', 'COMMERCE', '94070', 'DCB_EMPTIES01', 'Prepaid']) {
      expect(written).not.toContain(hidden);
    }
  });

  it('dates a delivery by its in clock without an out clock, and by its day without either', () => {
    const outOnly = delivered.replace('<font size="1">1414</font>', '<font size="1">    </font>');
    expect(parseNumark(outOnly, PRO).events?.[0]?.local_time).toBe('2017-04-06T13:55:00');
    const dayOnly = outOnly.replace('<font size="1">1355</font>', '<font size="1">    </font>');
    const result = parseNumark(dayOnly, PRO);
    expect(result).toMatchObject({ last_update_local: '2017-04-06' });
    expect(result.events?.[0]).toMatchObject({ description: 'DELIVERED', local_time: '2017-04-06' });
  });

  it('keeps the page order of one day and sorts days the page lists out of order', () => {
    const rows = delivered.match(/<TR bgcolor="#EAEADF">[\s\S]*?<\/TR>\n/g)!;
    // The later day listed first, and the transfer before the pickup of its day.
    const shuffled = delivered.replace(rows.join(''), [rows[3], rows[4], rows[0], rows[2], rows[1]].join(''));
    expect(parseNumark(shuffled, PRO).events?.map((event) => event.description))
      .toEqual(['DELIVERED', 'OUT FOR DELVRY', 'PICK UP MADE', 'TERMINAL XFR', 'PU']);
  });

  it('leaves wording the map does not know without a stage', () => {
    const result = parseNumark(delivered.replace('>DELIVERED<', '>HELD AT DOCK<'), PRO);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'HELD AT DOCK' });
    expect(result.current_stage).toBeUndefined();
    expect(result.events?.[0]?.stage).toBeUndefined();
  });

  it('reads the trace’s own answers for a missing bill and a refused number', () => {
    expect(() => parseNumark(notFound, UNKNOWN)).toThrow(NotFoundError);
    // A missing bill answered for another number says nothing about the one asked.
    expect(() => parseNumark(notFound, PRO)).toThrow(IndeterminateError);
    expect(() => parseNumark(fixture('invalid'), '12345678901')).toThrow(InvalidInputError);
    expect(() => parseNumark(notFound.replace('Error: Bill not found', 'Error: System unavailable'), UNKNOWN)).toThrow(SchemaError);
  });

  it('requires the PRO number asked and the status columns', () => {
    expect(() => parseNumark(delivered, '138762277')).toThrow(IndeterminateError);
    expect(() => parseNumark(delivered.replace('<B>Pro: 138762265</B>', ''), PRO)).toThrow(SchemaError);
    expect(() => parseNumark(delivered.replace('<b>Origin Term</b>', '<b>From</b>'), PRO)).toThrow(SchemaError);
    expect(() => parseNumark(delivered.replace('>20170406<', '>2017-04-06<'), PRO)).toThrow(SchemaError);
    expect(() => parseNumark(delivered.replace('>1414<', '>14:14<'), PRO)).toThrow(SchemaError);
    expect(() => parseNumark('<html><body>Service unavailable</body></html>', PRO)).toThrow(SchemaError);
    expect(() => parseNumark('', PRO)).toThrow(IndeterminateError);
  });

  it('reads a bill without statuses as listed without history', () => {
    const start = delivered.indexOf('<TABLE WIDTH="100%" CELLPADDING=0 CELLSPACING=0 BORDER=0>\n<TR bgcolor="#CCCC99">');
    const bare = delivered.slice(0, start) + delivered.slice(delivered.indexOf('</TABLE>', start) + '</TABLE>'.length);
    expect(() => parseNumark(bare, PRO)).toThrow(NoHistoryError);
    const headingOnly = delivered.replace(/<TR bgcolor="#EAEADF">[\s\S]*?<\/TR>\n/g, '');
    expect(() => parseNumark(headingOnly, PRO)).toThrow(NoHistoryError);
  });

  it('reads a verification page as a challenge, never as a missing bill', () => {
    expect(() => parseNumark('<html><head><title>Just a moment...</title></head><body>cf-chl-</body></html>', PRO)).toThrow(ChallengeError);
    expect(() => parseNumark(`<div class="g-recaptcha"></div>${notFound}`, UNKNOWN)).toThrow(ChallengeError);
  });

  it('takes five to nine digits', () => {
    expect(normalizeNumarkPro(' 138 762 265 ')).toBe(PRO);
    expect(normalizeNumarkPro('12345')).toBe('12345');
    for (const number of ['1234', '1234567890', '13876226A', '']) expect(() => normalizeNumarkPro(number)).toThrow(InvalidInputError);
  });

  it('asks the trace as its form does, with the caller’s signal and user agent', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(delivered, { headers: { 'Content-Type': 'text/html; charset=ISO-8859-1' } }));
    await expect(instance(fetcher).track({ number: PRO })).resolves.toMatchObject({ current_stage: 'delivered' });
    await expect(instance(fetcher).track({ number: '1234567890' })).rejects.toThrow(InvalidInputError);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('http://tracking.numarktransportation.net/cgibin/wbprotrk?wbfb=138762265&wbscac=&idbutton=Trace');
    expect(new Headers(init?.headers).get('User-Agent')).toBe('NuMark test agent');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('reads a redirect as a moved trace and tries once more after a failed connection', async () => {
    const moved = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'http://example.com/' } }));
    await expect(instance(moved).track({ number: PRO })).rejects.toThrow(TransportError);
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue(new Response(notFound));
    await expect(instance(flaky).track({ number: UNKNOWN })).rejects.toThrow(NotFoundError);
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('reads the PRO number from a link to the trace', () => {
    expect(parseTrackingInput('http://tracking.numarktransportation.net/cgibin/wbprotrk?wbfb=138762265&wbscac=&idbutton=Trace'))
      .toMatchObject({ trackingNumber: PRO, carrier: 'numark-transportation', source: 'link' });
  });

  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(numarkStage(entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
    }
  });
});
