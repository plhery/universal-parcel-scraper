import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { withoutScriptCopies } from '../../providers/shared/scripts.js';
import { parseHualeiTrack } from '../gzyl/hualei.js';
import { GZYL_ORIGIN } from '../gzyl/parser.js';
import { adapter, YusudaTracker } from './adapter.js';
import { YUSUDA } from './parser.js';
import carrier from './carrier.json' with { type: 'json' };

const NUMBER = 'YSD0000000001';
const UNKNOWN = 'YSD0000000099';
// GZYL's synthetic replies, with the number in GZYL's place: the tenant is GZYL's.
const GZYL_NUMBER = 'GZTEST00000001';
const READ_AT = Date.parse('2026-03-06T00:00:00Z');
const fixture = (name: string) => readFileSync(new URL(`../gzyl/fixtures/${name}`, import.meta.url), 'utf8').replaceAll(GZYL_NUMBER, NUMBER);
const json = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Yusuda names', () => {
  it('takes the forwarder’s Latin and Chinese names', () => {
    for (const name of ['YUSUDA', 'Yusuda', '裕速达', '广州裕速达货运代理有限公司']) expect(carrierIdFromName(name), name).toBe('yusuda');
  });
});

describe('Yusuda tracking adapter', () => {
  it('asks GZYL’s Hualei tracker, which the site’s tracking form opens, for the whole number', async () => {
    vi.useFakeTimers({ now: READ_AT, toFake: ['Date'] });
    try {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('track.json')));
      const result = await new YusudaTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase());
      expect(String(fetcher.mock.calls[0]![0])).toBe(`${GZYL_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
      expect(result).toMatchObject({ current_stage: 'customs', current_stage_source: 'carrier_map', destination_country: 'CH' });
      expect(result.events?.at(-1)).toMatchObject({ description: 'Order information received', stage: 'registered' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles the interface’s no-row answer with the page', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track.json')))
      .mockResolvedValueOnce(json(fixture('page-unknown.html').replaceAll('NOTFOUND000001', UNKNOWN)));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${GZYL_ORIGIN}/trackIndex.htm`);
  });

  it('maps rows as GZYL’s map does, and the app reads the map', () => {
    expect(statusMapAnswer({ carrier: 'yusuda', providerCode: null, description: 'Arrive at the cross border receiving point' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'yusuda', providerCode: null, description: 'Synthetic wording' })).toEqual({ kind: 'unknown' });
  });

  it('holds back every row of its one-batch script but the order’s registration, and a provider’s copies of them', () => {
    // The whole feed written in one second, its receiving row an hour after that second.
    const payload = JSON.parse(fixture('track.json'));
    for (const row of payload[0].data[0].trackDetails) row.track_createdate = '2026-03-02 14:00:00';
    const after = Date.parse('2026-03-10T00:00:00Z');
    expect(parseHualeiTrack(payload, NUMBER, YUSUDA, after)?.events?.map(event => event.description)).toEqual(['Order information received']);
    expect(parseHualeiTrack(payload, NUMBER, { ...YUSUDA, oneBatch: undefined }, after)?.events?.map(event => event.description))
      .toEqual(['Arrive at the cross border receiving point', 'Order information received']);
    const copied = withoutScriptCopies({ tracking_provider: '17TRACK', status: 'in_transit', reported_carriers: ['YUSUDA'], events: [
      { time: '2026-03-02T15:07:14+08:00', description: 'Arrive at the cross border receiving point', stage: 'accepted', reporting_carrier: 'YUSUDA' },
      { time: '2026-03-01T22:36:51+08:00', description: 'Order information received', stage: 'registered', reporting_carrier: 'YUSUDA' },
    ] }, '17TRACK');
    expect(copied.events?.map(event => event.description)).toEqual(['Order information received']);
  });

  it('links no plain-HTTP page and names its SYD waybills', () => {
    expect(carrier.portal).not.toHaveProperty('url');
    expect(carrier.links).toEqual([]);
    expect(detectCarrierMatch('SYD9900000017YQ')).toMatchObject({ carrier: 'yusuda', confidence: 'high' });
    for (const near of ['SYD990000001YQ', 'SYD99000000170YQ', 'SYD9900000017Y']) expect(detectCarrierMatch(near).carrier, near).not.toBe('yusuda');
  });
});
