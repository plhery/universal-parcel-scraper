import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, HuiyuTracker } from './adapter.js';
import carrier from './carrier.json' with { type: 'json' };
import { HUIYU_ORIGIN, parseHuiyuTrack } from './parser.js';
import { huiyuEnglish, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The synthetic sample in numbers.json, which the fixture answers.
const NUMBER = 'HY9999999999980YQ';
const UNKNOWN = 'HY9999999999998YQ';
// Noon in Beijing on 6 March, after the fixture's rows.
const READ_AT = Date.parse('2026-03-06T04:00:00Z');
const own = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const shared = (name: string) => readFileSync(new URL(`../gzyl/fixtures/${name}`, import.meta.url), 'utf8');
const reply = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Huiyu International numbers', () => {
  it('takes the universal providers’ names for the forwarder', () => {
    for (const name of ['HYGJWL', 'Huiyu International', '辉宇国际', '深圳市辉宇国际货运代理有限公司']) {
      expect(carrierIdFromName(name), name).toBe('huiyu');
    }
  });

  it('offers HY, thirteen digits and YQ whole, and nothing shorter, longer or under another prefix or suffix', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['huiyu'] });
    for (const number of [NUMBER.replace('9980', '980'), NUMBER.replace('9980', '99980'), `HX${NUMBER.slice(2)}`, `${NUMBER.slice(0, -2)}YX`, `X${NUMBER}`]) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('huiyu');
    }
  });
});

describe('Huiyu International tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number and names Royal Mail’s number for the last leg', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(own('track.json')));
    vi.useFakeTimers({ now: READ_AT, toFake: ['Date'] });
    try {
      const result = await new HuiyuTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase());
      const [url, init] = fetcher.mock.calls[0]!;
      expect(String(url)).toBe(`${HUIYU_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
      expect(HUIYU_ORIGIN).toBe('http://81.71.24.16:8082');
      expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        status: 'in_transit', current_stage: 'accepted', current_stage_source: 'carrier_map', service_name: 'Synthetic UK Line',
        destination_country: 'GB', delivery_carrier: 'royal-mail', delivery_tracking_number: 'QP999999995GB',
      });
      expect(result).not.toHaveProperty('canonical_tracking_number');
    } finally {
      vi.useRealTimers();
    }
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'huiyu', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the order row in English and the receiving point’s bilingual scan on Beijing time, without the parties', () => {
    const result = parseHuiyuTrack(JSON.parse(own('track.json')), NUMBER, READ_AT)!;
    expect(result.events).toEqual([
      { time: '2026-03-05T10:20:00+08:00', description: '到达收货点 / Arrive at the delivery point', location: '深圳', provider_code: 'ARRIVAL',
        stage: 'accepted', stage_source: 'carrier_map', written_at: '2026-03-05T10:20:00+08:00' },
      { time: '2026-03-03T15:50:29+08:00', description: 'The electronic cargo information has been received',
        stage: 'registered', stage_source: 'carrier_map', written_at: '2026-03-03T15:50:29+08:00' },
    ]);
    const text = JSON.stringify(result);
    for (const value of ['Synthetic Recipient', 'Synthetic Shop', 'HY-TEST-001', 'ZZ99 9ZZ']) expect(text, value).not.toContain(value);
  });

  it('settles the interface’s no-row answer with the page', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(own('unknown.json')))
      .mockResolvedValueOnce(reply(shared('page-unknown.html').replaceAll('NOTFOUND000001', UNKNOWN)));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${HUIYU_ORIGIN}/trackIndex.htm`);
  });

  it('recognizes by the same lookup, since its two-letter prefix says little', async () => {
    const unknown = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(own('unknown.json')))
      .mockResolvedValueOnce(reply(shared('page-unknown.html').replaceAll('NOTFOUND000001', UNKNOWN)));
    await expect(adapter(environment(unknown)).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockResolvedValue(reply(own('track.json')));
    await expect(adapter(environment(known)).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
  });

  it('maps every row it has written, and the app reads the map', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMapAnswer({ carrier: 'huiyu', providerCode: 'ARRIVAL', description: '到达收货点 / Arrive at the delivery point' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'huiyu', providerCode: null, description: 'The electronic cargo information has been received' }))
      .toEqual({ kind: 'mapped', stage: 'registered' });
    expect(statusMapAnswer({ carrier: 'huiyu', providerCode: null, description: 'Synthetic wording' })).toEqual({ kind: 'unknown' });
    expect(huiyuEnglish(null, normalizeStatusWording('货物电子信息已经收到'))).toBe('The electronic cargo information has been received');
  });

  it('links no plain-HTTP page', () => {
    expect(carrier.portal).not.toHaveProperty('url');
    expect(carrier.links).toEqual([]);
  });
});
