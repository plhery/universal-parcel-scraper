import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseDelibox } from './parser.js';

const NUMBER = '2721200063814';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');

describe('Delibox public tracking', () => {
  it('reads the matching delivery and keeps the carrier order of tied scans', () => {
    const result = parseDelibox(fixture('delivered'), NUMBER);
    expect(result).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-06-15T21:59:00+09:00' });
    expect(result.events?.map(event => event.description)).toEqual(['배송완료', '배송출발', 'TC 입고', 'HUB 입고', '집하', '주문']);
    expect(result.events?.[0]).toMatchObject({ description: '배송완료', location: '강서화곡' });
    expect(result.events?.at(-1)?.location).toBeUndefined();
  });

  it('orders the archived table by clock even when its rows are out of order', () => {
    const result = parseDelibox(fixture('archived'), '702433319563');
    expect(result).toMatchObject({ current_stage: 'delivered', delivered_at: '2025-11-28T13:12:00+09:00' });
    expect(result.events?.map(event => event.description)).toEqual(['배송완료', '배송출발', 'TC 입고', 'HUB 입고', '집하']);
  });

  it('keeps a failed popup lookup inconclusive and rejects a wrong waybill', () => {
    expect(() => parseDelibox(fixture('unknown'), NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseDelibox(fixture('delivered'), '000000000000')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDelibox('<title>Just a moment...</title>', NUMBER)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
  });

  it('uses the supplied HTTP transport for the popup', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(fixture('delivered')));
    const tracker = adapter({ fetcher, userAgent: 'Test Agent', trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    await expect(tracker.track({ number: NUMBER }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`https://www.dbox.co.kr/delivery.php?laasInvcNo=${NUMBER}`, expect.objectContaining({
      signal: expect.any(AbortSignal), redirect: 'manual', headers: expect.objectContaining({ 'User-Agent': 'Test Agent' }),
    }));
  });
});
