import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseDelibox } from './parser.js';

const NUMBER = '2721200063814';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const tracker = (fetcher: typeof fetch) => adapter({ fetcher, userAgent: 'Test Agent', trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });

describe('Delibox public tracking', () => {
  it('reads the matching delivery and keeps the carrier order of tied scans', () => {
    const result = parseDelibox(fixture('delivered'), NUMBER);
    expect(result).toMatchObject({ current_stage: 'delivered', last_update: null, last_update_local: '2026-06-15T21:59:00' });
    expect(result.events?.map(event => event.description)).toEqual(['배송완료', '배송출발', 'TC 입고', 'HUB 입고', '집하', '주문']);
    expect(result.events?.[0]).toMatchObject({ description: '배송완료', location: '강서화곡' });
    expect(result.events?.at(-1)?.location).toBeUndefined();
  });

  it('keeps the zoneless wall clocks as local times without an instant', () => {
    const result = parseDelibox(fixture('delivered'), NUMBER);
    expect(result.delivered_at).toBeUndefined();
    expect(result.events?.map(event => event.local_time)).toEqual([
      '2026-06-15T21:59:00', '2026-06-15T16:12:00', '2026-06-15T15:00:00', '2026-06-15T15:00:00', '2026-06-15T15:00:00', '2026-06-15T01:48:00',
    ]);
    expect(result.events?.every(event => event.time === undefined)).toBe(true);
  });

  it('orders the archived table by clock even when its rows are out of order', () => {
    const result = parseDelibox(fixture('archived'), '702433319563');
    expect(result).toMatchObject({ current_stage: 'delivered', last_update_local: '2025-11-28T13:12:00' });
    expect(result.events?.map(event => event.description)).toEqual(['배송완료', '배송출발', 'TC 입고', 'HUB 입고', '집하']);
  });

  it('keeps the popup alert inconclusive as the carrier\'s own empty answer and rejects a wrong waybill', () => {
    expect(() => parseDelibox(fixture('unknown'), NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    expect(() => parseDelibox(fixture('delivered'), '000000000000')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDelibox('<title>Just a moment...</title>', NUMBER)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
  });

  it('never reads an empty or foreign page as a missing waybill', () => {
    expect(() => parseDelibox('', NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDelibox('<html><title>403 Forbidden</title><body>blocked</body></html>', NUMBER))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('uses the supplied HTTP transport for the popup', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(fixture('delivered')));
    await expect(tracker(fetcher).track({ number: NUMBER }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`https://www.dbox.co.kr/delivery.php?laasInvcNo=${NUMBER}`, expect.objectContaining({
      signal: expect.any(AbortSignal), redirect: 'manual', headers: expect.objectContaining({ 'User-Agent': 'Test Agent' }),
    }));
  });

  it('does not read an HTTP 404 as a missing waybill and keeps a rate limit', async () => {
    const missing = vi.fn<typeof fetch>().mockResolvedValue(new Response('Not Found', { status: 404 }));
    await expect(tracker(missing).track({ number: NUMBER }, { budgetMs: 5000 })).rejects.toMatchObject({ kind: 'transport', status: 404 });
    const limited = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429 }));
    await expect(tracker(limited).track({ number: NUMBER }, { budgetMs: 5000 })).rejects.toMatchObject({ kind: 'rate_limited' });
  });
});
