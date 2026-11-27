import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { HualeiTracker, parseHualeiPage, parseHualeiTrack } from '../gzyl/hualei.js';
import { adapter } from './adapter.js';
import carrier from './carrier.json' with { type: 'json' };
import { SUNSON, SUNSON_ORIGIN } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample in numbers.json, which `track.json` answers, and a string in no shape the tracker issues.
const NUMBER = 'SUN202305005325';
const UNKNOWN = 'ZZQX00000000000';
// The lookup's moment, after the fixture's newest row.
const READ_AT = Date.parse('2026-11-27T00:00:00Z');
const own = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const json = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const unknownLookup = () => vi.fn<typeof fetch>().mockResolvedValueOnce(json(own('no-track.json'))).mockResolvedValueOnce(html(own('page-unknown.html')));

describe('Sunson numbers', () => {
  it('takes the forwarder’s names', () => {
    for (const name of ['Sunson', 'Sunson Logistics', 'Sunsonexpress', '燊鑫国际物流', '深圳燊鑫国际物流有限公司']) {
      expect(carrierIdFromName(name), name).toBe('sunson');
    }
  });

  it('offers its SUN numbers whole, and nothing shorter or longer', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['sunson'] });
    for (const number of [NUMBER.slice(0, -1), `${NUMBER}0`, `SU${NUMBER.slice(3)}`, `SUM${NUMBER.slice(3)}`]) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('sunson');
    }
  });
});

describe('Sunson tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    vi.useFakeTimers({ now: READ_AT, toFake: ['Date'] });
    try {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(own('track.json')));
      await expect(new HualeiTracker(SUNSON, { fetcher, recorder: NOOP_RECORDER }).fetch(` ${NUMBER.toLowerCase()} `))
        .resolves.toMatchObject({ current_stage: 'accepted', destination_country: 'IL' });
      const [url, init] = fetcher.mock.calls[0]!;
      expect(String(url)).toBe(`${SUNSON_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
      expect(SUNSON_ORIGIN).toBe('http://111.230.206.59:8082');
      expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(adapter(environment(fetcher))).toMatchObject({ id: 'sunson', recordsSteps: true, steps: ['direct', 'retry'] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads a parcel on the line to Israel, its Chinese rows in English on Beijing’s clock', () => {
    const result = parseHualeiTrack(JSON.parse(own('track.json')), NUMBER, SUNSON, READ_AT)!;
    expect(result).toMatchObject({
      current_stage: 'accepted', current_stage_source: 'carrier_map', destination_country: 'IL', service_name: '以色列HFD专线-自提',
      last_status_text: 'The goods arrive at the receiving point', last_update: '2023-12-20T15:51:49+08:00',
    });
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result.events?.map((event) => [event.time, event.description, event.location, event.stage])).toEqual([
      ['2023-12-20T15:51:49+08:00', 'The goods arrive at the receiving point', '广州', 'accepted'],
      ['2023-12-04T14:05:55+08:00', 'Arrived at the receiving point', '深圳', 'accepted'],
      ['2023-12-04T09:11:07+08:00', 'Received shipping information', undefined, 'registered'],
      ['2023-12-04T09:11:06+08:00', 'The electronic cargo information has been received', undefined, 'registered'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/BEAUTY|signperson|customer_code/i);
  });

  it('reads the no-row answer for an unknown number, which the page settles as not found', async () => {
    expect(parseHualeiTrack(JSON.parse(own('no-track.json')), UNKNOWN, SUNSON, READ_AT)).toBeNull();
    const fetcher = unknownLookup();
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls[1]![0]).toEqual(new URL(`${SUNSON_ORIGIN}/trackIndex.htm`));
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
    expect(() => parseHualeiPage(own('page-unknown.html'), UNKNOWN, SUNSON, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('never reads the page for another number as not found', () => {
    expect(() => parseHualeiPage(own('page-unknown.html'), 'ZZQX00000000001', SUNSON, READ_AT)).toThrow(expect.not.objectContaining({ kind: 'not_found' }));
  });

  it('recognizes by the same lookup', async () => {
    await expect(adapter(environment(unknownLookup())).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockResolvedValue(json(own('track.json')));
    await expect(adapter(environment(known)).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
  });

  it('refuses a number the tracker cannot be asked for without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['SUN', `${NUMBER},${UNKNOWN}`]) {
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
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'sunson', providerCode: null, description: '货物到达收货点' })).toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'sunson', providerCode: null, description: 'Synthetic wording' })).toEqual({ kind: 'unknown' });
  });

  it('links no plain-HTTP page', () => {
    expect(carrier.portal).not.toHaveProperty('searchUrl');
    expect(carrier.links).toEqual([]);
  });
});
