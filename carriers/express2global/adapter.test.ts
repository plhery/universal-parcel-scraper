import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, E2G_TRACKING, E2gTracker, e2gText, normalizeE2gNumber, parseE2g } from './adapter.js';
import { statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const OLDER = numbers.records[0]!.number;
const NEWER = numbers.records[1]!.number;
const UNKNOWN = 'E2G999010417US';
const READ_AT = Date.parse('2026-11-28T12:00:00Z');
const reply = (name: 'sf-express' | 'zto' | 'not-found') => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, ...init });
/** A reply with its rows changed. */
const edited = (name: 'sf-express' | 'zto', edit: (rows: Record<string, unknown>[]) => void) => {
  const outer = JSON.parse(reply(name)) as { status: string; data: string };
  const inner = JSON.parse(outer.data) as { rows: Record<string, unknown>[] };
  edit(inner.rows);
  return JSON.stringify({ ...outer, data: JSON.stringify(inner) });
};

describe('E2G Express tracking lookup', () => {
  it('posts the number alone to the tracking service through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(reply('sf-express')));
    const result = await new E2gTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(OLDER, { budgetMs: 5000 });
    expect(result.events).toHaveLength(10);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(E2G_TRACKING);
    expect(String(url)).toBe('http://www.hainaexpress.com/track/tracking');
    expect(init).toMatchObject({ method: 'POST', body: `num=${OLDER}`, redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'express2global', steps: ['direct', 'retry'] });
  });

  it('reads the rows newest first on China\'s clock and hands the parcel to SF Express', () => {
    const result = parseE2g(reply('sf-express'), OLDER, READ_AT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: '海关放行/包裹将由国内快递派送/顺丰速运/SF1302889312118', last_update: '2021-03-18T10:00:56+08:00',
      origin_country: 'US', destination_country: 'CN', delivery_carrier: 'sf-express', delivery_tracking_number: 'SF1302889312118' });
    const events = result.events!;
    expect(events.find((event) => event.description === '等待海关清关')).toEqual({ time: '2021-03-17T16:39:23+08:00',
      time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier', local_time: '2021-03-17T16:39:23', description: '等待海关清关',
      stage: 'customs', stage_source: 'carrier_map' });
    expect(events.at(-1)).toMatchObject({ time: '2021-03-10T03:58:34+08:00', description: '下单成功，待身份证实名认证', stage: 'registered' });
    expect(events.every((event) => event.stage_source === 'carrier_map')).toBe(true);
  });

  it('binds a newer waybill to its id and hands it to ZTO', () => {
    const result = parseE2g(reply('zto'), NEWER, READ_AT);
    expect(result).toMatchObject({ current_stage: 'in_transit', delivery_carrier: 'zto', delivery_tracking_number: '77122050129914',
      last_update: '2025-03-19T11:06:15+08:00' });
    expect(result.events).toHaveLength(11);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map')).toBe(true);
    expect(() => parseE2g(reply('zto'), 'NH990101041US', READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const mixed = edited('sf-express', (rows) => { rows[3]!.WbId = 719085500; });
    expect(() => parseE2g(mixed, OLDER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads empty rows as not found and any other answer as inconclusive', async () => {
    expect(() => parseE2g(reply('not-found'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const orders = JSON.stringify({ status: 'n', data: [{ OrderNumber: '1', UserName: '某某', UserPhone: '13800000000', TrackingNumber: UNKNOWN }] });
    expect(() => parseE2g(orders, UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseE2g(JSON.stringify({ status: 'y', data: '' }), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseE2g('<html></html>', UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(reply('not-found')));
    await expect(new E2gTracker({ fetcher }).fetch(UNKNOWN, { budgetMs: 5000 })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('sends nothing for text that is not a waybill', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const input of ['', '13800000000', 'E2G58018490US', 'LZ123456789CN']) {
      await expect(new E2gTracker({ fetcher }).fetch(input, { budgetMs: 5000 }), input).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeE2gNumber(' e2g 580184904 us ')).toBe(OLDER);
  });

  it('leaves out a part of a row that names a person or a phone', () => {
    expect(e2gText('已签收/签收人：某某/电话13800000000')).toBe('已签收');
    expect(e2gText('海关放行/包裹将由国内快递派送/顺丰速运/SF1302889312118')).toBe('海关放行/包裹将由国内快递派送/顺丰速运/SF1302889312118');
  });

  it('names E2G Express for its E2G waybills and leaves the S10 shape alone', () => {
    expect(detectCarrierMatch(OLDER).candidates).toEqual(['express2global']);
    expect(detectCarrierMatch(NEWER).candidates ?? []).not.toContain('express2global');
  });

  it('maps each text by its form in statuses.json', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMap.stage(null, normalizeStatusWording('海关放行/包裹将由国内快递派送/顺丰速运/SF0000000000001'))).toBe('in_transit');
  });
});
