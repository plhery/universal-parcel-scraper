import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, DRAGONFE_TRACK } from './adapter.js';
import { normalizeDragonfeNumber, parseDragonfe } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const inCustoms = fixture('in-customs.html');
const notFound = fixture('not-found.html');
const number = 'JPNDFE230201060565';
const tracker = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const page = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

describe('DF Logistics waybill numbers', () => {
  it('takes one waybill in letters and digits', () => {
    expect(normalizeDragonfeNumber(' jpndfe 2302 0106 0565 ')).toBe(number);
    for (const raw of ['JPNDFE', 'DF123', `${number}/x`]) {
      expect(() => normalizeDragonfeNumber(raw)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('DF Logistics tracker', () => {
  it('opens the page the home page\'s form frames, with the number in its path', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(page(inCustoms));
    const result = await tracker(fetcher).track({ number });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${DRAGONFE_TRACK}/${number}`);
    expect(init?.method).toBe('GET');
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'customs', current_stage_source: 'carrier_map',
      last_status_text: '包裹清关中，请耐心等待', last_update: null, last_update_local: '2023-02-10T16:06:00', destination_country: 'CN',
    });
  });

  it('reads the rows newest first on their wall clock, with the warehouse they name', () => {
    const { events = [] } = parseDragonfe(inCustoms, number);
    expect(events.map((event) => [event.local_time, event.location, event.stage])).toEqual([
      ['2023-02-10T16:06:00', undefined, 'customs'],
      ['2023-02-10T09:06:00', undefined, 'customs'],
      ['2023-02-09T21:12:00', undefined, 'in_transit'],
      ['2023-02-09T18:23:00', undefined, 'in_transit'],
      ['2023-02-09T13:03:00', '日本大阪仓', 'in_transit'],
      ['2023-02-09T08:10:00', '日本大阪仓', 'accepted'],
      ['2023-02-08T16:01:00', '日本大阪', 'accepted'],
    ]);
    expect(events.some((event) => event.time)).toBe(false);
  });

  it('stages every recorded wording by the map, for any warehouse', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, entry.wording.replaceAll('{station}', '韩国仁川仓'))).toBe(entry.stage);
    // Synthetic: a later wording the map does not know falls to the shared rules.
    const signed = inCustoms.replace('</tbody>', '<tr><td>2023-02-12 10:00:00</td><td>包裹已签收</td></tr></tbody>');
    expect(parseDragonfe(signed, number)).toMatchObject({ status: 'delivered', last_update_local: '2023-02-12T10:00:00' });
  });

  it('reports a number the tracker holds nothing for as not found, only when the page names that number', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(page(notFound));
    await expect(tracker(fetcher).track({ number: 'JPNDFE000000000000' })).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseDragonfe(notFound, number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseDragonfe(inCustoms, 'JPNDFE230201060566')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('does not take a failure, a changed page or a verification page for a missing shipment', async () => {
    expect(() => parseDragonfe('<table class="logistics-table"></table>', number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDragonfe(inCustoms.replace('暂未', ''), number)).not.toThrow();
    expect(() => parseDragonfe(inCustoms.replace('2023-02-10 16:06:00', '10/02/2023 16:06'), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDragonfe(notFound.replace('暂未查到包裹相关数据', ''), 'JPNDFE000000000000')).toThrow(expect.objectContaining({ kind: 'schema' }));
    const challenged = vi.fn<typeof fetch>().mockResolvedValueOnce(page('<html><head><title>Just a moment...</title></head></html>', 403));
    await expect(tracker(challenged).track({ number })).rejects.toMatchObject({ kind: 'challenge' });
    const blocked = vi.fn<typeof fetch>().mockResolvedValueOnce(page('<html><body>请输入验证码</body></html>'));
    await expect(tracker(blocked).track({ number })).rejects.toMatchObject({ kind: 'challenge' });
    const down = vi.fn<typeof fetch>().mockResolvedValueOnce(page('<html><body>Service Unavailable</body></html>', 503));
    await expect(tracker(down).track({ number })).rejects.toMatchObject({ kind: 'transport' });
    const other = vi.fn<typeof fetch>().mockResolvedValueOnce(page('<html><head><title>系统发生错误</title></head><body></body></html>'));
    await expect(tracker(other).track({ number })).rejects.toMatchObject({ kind: 'schema' });
  });
});
