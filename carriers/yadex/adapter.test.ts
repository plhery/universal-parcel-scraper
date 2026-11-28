import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, YADEX_TIMELINE } from './adapter.js';
import { normalizeYadexNumber, parseYadex } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const delivered = fixture('delivered.html');
const number = '800013858962';
const tracker = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/plain;charset=UTF-8' } });
const row = (line: string) => `<li class="layui-timeline-item"><div class="layui-timeline-content layui-text"><div class="layui-timeline-title">${line}</div></div></li>`;

describe('Yadex waybill numbers', () => {
  it('takes the digits of a waybill number', () => {
    expect(normalizeYadexNumber(' 8000 1385 8962 ')).toBe(number);
    expect(() => normalizeYadexNumber('YD800013858962')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => normalizeYadexNumber('800013')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('asks the timeline the waybill page appends, with the number alone', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(delivered));
    const result = await tracker(fetcher).track({ number });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${YADEX_TIMELINE}?nu=${number}`);
    expect(init?.method).toBe('GET');
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '快件已签收，签收站点【环滘】', last_update: null, last_update_local: '2023-01-11T15:06:58',
    });
  });

  it('reads the rows newest first on China\'s wall clock, without phone numbers or the signer', () => {
    const { events = [] } = parseYadex(delivered, number);
    expect(events.map((event) => [event.local_time, event.description, event.location, event.stage])).toEqual([
      ['2023-01-11T15:06:58', '快件已签收，签收站点【环滘】', '环滘', 'delivered'],
      ['2023-01-11T09:26:05', '到达【环滘】', '环滘', 'in_transit'],
      ['2023-01-11T09:15:09', '离开【网管中心】发往【环滘】', '网管中心', 'in_transit'],
      ['2023-01-10T23:45:10', '到达【网管中心】', '网管中心', 'in_transit'],
    ]);
    expect(JSON.stringify(events)).not.toMatch(/\d{6}|签收人|APP图片/);
    expect(events.some((event) => event.time)).toBe(false);
  });

  it('stages every recorded wording by the map, for any station', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, entry.wording.replaceAll('{station}', '虎门'))).toBe(entry.stage);
    // Synthetic: a wording the map does not know falls to the shared rules or stays without a stage,
    // and a courier's name and mobile number in it are not kept.
    const result = parseYadex(row('2023-01-11 10:00:00    派件中，派件员【张三】 13900000000') + delivered.replace(/^[\s\S]*?<\/li>/, ''), number);
    expect(result.events?.[0]?.description).toBe('派件中');
    expect(result.events?.[0]).not.toHaveProperty('location');
  });

  it('reports a number the tracker holds nothing for as not found, only when it names that number', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('not-found.txt')));
    await expect(tracker(fetcher).track({ number: '990000000017' })).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseYadex(fixture('not-found.txt'), number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('does not take a failure, a changed reply or a verification page for a missing shipment', async () => {
    expect(() => parseYadex('', number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseYadex(row('11/01/2023 15:06    快件已签收'), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseYadex(row('2023-02-30 15:06:58    快件已签收'), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const challenged = vi.fn<typeof fetch>().mockResolvedValueOnce(reply('<html><head><title>Just a moment...</title></head></html>', 403));
    await expect(tracker(challenged).track({ number })).rejects.toMatchObject({ kind: 'challenge' });
    const down = vi.fn<typeof fetch>().mockResolvedValueOnce(reply('<html><body>Service Unavailable</body></html>', 503));
    await expect(tracker(down).track({ number })).rejects.toMatchObject({ kind: 'transport' });
    const page = vi.fn<typeof fetch>().mockResolvedValueOnce(reply('<html><head><title>源安达</title></head><body></body></html>'));
    await expect(tracker(page).track({ number })).rejects.toMatchObject({ kind: 'schema' });
    // A row that names a pickup code is a scan, not a verification page.
    const coded = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(row('2023-01-11 10:00:00    已到达【环滘】，凭验证码取件') + delivered));
    await expect(tracker(coded).track({ number })).resolves.toMatchObject({ status: 'delivered' });
  });
});
