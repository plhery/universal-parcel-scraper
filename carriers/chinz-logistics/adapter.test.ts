import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseChinz } from './parser.js';

const NUMBER = 'CR122430';
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

describe('Chinz Logistics guest tracking', () => {
  it('binds the order, preserves wall clocks and removes duplicate scans', () => {
    const result = parseChinz(fixture('order'), NUMBER);
    expect(result).toMatchObject({ current_stage: 'in_transit', last_update: null, last_update_local: '2025-05-01T02:58:06' });
    expect(result.events).toHaveLength(8);
    expect(result.events?.find(event => event.provider_code === '9')).toMatchObject({ stage: 'customs', location: '中国' });
    expect(result.events?.at(-1)).toMatchObject({ stage: 'registered', location: '新西兰' });
  });

  it('keeps the order-level stage from downstream scan codes and reports separate pieces as partial', () => {
    const data = fixture('order');
    data.data[0].logicinfo.push({ order_status: -1, info_status: 'SIGNED', created_at: '2025-05-03 17:33:52', message: '您的快件已签收，签收人: 示例' });
    data.data[0].trackparcels = { SYNTHETICPIECE: [] };
    const result = parseChinz(data, NUMBER);
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: '您的快件已签收', history_truncated: true });
  });

  it('distinguishes the upstream miss from unknown envelope errors and mismatches', () => {
    expect(() => parseChinz(fixture('unknown'), NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseChinz({ ...fixture('unknown'), message: 'Something else' }, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseChinz(fixture('order'), 'CR000000')).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('does not read an HTTP 404, a block page or a malformed body as a missing order', async () => {
    const reply = (response: Response) => adapter({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response), userAgent: 'Test Agent',
      trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} }).track({ number: NUMBER }, { budgetMs: 5000 });
    await expect(reply(new Response('Not Found', { status: 404 }))).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(reply(new Response('', { status: 429 }))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(reply(new Response('<html><title>Just a moment...</title></html>'))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(reply(Response.json({ status: 400, message: '轨迹记录没找到！', data: null }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(reply(new Response('<html>oops</html>'))).rejects.not.toMatchObject({ kind: 'not_found' });
  });

  it('uses the supplied transport and the normalized order number', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(fixture('order')));
    const tracker = adapter({ fetcher, userAgent: 'Test Agent', trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    await expect(tracker.track({ number: ' cr122430 ' }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`https://nz-cn.parcelmate.vip/api/comm/order/logic?ordersns=${NUMBER}`, expect.objectContaining({
      signal: expect.any(AbortSignal), redirect: 'manual', headers: expect.objectContaining({ 'User-Agent': 'Test Agent' }),
    }));
  });
});
