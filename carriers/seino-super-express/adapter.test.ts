import { describe, expect, it, vi } from 'vitest';
import { BudgetExceededError, ChallengeError, carrierErrorKind, InvalidInputError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import { fixture, NUMBER } from '../../testing/seinoSuperExpressFixture.js';
import { SeinoSuperExpressTracker } from './adapter.js';
import { DETAIL_URL, SUMMARY_URL } from './parser.js';

const html = (body: string, cookie?: string) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', ...(cookie ? { 'set-cookie': 'JSESSIONID=' + cookie + '; Path=/inquire; HttpOnly' } : {}) } });

describe('Seino Super Express HTTP tracking', () => {
  it('uses the supplied transport, fresh guest state and the detail transaction history', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(html(fixture(), 'synthetic-session')).mockResolvedValueOnce(html(fixture('detail')));
    const result = await new SeinoSuperExpressTracker({ fetcher, userAgent: 'synthetic-agent' }).fetch(NUMBER);
    expect(result.events).toHaveLength(3);
    expect(result.events?.[0]?.provider_time_text).toBe('01/01 00:10');
    expect(fetcher.mock.calls.map(c => String(c[0]))).toEqual([SUMMARY_URL, DETAIL_URL]);
    const summary = new URLSearchParams(String(fetcher.mock.calls[0]![1]!.body));
    const detail = new URLSearchParams(String(fetcher.mock.calls[1]![1]!.body));
    expect(summary.get('strDenpyoNo1')).toBe(NUMBER);
    expect(detail.get('strDenpyoNo')).toBe(NUMBER.padStart(15, '0'));
    expect(detail.get('strNinsyoNo')).toBe('SYNTHETICCAP');
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST', redirect: 'manual', headers: { Cookie: 'JSESSIONID=synthetic-session', 'User-Agent': 'synthetic-agent' } });
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC|synthetic-session|Cookie|strNinsyo/);
  });

  it('makes no detail request for the exact number-bound missing response', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(html(fixture('summary', { missing: true })));
    await expect(new SeinoSuperExpressTracker({ fetcher }).fetch(NUMBER)).rejects.toBeInstanceOf(NotFoundError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 428])('keeps HTTP %s a challenge', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('Refused', { status }));
    await expect(new SeinoSuperExpressTracker({ fetcher }).fetch(NUMBER)).rejects.toBeInstanceOf(ChallengeError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([302, 404, 410])('does not infer parcel absence from HTTP %s', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('Unavailable', { status }));
    await expect(new SeinoSuperExpressTracker({ fetcher }).fetch(NUMBER)).rejects.toBeInstanceOf(TransportError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps rate limiting distinct and makes no immediate retry', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('Wait', { status: 429, headers: { 'retry-after': '60' } }));
    const error = await new SeinoSuperExpressTracker({ fetcher }).fetch(NUMBER).catch(e => e);
    expect(carrierErrorKind(error)).toBe('rate_limited');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not hide a protected detail response behind the sparse summary', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(html(fixture())).mockResolvedValueOnce(new Response('Refused', { status: 403 }));
    await expect(new SeinoSuperExpressTracker({ fetcher }).fetch(NUMBER)).rejects.toBeInstanceOf(ChallengeError);
  });

  it('rejects another slip in the detail view', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(html(fixture())).mockResolvedValueOnce(html(fixture('detail', { number: '9876543210' })));
    await expect(new SeinoSuperExpressTracker({ fetcher }).fetch(NUMBER)).rejects.toBeInstanceOf(SchemaError);
  });

  it('keeps an unsupported character encoding a schema failure', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('unreadable', { headers: { 'content-type': 'text/html; charset=unsupported-ssx-encoding' } }));
    await expect(new SeinoSuperExpressTracker({ fetcher }).fetch(NUMBER)).rejects.toBeInstanceOf(SchemaError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('cancels between views without starting the detail request', async () => {
    const controller = new AbortController(), reason = new Error('synthetic cancellation');
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => { controller.abort(reason); return html(fixture()); });
    await expect(new SeinoSuperExpressTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toBe(reason);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not send unsupported input or a spent budget', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new SeinoSuperExpressTracker({ fetcher }).fetch('AA123456789JP')).rejects.toBeInstanceOf(InvalidInputError);
    await expect(new SeinoSuperExpressTracker({ fetcher }).fetch(NUMBER, { budgetMs: 0 })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not start a second request after synchronous work spends the deadline', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      const until = performance.now() + 15;
      while (performance.now() < until) { /* A blocked event loop has not delivered the abort timer yet. */ }
      return html(fixture());
    });
    await expect(new SeinoSuperExpressTracker({ fetcher }).fetch(NUMBER, { budgetMs: 5 })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('keeps simultaneous lookup cookies and detail capabilities separate', async () => {
    const other = '9876543210';
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = new URLSearchParams(String(init?.body));
      const number = body.get('strDenpyoNo1');
      if (body.get('uji.verbs') === 'NAHS0010_find') return html(fixture('summary', { number: number!, capability: number === NUMBER ? 'CAPA' : 'CAPB' }), number === NUMBER ? 'SESSION_A' : 'SESSION_B');
      const isFirst = body.get('strDenpyoNo') === NUMBER.padStart(15, '0');
      expect(body.get('strNinsyoNo')).toBe(isFirst ? 'CAPA' : 'CAPB');
      expect(new Headers(init?.headers).get('cookie')).toBe('JSESSIONID=' + (isFirst ? 'SESSION_A' : 'SESSION_B'));
      return html(fixture('detail', { number: isFirst ? NUMBER : other }));
    });
    const tracker = new SeinoSuperExpressTracker({ fetcher });
    const results = await Promise.all([tracker.fetch(NUMBER), tracker.fetch(other)]);
    expect(results.map(r => r.events?.length)).toEqual([3, 3]);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
