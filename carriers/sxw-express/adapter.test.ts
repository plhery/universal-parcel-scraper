import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { parseHualeiTrack } from '../gzyl/hualei.js';
import { adapter, SxwTracker } from './adapter.js';
import carrier from './carrier.json' with { type: 'json' };
import { SXW, SXW_ORIGIN } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'SXW999999999980';
const UNKNOWN = 'SXW999999999981';
const GOFO_NUMBER = 'GFUS99999999999980';
const READ_AT = Date.parse('2026-11-14T00:00:00Z');
const own = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const shared = (name: string) => readFileSync(new URL(`../gzyl/fixtures/${name}`, import.meta.url), 'utf8');
const reply = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('SXW Express numbers', () => {
  it('takes the universal providers’ names for the forwarder', () => {
    for (const name of ['SXW', 'SXW Wuliu', 'SXW Express', '胜兴旺', '深圳胜兴旺供应链管理有限公司']) {
      expect(carrierIdFromName(name), name).toBe('sxw-express');
    }
  });

  it('claims its own SXW waybills whole, and nothing shorter or longer', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'sxw-express', confidence: 'high', candidates: ['sxw-express'] });
    for (const number of ['SXW99999999998', 'SXW9999999999800', 'SXV999999999980']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('sxw-express');
    }
  });
});

describe('SXW Express tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number and names GOFO’s number for the last leg', async () => {
    vi.useFakeTimers({ now: READ_AT, toFake: ['Date'] });
    try {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(own('track.json')));
      const result = await new SxwTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase());
      expect(String(fetcher.mock.calls[0]![0])).toBe(`${SXW_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
      expect(result).toMatchObject({
        current_stage: 'in_transit', current_stage_source: 'carrier_map', destination_country: 'US',
        delivery_carrier: 'gofo', delivery_tracking_number: GOFO_NUMBER,
      });
      expect(result.events).toHaveLength(10);
      expect(result.events?.every((event) => event.stage)).toBe(true);
      expect(result.events?.at(-1)).toMatchObject({ stage: 'registered' });
      expect(JSON.stringify(result)).not.toContain('REF-0000-0001');
    } finally {
      vi.useRealTimers();
    }
  });

  it('names GOFO for its own number under a channel that names GOFO or no other carrier, whatever the destination', () => {
    // A synthetic record: SXW's number as the tracking number, GOFO's as the channel's transfer number.
    const record = (fields: Record<string, string>) => {
      const payload = JSON.parse(own('track.json'));
      Object.assign(payload[0].data[0], { trackingNumber: NUMBER, business_channeltransfercode: GOFO_NUMBER, ...fields });
      return parseHualeiTrack(payload, NUMBER, SXW, READ_AT)!;
    };
    for (const channel of ['', 'GOFO', 'GOFO Express', 'GOFO美国专线', '美国专线', 'US Line', 'SXW-US']) {
      expect(record({ channel_name: channel }), channel).toMatchObject({ delivery_carrier: 'gofo', delivery_tracking_number: GOFO_NUMBER });
    }
    expect(record({ consigneeCountry: 'DE' })).toMatchObject({ delivery_carrier: 'gofo', delivery_tracking_number: GOFO_NUMBER });
    // A channel naming another carrier, by the platform's table or a catalog name in its words, leaves the hand-off open.
    for (const channel of ['UPS', 'UPS红单', 'USPS Ground', 'Swiss Post', '瑞士邮政', 'China Post US Line']) {
      expect(record({ channel_name: channel }).delivery_carrier, channel).toBeUndefined();
    }
    // A number of another shape is no GOFO hand-off under any channel.
    expect(record({ channel_name: 'GOFO', business_channeltransfercode: '9400000000000000000000' }).delivery_carrier).toBeUndefined();
  });

  it('settles the interface’s no-row answer with the page', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(shared('no-track.json')))
      .mockResolvedValueOnce(reply(shared('page-unknown.html').replaceAll('NOTFOUND000001', UNKNOWN)));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${SXW_ORIGIN}/trackIndex.htm`);
  });

  it('maps every row it has written, and the app reads the map', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMapAnswer({ carrier: 'sxw-express', providerCode: null, description: 'Parcel picked up' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'sxw-express', providerCode: null, description: 'Synthetic wording' })).toEqual({ kind: 'unknown' });
  });

  it('links no plain-HTTP page', () => {
    expect(carrier.portal).not.toHaveProperty('url');
    expect(carrier.links).toEqual([]);
  });
});
