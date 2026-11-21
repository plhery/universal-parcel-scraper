import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, CmtExpressTracker } from './adapter.js';
import { CMT_EXPRESS_ORIGIN, parseCmtExpressTrack } from './parser.js';
import { cmtExpressEnglish, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The synthetic fixture's number, in the shape of CMT Express's waybills and far beyond the range in use.
const NUMBER = 'CMT999999999990';
const UNKNOWN = 'CMT000000000017';
// Noon in Beijing on 12 March, after the fixture's rows.
const READ_AT = Date.parse('2026-03-12T04:00:00Z');
const own = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const shared = (name: string) => readFileSync(new URL(`../gzyl/fixtures/${name}`, import.meta.url), 'utf8');
const reply = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const track = () => JSON.parse(own('track.json')) as [{ data: [Record<string, unknown>] }];

describe('CMT Express numbers', () => {
  it('takes the universal providers’ names for the forwarder', () => {
    for (const name of ['CMT Express', 'CMT', '诚贸通', '深圳诚贸通供应链有限公司']) expect(carrierIdFromName(name), name).toBe('cmt-express');
  });

  it('offers CMT and twelve digits whole, and nothing shorter, longer or under another prefix', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['cmt-express'] });
    for (const number of [NUMBER.slice(0, -1), `${NUMBER}0`, `CMX${NUMBER.slice(3)}`, `X${NUMBER}`]) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('cmt-express');
    }
  });

  it('reads the number out of a link to its tracker, in either language', () => {
    for (const path of ['trackIndex.htm', 'en/trackIndex.htm']) {
      expect(parseTrackingInput(`https://tms.cmtexpress.com.cn/${path}?documentCode=${NUMBER}`))
        .toMatchObject({ trackingNumber: NUMBER, carrier: 'cmt-express' });
    }
  });
});

describe('CMT Express tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over HTTPS', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(own('track.json')));
    vi.useFakeTimers({ now: READ_AT, toFake: ['Date'] });
    try {
      const result = await new CmtExpressTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase());
      const [url, init] = fetcher.mock.calls[0]!;
      expect(String(url)).toBe(`${CMT_EXPRESS_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
      expect(CMT_EXPRESS_ORIGIN).toBe('https://tms.cmtexpress.com.cn');
      expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        status: 'in_transit', current_stage: 'accepted', current_stage_source: 'carrier_map', last_status_text: 'Arrive at SZ warehouse',
        last_update: '2026-03-11T18:30:05+08:00', service_name: '诚贸通欧洲优选-普货', destination_country: 'EE',
      });
      for (const field of ['canonical_tracking_number', 'delivery_carrier', 'delivery_tracking_number']) expect(result).not.toHaveProperty(field);
    } finally {
      vi.useRealTimers();
    }
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'cmt-express', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the order rows in English and the warehouse’s receipt on Beijing time, without Eswatini’s code for a place', () => {
    const result = parseCmtExpressTrack(JSON.parse(own('track.json')), NUMBER, READ_AT)!;
    const written = '2026-03-11T18:30:05+08:00';
    expect(result.events).toEqual([
      { time: written, description: 'Arrive at SZ warehouse', provider_code: 'ARRIVAL', stage: 'accepted', stage_source: 'carrier_map', written_at: written },
      { time: '2026-03-09T14:02:11+08:00', description: 'Order processed by shipper', stage: 'registered', stage_source: 'carrier_map', written_at: written },
      { time: '2026-03-02T09:15:40+08:00', description: 'The electronic cargo information has been received', stage: 'registered',
        stage_source: 'carrier_map', written_at: written },
    ]);
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC-REF-0001');
  });

  it('names a tracking number of another shape as the delivery carrier’s, and its own as the order’s', () => {
    const handed = track();
    handed[0].data[0].trackingNumber = 'ZZ999999999EE';
    handed[0].data[0].referenceNumber = NUMBER;
    expect(parseCmtExpressTrack(handed, NUMBER, READ_AT)).toMatchObject({ delivery_tracking_number: 'ZZ999999999EE' });
    const byReference = track();
    byReference[0].data[0].referenceNumber = 'SYNTHETICREF0001';
    expect(parseCmtExpressTrack(byReference, 'SYNTHETICREF0001', READ_AT)).toMatchObject({ canonical_tracking_number: NUMBER });
  });

  it('settles the interface’s no-row answer with the page', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(own('unknown.json')))
      .mockResolvedValueOnce(reply(shared('page-unknown.html').replaceAll('NOTFOUND000001', UNKNOWN)));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${CMT_EXPRESS_ORIGIN}/trackIndex.htm`);
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
  });

  it('recognizes by the same lookup', async () => {
    const unknown = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(own('unknown.json')))
      .mockResolvedValueOnce(reply(shared('page-unknown.html').replaceAll('NOTFOUND000001', UNKNOWN)));
    await expect(adapter(environment(unknown)).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockResolvedValue(reply(own('track.json')));
    await expect(adapter(environment(known)).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
  });

  it('sends nothing for a number the tracker cannot be asked for', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['CMT', 'CMT 9999,99999', 'x'.repeat(41)]) {
      await expect(adapter(environment(fetcher)).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads a block page as a challenge and a changed reply as malformed, never as not found', async () => {
    const blocked = vi.fn<typeof fetch>().mockResolvedValue(reply('<html><head><title>Just a moment...</title></head><body>cf-turnstile</body></html>'));
    await expect(adapter(environment(blocked)).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'challenge' });
    const changed = vi.fn<typeof fetch>().mockResolvedValue(reply('{"ack":"true","data":[]}'));
    await expect(adapter(environment(changed)).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'schema' });
    const other = track();
    other[0].data[0].trackingNumber = 'CMT999999999989';
    expect(() => parseCmtExpressTrack(other, NUMBER, READ_AT)).toThrow(/another shipment/);
  });

  it('maps every row it has written, and the app reads the map', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMapAnswer({ carrier: 'cmt-express', providerCode: 'ARRIVAL', description: 'Arrive at SZ warehouse' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'cmt-express', providerCode: null, description: 'The electronic cargo information has been received' }))
      .toEqual({ kind: 'mapped', stage: 'registered' });
    expect(statusMapAnswer({ carrier: 'cmt-express', providerCode: null, description: 'Synthetic wording' })).toEqual({ kind: 'unknown' });
    expect(cmtExpressEnglish(null, normalizeStatusWording('货物电子信息已经收到'))).toBe('The electronic cargo information has been received');
  });
});
