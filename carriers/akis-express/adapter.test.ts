import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import delivered from './fixtures/delivered.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const number = 'S220044843';

describe('AKIS Express tracking', () => {
  it('posts the requested number and reads its station history', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(delivered));
    const result = await adapter({ trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER, fetcher, userAgent: 'AKIS test' }).track({ number }, {});
    const [url, request] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://gapakisexpress.com/wp-admin/admin-ajax.php');
    expect(String(request?.body)).toBe('action=tracking_show_table&tracking_num=S220044843');
    expect(new Headers(request?.headers).get('User-Agent')).toBe('AKIS test');
    expect(result.current_stage).toBe('delivered');
    expect(result.events).toHaveLength(6);
    expect(result.events?.[0]).toMatchObject({ local_time: '2024-06-14T16:40:00', location: 'AGIOS ATHANASIOS', stage: 'delivered' });
    expect(result.events?.at(-1)?.stage).toBe('registered');
  });

  it('reports a missing endpoint as a transport failure', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
    const carrier = adapter({ trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER, fetcher });
    await expect(carrier.track({ number }, {})).rejects.toMatchObject({ kind: 'transport', status: 404 });
  });

  it('binds history to the whole number', () => {
    expect(() => parseTracking(JSON.stringify(delivered), number.slice(0, -1))).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('distinguishes the empty result from a block or malformed reply', () => {
    const absent = { ...delivered, html: delivered.html.replace(/<tbody>[\s\S]*?<\/tbody>/, '<tbody><tr></tr></tbody>') };
    expect(() => parseTracking(JSON.stringify(absent), number)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTracking('<title>Just a moment</title>', number)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseTracking('{}', number)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});
