import { describe, expect, it, vi } from 'vitest';
import { WahanaTracker, wahanaQuestionTarget } from './adapter.js';
import { normalizeWahanaNumber, parseWahana } from './parser.js';

const NUMBER = 'Q7ZX0812';
const row = (text: string, at = '2026-07-04 10:20:30') => `<div class="row"><div class="list-left"></div><div class="col-10 col-md-11"><div class="font-size14 font-bold">${text}</div><div class="font-size12 font-light">${at}</div></div></div>`;
const panel = (body: string) => `<div id="lacakkirimanresult"><div id="accordion">${body}</div></div>`;
const page = (history = row('Diterima di fasilitas Example Hub', '2026-07-03 09:00:00'), number = NUMBER,
  summary = row('Diterima oleh PRIVATE (Penerima Langsung)')) => panel(`<div class="card block-lacak"><div class="card-header"><div class="row"><div><div>Nomor Resi</div><div class="font-size22 font-bold">${number}</div></div><div>PRIVATE phone and address</div></div><div class="row">${summary}</div></div><div class="card-body"><div class="row"><div class="list-left"></div><div></div></div>${history}</div></div>`);
const answers = Array.from({ length: 5 }, (_, i) => String(i).padStart(20, '0'));
const challenge = () => ({ session: 'synthetic.verification.session.0000000001', question_i: 'Klik huruf/angka A.', answers });
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

describe('Wahana history', () => {
  it('keeps the complete newest-first history and carrier wall clocks without recipient details', () => {
    const result = parseWahana(page(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_update: null, last_update_local: '2026-07-04T10:20:30', last_status_text: 'Diterima oleh penerima' });
    expect(result.events).toEqual([
      { local_time: '2026-07-04T10:20:30', description: 'Diterima oleh penerima', stage: 'delivered', stage_source: 'carrier_map' },
      { local_time: '2026-07-03T09:00:00', description: 'Diterima di fasilitas Example Hub', stage: 'in_transit', stage_source: 'carrier_map' },
    ]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(result).not.toHaveProperty('history_truncated');
  });

  it('removes courier names and keeps unmapped wordings unresolved', () => {
    const result = parseWahana(page(row('Dalam proses pengantaran oleh kurir PRIVATE'), NUMBER, row('New carrier wording')), NUMBER);
    expect(result.events?.[1]).toMatchObject({ description: 'Dalam proses pengantaran oleh kurir', stage: 'out_for_delivery' });
    expect(result.events?.[0]).not.toHaveProperty('stage');
    expect(result.status).toBe('unknown');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('deduplicates before marking a capped history incomplete', () => {
    const rows = Array.from({ length: 100 }, (_, i) => row(`Diterima di fasilitas Example ${i}`)).join('');
    const result = parseWahana(page(rows), NUMBER);
    expect(result.events).toHaveLength(100);
    expect(result.history_truncated).toBe(true);
    expect(parseWahana(page(row('Diterima di fasilitas Example').repeat(120)), NUMBER).events).toHaveLength(2);
    expect(parseWahana(page(row('Diterima di fasilitas Example').repeat(120)), NUMBER)).not.toHaveProperty('history_truncated');
    expect(() => parseWahana(page(row('Diterima di fasilitas Example').repeat(501)), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('refuses wrong whole identities, multiple cards, malformed clocks and changed rows', () => {
    for (const html of [page('', NUMBER + '9'), page().replace('Nomor Resi', 'Other field'), page().replace('2026-07-04', '2026-02-30'),
      page().replace('font-size12 font-light', 'changed'), page().replace('</div></div>', '</div></div><div class="card block-lacak"></div>')]) {
      expect(() => parseWahana(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('separates a submission refusal, no history, inconclusive pages and browser walls', () => {
    expect(() => parseWahana(panel('Captcha tidak sesuai'), NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge', reason: 'verification_rejected' }));
    expect(() => parseWahana(panel('Resi tidak ditemukan'), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    expect(() => parseWahana(panel(''), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseWahana('<title>Just a moment</title>', NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseWahana('<form>Search again</form>', NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});

describe('Wahana guest verification', () => {
  it('supports only the observed single-character image prompts', () => {
    for (const question of ['Klik huruf/angka a.', 'Please click on the A.', 'Click the A.', 'Find the A.']) expect(wahanaQuestionTarget(question)).toBe('A');
    for (const question of ['Click the AA.', 'Click the A', {}, 'What is the 2nd digit in 123?']) expect(wahanaQuestionTarget(question)).toBeNull();
    expect(normalizeWahanaNumber('q7zx0812')).toBe(NUMBER);
    expect(() => normalizeWahanaNumber(NUMBER + '9')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('uses the supplied transport and same-session choices, binding the whole resi and preserving the caller UA', async () => {
    const calls: { url: URL; init: RequestInit }[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input)); calls.push({ url, init: init! });
      const response = url.hostname === 'wcaptcha.wahana.com' ? url.searchParams.get('action') === 'new'
        ? Response.json(challenge(), { headers: { 'Set-Cookie': 'guest=synthetic; Path=/; Secure' } }) : new Response(png)
        : new Response(url.pathname === '/' ? 'home' : page());
      Object.defineProperty(response, 'url', { value: url.href });
      return response;
    }) as unknown as typeof fetch;
    let index = 0;
    const solveCaptcha = vi.fn(async (_bytes: Uint8Array, signal: AbortSignal) => { expect(signal.aborted).toBe(false); return ['', 'b', 'a', '9', 'c'][index++]!; });
    const tracker = new WahanaTracker({ fetcher, userAgent: 'host-agent', solveCaptcha });
    expect((await tracker.fetch(NUMBER)).events).toHaveLength(2);
    expect(calls).toHaveLength(8);
    const lookup = calls.at(-1)!.url;
    expect(lookup.searchParams.get('noresi')).toBe(NUMBER);
    expect(lookup.searchParams.get('captcheck_selected_answer')).toBe(answers[2]);
    expect(lookup.searchParams.get('captcheck_session_code')).toBe(challenge().session);
    expect(lookup.searchParams.get('captcheck_aa')).toBe('undefined');
    for (const call of calls) { expect(new Headers(call.init.headers).get('User-Agent')).toBe('host-agent'); expect(call.init.signal).toBeInstanceOf(AbortSignal); }
    expect(new Headers(calls[2]!.init.headers).get('Cookie')).toContain('guest=synthetic');
  });

  it('refreshes at most once for an unreadable, ambiguous or refused choice', async () => {
    for (const mode of ['unreadable', 'ambiguous', 'refused']) {
      let generations = 0, lookups = 0;
      const fetcher = vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.hostname === 'wcaptcha.wahana.com') {
          if (url.searchParams.get('action') === 'new') { generations++; return Response.json(challenge()); }
          return new Response(png);
        }
        if (url.pathname === '/') return new Response('home');
        lookups++; return new Response(panel('Captcha tidak sesuai'));
      }) as unknown as typeof fetch;
      let index = 0;
      const tracker = new WahanaTracker({ fetcher, solveCaptcha: async () => mode === 'unreadable' ? '' : mode === 'ambiguous' ? 'A' : ++index % 5 === 1 ? 'A' : '' });
      await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
      expect(generations).toBe(2); expect(lookups).toBe(mode === 'refused' ? 2 : 0);
    }
  });

  it('preserves rate limits and sanitizes verification-bearing transport diagnostics', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => new URL(String(input)).hostname === 'wcaptcha.wahana.com'
      ? new Response('private body', { status: 429, headers: { 'Retry-After': '60' } }) : new Response('home')) as unknown as typeof fetch;
    await expect(new WahanaTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 60_000 });
    try { await new WahanaTracker({ fetcher }).fetch(NUMBER); } catch (error) { expect(JSON.stringify(error)).not.toContain('private body'); expect(JSON.stringify(error)).not.toContain('headers'); }
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('cancels before bootstrap and after image analysis without submitting', async () => {
    const aborted = new AbortController(); aborted.abort();
    const never = vi.fn(); await expect(new WahanaTracker({ fetcher: never }).fetch(NUMBER, { signal: aborted.signal })).rejects.toThrow(); expect(never).not.toHaveBeenCalled();
    const caller = new AbortController();
    const fetcher = vi.fn(async (input: string | URL | Request) => new URL(String(input)).hostname === 'wcaptcha.wahana.com'
      ? String(input).includes('action=new') ? Response.json(challenge()) : new Response(png) : new Response('home')) as unknown as typeof fetch;
    const tracker = new WahanaTracker({ fetcher, solveCaptcha: async () => { caller.abort(new Error('caller stopped')); return 'A'; } });
    await expect(tracker.fetch(NUMBER, { signal: caller.signal })).rejects.toThrow('caller stopped');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
