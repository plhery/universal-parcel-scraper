import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { parseHualeiTrack } from '../gzyl/hualei.js';
import { adapter, JchTracker } from './adapter.js';
import carrier from './carrier.json' with { type: 'json' };
import { JCH, JCH_ORIGIN } from './parser.js';
import { jchEnglish, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample in numbers.json, which the fixture answers.
const NUMBER = 'JCHSG0000003334625';
const UNKNOWN = 'JCHSG0000000000001';
const READ_AT = Date.parse('2026-11-19T00:00:00Z');
const own = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const shared = (name: string) => readFileSync(new URL(`../gzyl/fixtures/${name}`, import.meta.url), 'utf8');
const reply = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('JCH numbers', () => {
  it('takes the universal providers’ names for the forwarder', () => {
    for (const name of ['JCH', 'JCH Express', '浙江金岂供应链管理有限公司', 'Zhejiang JCH Supply Chain Management Co., Ltd.']) {
      expect(carrierIdFromName(name), name).toBe('jch');
    }
  });

  it('claims its own JCHSG waybills whole, and nothing shorter or longer', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'jch', confidence: 'high', candidates: ['jch'] });
    for (const number of [NUMBER.slice(0, -1), `${NUMBER}0`, `JCHSA${NUMBER.slice(5)}`, `JCSG${NUMBER.slice(5)}`]) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('jch');
    }
  });
});

describe('JCH tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number and names SpeedX’s number for the last leg', async () => {
    vi.useFakeTimers({ now: READ_AT, toFake: ['Date'] });
    try {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(own('track.json')));
      const result = await new JchTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase());
      expect(String(fetcher.mock.calls[0]![0])).toBe(`${JCH_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
      expect(result).toMatchObject({
        current_stage: 'delivered', current_stage_source: 'carrier_map', destination_country: 'US', delivery_carrier: 'speedx',
      });
      expect(result.delivery_tracking_number).toMatch(/^SPXONT\d{12}$/);
      expect(result.events).toHaveLength(15);
      expect(result.events?.every((event) => event.stage)).toBe(true);
      expect(result.events?.at(-1)).toMatchObject({ stage: 'accepted', time: '2026-05-16T03:27:14+08:00' });
      // Rows abroad keep their places' wall clocks: the flight left on Beijing's and landed at LAX on Los Angeles's.
      const row = (description: string) => result.events?.find((event) => event.description === description);
      expect(row('Item Flight departure')).toMatchObject({ time: '2026-05-19T03:50:55+08:00' });
      expect(row('Item Flight landing')).toMatchObject({ local_time: '2026-05-18T23:39:00', location: 'LAX' });
      expect(row('Item Flight landing')).not.toHaveProperty('time');
      expect(row('Delivered. Position: Front porch')).toMatchObject({ stage: 'delivered', local_time: '2026-05-21T18:43:27' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the hand-off open for a number SpeedX does not claim', () => {
    const payload = JSON.parse(own('track.json'));
    Object.assign(payload[0].data[0], { trackingNumber: 'EM000000000CA', consigneeCountry: 'CA' });
    expect(parseHualeiTrack(payload, NUMBER, JCH, READ_AT)!.delivery_carrier).toBeUndefined();
  });

  it('settles the interface’s no-row answer with the page', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(own('unknown.json')))
      .mockResolvedValueOnce(reply(shared('page-unknown.html').replaceAll('NOTFOUND000001', UNKNOWN)));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${JCH_ORIGIN}/trackIndex.htm`);
  });

  it('maps every row it has written, and the app reads the map', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMapAnswer({ carrier: 'jch', providerCode: null, description: 'Item has been collected' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'jch', providerCode: null, description: 'Released From Export Customs' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'jch', providerCode: null, description: 'Synthetic wording' })).toEqual({ kind: 'unknown' });
    expect(jchEnglish(null, normalizeStatusWording('货物电子信息已经收到'))).toBe('The electronic cargo information has been received');
  });

  it('links no plain-HTTP page', () => {
    expect(carrier.portal).not.toHaveProperty('url');
    expect(carrier.links).toEqual([]);
  });
});
