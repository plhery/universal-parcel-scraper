import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, GfsExpressTracker, gfsQuery } from './adapter.js';
import { parseGfs } from './parser.js';
import { statusMap } from './status.js';

const NUMBER = 'CGD58302719464';
const reply = (name = 'delivered') => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json;charset=UTF-8' } });
const salt = readFileSync(new URL('./adapter.ts', import.meta.url), 'utf8').match(/PAGE_SALT = '([0-9a-z]+)'/i)![1]!;

describe('GFS Express tracking', () => {
  it('signs the call as the tracking page does', () => {
    const query = gfsQuery(NUMBER, 1795619339130);
    const data = `{"sn":"${NUMBER}","lan":"en"}`;
    expect(Object.fromEntries(query)).toEqual({ data, gw_ver: '1', ct: '1795619339130', plat: 'h5', appname: 'gfs',
      sign: createHash('md5').update(`1dwp.silk.outerPackageTracking2${data}1795619339130${salt}`).digest('hex') });
  });

  it("reads GFS's scans newest first, its clearance steps as transit once customs let the parcel go", () => {
    const result = normalizeCarrierResult(parseGfs(reply(), NUMBER.toLowerCase()));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-11-19T13:42:10Z', delivered_at: '2026-11-19T13:42:10Z', destination_country: 'SA' });
    expect(result.events?.map(event => [event.description, event.stage])).toEqual([
      ['Delivered', 'delivered'],
      ['Out for delivery', 'out_for_delivery'],
      ['Arrived at distribution center', 'in_transit'],
      ['Departed from distribution center', 'in_transit'],
      ['Arrived at distribution center', 'in_transit'],
      ['Parcel picked up from customs', 'in_transit'],
      ['Parcel sent', 'in_transit'],
      ['Parcel received and inbound', 'in_transit'],
      ['Customs Clearance Delivery', 'in_transit'],
      ['Customs Clearance Finished', 'in_transit'],
      ['Customs Clearance Completed', 'in_transit'],
      ['Under Customs Clearance', 'customs'],
      ['Parcel picked up from destination airport', 'in_transit'],
      ['Data Registed', 'registered'],
    ]);
  });

  it('orders scans by their clock and keeps the newest read scan when the last is unread', () => {
    const payload = reply();
    const tracks = payload.data[0].tracks as { description: string; timestamp: number }[];
    tracks.reverse();
    tracks.push({ description: 'Shipment held for an unknown reason', timestamp: tracks.at(-1)!.timestamp + 60 });
    const result = parseGfs(payload, NUMBER);
    expect(result.events?.[0]).toEqual({ time: '2026-11-19T13:43:10Z', description: 'Shipment held for an unknown reason' });
    expect(result.events?.[1]?.description).toBe('Delivered');
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivered', last_update: '2026-11-19T13:43:10Z' });
  });

  it("keeps a number GFS echoes without scans inconclusive, and another number's record unread", () => {
    expect(() => parseGfs(reply('unknown'), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    expect(() => parseGfs(reply(), 'CGD58302719465')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a refused call and a changed reply', () => {
    expect(() => parseGfs(reply('refused'), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema', message: expect.stringContaining('code 3012') }));
    expect(() => parseGfs('<html></html>', NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const change of [{ timestamp: '1763560930' }, { timestamp: 1.5 }, { description: '' }, { description: 7 }]) {
      const payload = reply();
      Object.assign(payload.data[0].tracks[0], change);
      expect(() => parseGfs(payload, NUMBER), JSON.stringify(change)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads whole wordings as providers relay them', () => {
    expect(statusMap.wholeWording).toBe(true);
    expect(statusMap.stage(null, 'customs clearance delivery')).toBe('in_transit');
    expect(statusMap.stage(null, 'under customs clearance')).toBe('customs');
  });

  it('asks the gateway with the signed query, and nothing for a number GFS does not take', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(reply()));
    const now = () => 1795619339130;
    await expect(new GfsExpressTracker({ fetcher, now }).fetch(`${NUMBER.slice(0, 6)} ${NUMBER.slice(6)}`)).resolves.toMatchObject({ status: 'delivered' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://gw.gfsxpress.com/gw/dwp.silk.outerPackageTracking/2?${gfsQuery(NUMBER, now())}`);
    expect(init).toMatchObject({ headers: expect.objectContaining({ Origin: 'https://track.gfsxpress.com' }) });

    fetcher.mockClear();
    await expect(new GfsExpressTracker({ fetcher }).fetch('CGD,1')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValue(new Response('<html></html>', { status: 200 }));
    await expect(new GfsExpressTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });

    const instance = adapter({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(json(reply('unknown'))), trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    expect(metadata.tracking.steps).toEqual(instance.steps);
    await expect(instance.track({ number: NUMBER }, {})).rejects.toMatchObject({ reason: 'portal_not_found' });
  });

  it('names GFS Express for its CGD waybills, which then need no recognition', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'gfs-express', confidence: 'high' });
    for (const near of ['CGD5830271946', 'CGD583027194641', 'CGE58302719464', 'XCGD58302719464']) {
      expect(detectCarrierMatch(near)?.candidates ?? [], near).not.toContain('gfs-express');
    }
    expect(recognitionAskedCarriers(NUMBER)).toEqual([]);
  });
});
