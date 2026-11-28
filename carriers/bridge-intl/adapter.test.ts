import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, BRIDGE_LOOKUP, BridgeTracker } from './adapter.js';
import { normalizeBridgeNumber, parseBridge } from './parser.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample's reply, with the recipient's street taken out of the address.
const SAMPLE = 'AU111492026SG';
const INVENTED = 'AU000000000SG';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Bridge Intl numbers', () => {
  it('takes letters and digits with a digit', () => {
    expect(normalizeBridgeNumber(` ${SAMPLE.toLowerCase()} `)).toBe(SAMPLE);
    for (const other of ['', 'AU11', 'ABCDEFGH', 'AU1114920!26SG']) {
      expect(() => normalizeBridgeNumber(other), other).toThrow('6 to 30 letters and digits');
    }
  });
});

describe('Bridge Intl tracking adapter', () => {
  it('asks the query page\'s lookup for the number', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => html(fixture('customs')));
    await expect(new BridgeTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(SAMPLE.toLowerCase())).resolves.toMatchObject({ current_stage: 'customs' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${BRIDGE_LOOKUP}?q=${SAMPLE}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', headers: expect.objectContaining({ Referer: 'https://www.bri-ems.com/query' }) });
    expect(carrier(fetcher)).toMatchObject({ id: 'bridge-intl', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the fragment\'s "no record" as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => html(fixture('not-found')));
    await expect(carrier(fetcher).track({ number: INVENTED })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps refusals, block pages, error replies and redirects apart from a missing order', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: INVENTED }, { budgetMs: 2000 }).catch((error: unknown) => error);
    expect(await answer(() => html('<html><title>Just a moment...</title><script>_cf_chl_opt={}</script></html>', 403))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<html><title>Just a moment...</title><script>_cf_chl_opt={}</script></html>'))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<html><body>Bridge</body></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => html('Something else'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => html(''))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => html('Too Many Requests', 429))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => html('Service Unavailable', 503))).toMatchObject({ kind: 'maintenance' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: 'https://www.bri-ems.com/' } }))).toMatchObject({ kind: 'transport' });
  });
});

describe('Bridge Intl replies', () => {
  it('reads the sample: its rows by day, its weight and the Chinese courier that takes it on', () => {
    const row = (local_time: string, description: string, stage: string) => ({ local_time, description, stage, stage_source: 'carrier_map' });
    expect(parseBridge(fixture('customs'), SAMPLE)).toEqual({
      status: 'in_transit', current_stage: 'customs', current_stage_source: 'carrier_map',
      last_status_text: '您的包裹已经到达中国，进入核对，正在清关', last_update: null, last_update_local: '2021-03-19', expected_delivery: null,
      weight_kg: 1.8, origin_country: 'AU', destination_country: 'CN', delivery_tracking_number: '9975674610015',
      events: [
        // The batch code the page hides in white is not part of the text.
        row('2021-03-19', '您的包裹已经到达中国，进入核对，正在清关', 'customs'),
        row('2021-03-17', '您的包裹已发往中国', 'in_transit'),
        row('2021-03-12', '您的包裹在等待航班中', 'in_transit'),
        row('2021-03-11', '您的包裹正在过机查验', 'in_transit'),
        row('2021-03-10', '您的包裹已送往Perth 国际机场', 'in_transit'),
        row('2021-03-09', '您的包裹已经收件成功，进入珀斯（Perth）分拣中心', 'accepted'),
        row('2021-03-08', '您的包裹已经收件', 'accepted'),
      ],
    });
  });

  it('stands on the order line without rows, and keeps an order without either open', () => {
    const bare = fixture('customs').replace(/<b><br\/>前段跟踪记录[\s\S]*$/u, '');
    expect(parseBridge(bare, SAMPLE)).toMatchObject({
      status: 'pending', current_stage: 'registered', last_status_text: '订单已生成', last_update_local: '2021-03-08', summary_only: true, events: [],
    });
    expect(parseBridge(bare, SAMPLE)).not.toHaveProperty('delivery_tracking_number');
    expect(() => parseBridge(bare.replace('订单已生成', '新状态'), SAMPLE)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('rejects a reply for another order and malformed rows', () => {
    expect(() => parseBridge(fixture('customs'), INVENTED)).toThrow('another order');
    expect(() => parseBridge(fixture('customs').replace('<td>2021-03-11</td>', '<td>2021-02-30</td>'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBridge(fixture('customs').replace('<td>2021-03-11</td>', ''), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBridge(fixture('customs').replace('订单号', '单号'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it("answers every wording statuses.json records by Bridge Intl's map", () => {
    for (const entry of statuses.entries) {
      expect(statusMapAnswer({ carrier: 'bridge-intl', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
  });
});
