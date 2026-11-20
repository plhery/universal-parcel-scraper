import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseCargoX } from './parser.js';

const environment = { trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} };
const NUMBER = 'KAR2662560';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');

describe('Cargo X public tracking', () => {
  it('reads the requested piece history in scan order', () => {
    const result = parseCargoX(fixture('delivered'), NUMBER, 200);
    expect(result).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-09-23T14:52:00+03:00' });
    expect(result.events).toHaveLength(8);
    expect(result.events?.[0]).toMatchObject({ description: 'Teslim Edildi', location: 'Samsun Şube' });
    expect(result.events?.[2]).toMatchObject({ description: 'Süreci Devam Ediyor', original_description: 'Süreci Devam Ediyor · Randevulu Teslimat Talebi', location: 'Samsun Şube' });
    expect(result.events?.slice(-3).map(event => event.stage)).toEqual(['in_transit', 'accepted', 'registered']);
  });

  it('distinguishes an unknown shipment from a mismatched result or browser check', () => {
    expect(() => parseCargoX(fixture('unknown'), NUMBER, 404)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseCargoX(fixture('delivered'), 'KAR0000000', 200)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCargoX(fixture('delivered').replace('>KAR2662560</span>', '>KAR0000000</span>'), NUMBER, 200))
      .toThrowError(expect.objectContaining({ reason: 'listed' }));
    expect(() => parseCargoX('<title>Just a moment...</title>', NUMBER, 200)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseCargoX('<h1>404</h1>', NUMBER, 404)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('follows the carrier redirect with the supplied transport and request context', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/fictional-target' } }))
      .mockResolvedValueOnce(new Response(fixture('delivered')));
    const result = await adapter({ ...environment, fetcher, userAgent: 'Test Agent' }).track({ number: NUMBER }, { budgetMs: 5000 });
    expect(result.events).toHaveLength(8);
    const options = expect.objectContaining({ redirect: 'manual', signal: expect.any(AbortSignal), headers: expect.objectContaining({ 'User-Agent': 'Test Agent' }) });
    expect(fetcher).toHaveBeenNthCalledWith(1, `https://t.cargox.com.tr/getlink.php?barcode=${NUMBER}`, options);
    expect(String(fetcher.mock.calls[1]?.[0])).toBe('https://t.cargox.com.tr/fictional-target');
    expect(fetcher.mock.calls[1]?.[1]).toEqual(options);
  });

  it('refuses an unexpected redirect and preserves rate limits', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.redirect('https://example.com/unexpected'));
    const tracker = adapter({ ...environment, fetcher });
    await expect(tracker.track({ number: NUMBER }, {})).rejects.toMatchObject({ kind: 'transport' });
    expect(fetcher).toHaveBeenCalledOnce();
    fetcher.mockResolvedValueOnce(Response.redirect('https://t.cargox.com.tr/fictional-target'))
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '60' } }));
    await expect(tracker.track({ number: NUMBER }, {})).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 60_000 });
  });
});
