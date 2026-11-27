import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { HualeiTracker, parseHualeiPage, parseHualeiTrack } from '../gzyl/hualei.js';
import { adapter } from './adapter.js';
import carrier from './carrier.json' with { type: 'json' };
import { JYTWL, JYTWL_ORIGIN } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample in numbers.json, which `delivered.json` answers, and the invented number the tracker does not know.
const NUMBER = 'JYT2026117575CN';
const UNKNOWN = 'JYT1990483716CN';
// The lookup's moment, after the fixture's newest row.
const READ_AT = Date.parse('2026-11-27T00:00:00Z');
const own = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const json = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const unknownLookup = () => vi.fn<typeof fetch>().mockResolvedValueOnce(json(own('no-track.json'))).mockResolvedValueOnce(html(own('page-unknown.html')));

describe('JYTWL numbers', () => {
  it('takes the forwarder’s names', () => {
    for (const name of ['JYTWL', '玖运通', '玖运通国际物流', '广州玖运通国际物流服务有限公司', 'Jiuyuntong']) {
      expect(carrierIdFromName(name), name).toBe('jytwl');
    }
  });

  it('claims its waybills by their prefix alone and reads the number out of a link to its tracker', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'jytwl', confidence: 'high' });
    for (const other of ['JYT202611757CN', 'JYT20261175750CN', 'JYTD2026117575CN', 'JYT2026117575FI', '2026117575']) {
      expect(detectCarrierMatch(other).candidates, other).not.toContain('jytwl');
    }
    expect(parseTrackingInput(`http://118.195.157.162:8082/trackIndex.htm?documentCode=${NUMBER}`))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'jytwl' });
  });
});

describe('JYTWL tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(own('delivered.json')));
    await expect(new HualeiTracker(JYTWL, { fetcher, recorder: NOOP_RECORDER }).fetch(` ${NUMBER.toLowerCase()} `))
      .resolves.toMatchObject({ current_stage: 'delivered', destination_country: 'FI' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${JYTWL_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(JYTWL_ORIGIN).toBe('http://118.195.157.162:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'jytwl', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the line’s rows on Beijing’s clock and the rows copied from Europe on their wall clocks, as received', () => {
    const result = parseHualeiTrack(JSON.parse(own('delivered.json')), NUMBER, JYTWL, READ_AT)!;
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'L?hetys haettu noutopisteest?', last_update: null, last_update_local: '2026-07-25T20:53:46',
      service_name: 'Europe and US Apparel Line(General+Special)', destination_country: 'FI',
    });
    // The record holds no number of Posti's, so no carrier is named for the last leg.
    for (const field of ['delivery_carrier', 'delivery_tracking_number', 'canonical_tracking_number', 'planned_events']) {
      expect(result, field).not.toHaveProperty(field);
    }
    const events = result.events!;
    expect(events.map((event) => [event.time ?? event.local_time, event.description, event.location, event.stage, event.stage_source])).toEqual([
      ['2026-07-25T20:53:46', 'L?hetys haettu noutopisteest?', 'Pakettipiste-noutopiste K-Market Kumpula', 'delivered', 'carrier_map'],
      ['2026-07-25T16:22:42', 'L?hetys noudettavissa', 'Pakettipiste-noutopiste K-Market Kumpula', 'ready_for_pickup', 'carrier_map'],
      ['2026-07-25T15:24:11', 'Toimitettu noutopisteeseen', 'Pakettipiste-noutopiste K-Market Kumpula', 'ready_for_pickup', 'carrier_map'],
      ['2026-07-25T12:07:43', 'Jakelun lastaus', 'TERMINAALI TAMPERE 31', 'out_for_delivery', 'carrier_map'],
      ['2026-07-25T09:07:46', 'Vastaanotettu terminaalissa', 'TERMINAALI TAMPERE 31', 'in_transit', 'carrier_map'],
      ['2026-07-25T01:06:56', 'Vastaanotettu terminaalissa', 'TERMINAALI VANTAA 34', 'in_transit', 'carrier_map'],
      ['2026-07-25T00:08:38', 'Vastaanotettu terminaalissa', 'TERMINAALI VANTAA 34', 'in_transit', 'carrier_map'],
      ['2026-07-22T20:50:15', 'Departed from office of exchange', 'PPLUS', 'in_transit', 'carrier_map'],
      ['2026-07-22T15:49:00+08:00', '货物已清关完成 Import customs clearance complete', undefined, 'in_transit', 'carrier_map'],
      ['2026-07-21T05:03:58', 'Customs clearance completed', 'NL_', 'in_transit', 'carrier_map'],
      ['2026-07-21T04:52:06', 'Item presentation notification sent', 'NL_', 'customs', 'carrier_map'],
      ['2026-07-21T04:50:13', 'Received at office of exchange', 'PPLUS', 'in_transit', 'carrier_map'],
      ['2026-07-20T21:57:00+08:00', '目的港已提货 Delivery has been made at the destination port', undefined, 'in_transit', 'carrier_map'],
      ['2026-07-17T06:45:00', 'Notice of Arrival', 'AMS', 'in_transit', 'carrier_map'],
      ['2026-07-16T19:04:00+08:00', '航班已到达,清关拆板中 The flight has arrived, customs clearance and unpacking are underway', undefined, 'customs', 'carrier_map'],
      ['2026-07-16T04:21:00+08:00', '航班已起飞,The flight has taken off from the origin', undefined, 'in_transit', 'carrier_map'],
      ['2026-07-15T18:00:02', 'Office of exchange pre-alert/posting', 'PPLUS', 'in_transit', 'carrier_map'],
      ['2026-07-15T16:07:00+08:00', '预计配载航班7月16日,Expected flight on July 16th', undefined, 'in_transit', 'none'],
      ['2026-07-15T11:03:00+08:00', 'Export customs clearance completed', undefined, 'in_transit', 'carrier_map'],
      ['2026-07-14T17:41:48+08:00', 'Goods leaving the operation center', '广州', 'in_transit', 'carrier_map'],
      ['2026-07-14T17:11:53+08:00', 'Arriving at the receiving point', '广州', 'accepted', 'carrier_map'],
    ]);
    // The copies from Europe keep their wall clock without a zone.
    expect(events[0]).not.toHaveProperty('time');
    expect(JSON.stringify(result)).not.toMatch(/signperson|customer_code/);
  });

  it('keeps the expected flight as a notice whatever its day, and the stage of the scan before it', () => {
    const payload = JSON.parse(own('delivered.json'));
    const [record] = payload[0].data;
    record.trackDetails = record.trackDetails.slice(-4);
    record.trackDetails[0].track_content = '预计配载航班12月3日,Expected flight on December 3rd';
    const result = parseHualeiTrack(payload, NUMBER, JYTWL, READ_AT)!;
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: '预计配载航班12月3日,Expected flight on December 3rd' });
    expect(result.events![0]).toMatchObject({ description: '预计配载航班12月3日,Expected flight on December 3rd', stage: 'in_transit', stage_source: 'none' });
    expect(statusMap.gapNote?.(null, normalizeStatusWording('预计配载航班12月3日,Expected flight on December 3rd'))).toMatch(/forecast/);
  });

  it('reads the no-row answer for an unknown number, which the page settles as not found', async () => {
    expect(parseHualeiTrack(JSON.parse(own('no-track.json')), UNKNOWN, JYTWL, READ_AT)).toBeNull();
    const fetcher = unknownLookup();
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls[1]![0]).toEqual(new URL(`${JYTWL_ORIGIN}/trackIndex.htm`));
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
    expect(() => parseHualeiPage(own('page-unknown.html'), UNKNOWN, JYTWL, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The same page for another number is no answer for this one.
    expect(() => parseHualeiPage(own('page-unknown.html'), NUMBER, JYTWL, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('recognizes by the same lookup', async () => {
    await expect(adapter(environment(unknownLookup())).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockResolvedValue(json(own('delivered.json')));
    await expect(adapter(environment(known)).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
  });

  it('refuses a number the tracker cannot be asked for without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['JYT', `${NUMBER},${UNKNOWN}`]) {
      await expect(adapter(environment(fetcher)).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads a block page as a challenge, a changed reply as a schema error and a 429 as a rate limit, never as not found', async () => {
    const block = '<html><head><title>验证码</title></head><body>aliyun_waf</body></html>';
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(html(block)))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(json('[{"ack":"true","data":{}}]')))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(html('', 429)))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('maps every wording it lists, and the app reads the map', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)) ?? null, entry.wording).toBe(entry.stage);
    }
    expect(statusMap.stage(null, normalizeStatusWording('预计配载航班7月16日,Expected flight on July 16th'))).toBeUndefined();
    expect(statusMap.gapNote?.(null, normalizeStatusWording('Synthetic wording'))).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'jytwl', providerCode: null, description: 'L?hetys haettu noutopisteest?' }))
      .toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'jytwl', providerCode: null, description: 'Synthetic wording' })).toEqual({ kind: 'unknown' });
  });

  it('links no plain-HTTP page', () => {
    expect(carrier.portal).not.toHaveProperty('searchUrl');
  });
});
