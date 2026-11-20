import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createTracker } from '../../facade/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, HonducorTracker } from './adapter.js';
import { HONDUCOR_ORIGIN, honducorForm, honducorResultUrl, honducorWording, normalizeHonducorNumber, parseHonducor } from './parser.js';
import { parseHonducorChallenge, solveHonducorChallenge } from './pow.js';
import { honducorStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'EE719405284HN';
const OTHER = 'EE719405285HN';
const html = readFileSync(new URL('./fixtures/delivered.html', import.meta.url), 'utf8');
const vector = JSON.parse(readFileSync(new URL('./fixtures/challenge.json', import.meta.url), 'utf8')) as {
  challenge: { parameters: Record<string, unknown>; signature: string }; expected: { counter: number; digest: string };
};
const expectedSolution = { counter: vector.expected.counter, derivedKey: vector.expected.digest };
const challenge = () => ({ ...vector.challenge, parameters: { ...vector.challenge.parameters, expiresAt: Math.floor(Date.now() / 1000) + 300 } });
const page = (body = html) => new Response(body, { headers: { 'Content-Type': 'text/html' } });
const at = (response: Response, input: RequestInfo | URL) => { Object.defineProperty(response, 'url', { value: input instanceof Request ? input.url : String(input) }); return response; };
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const make = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Honducor guest tracking', () => {
  it('reads the matching result and all displayed clocks, excluding the page query clock and signer', () => {
    const result = parseHonducor(html, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null,
      last_update_local: '2026-10-22T13:38:00', expected_delivery: null });
    expect(result.events).toHaveLength(9);
    expect(result.events!.every(event => event.local_time && !event.time)).toBe(true);
    expect(result.events!.slice(0, 2).map(event => event.local_time)).toEqual(['2026-10-22T13:38:00', '2026-10-22T07:38:00']);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE RECIPIENT|簽收人姓名|2026-11-20|altcha|signature|tracking_number/);
    expect(honducorWording('投遞成功, 簽收人姓名:SAMPLE RECIPIENT')).toBe('投遞成功');
    expect(honducorStage('投遞成功, 簽收人姓名:SAMPLE RECIPIENT')).toMatchObject({ stage: 'delivered' });
    expect(honducorWording('SAMPLE SCAN, additional operational detail')).toBe('SAMPLE SCAN, additional operational detail');
    for (const row of statuses.entries) expect(honducorStage(row.wording)).toEqual({ stage: row.stage, source: 'carrier_map' });
    expect(honducorStage('SAMPLE UNKNOWN SCAN')).toBeNull();
  });

  it('requires the result identity even when the input still echoes the requested number', () => {
    expect(() => parseHonducor(html.replace('<strong>Guía</strong>' + NUMBER, '<strong>Guía</strong>' + OTHER), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHonducor(html.replace('<strong>Guía</strong>', '<strong>Reference</strong>'), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHonducor(html.replace('<div class="pt_summary">', '<div class="pt_summary"></div><div class="pt_summary">'), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('does not confirm the Honduras network from foreign postal history alone', () => {
    expect(() => parseHonducor(html.replaceAll('HNTGUA', 'TWTPEX'), NUMBER))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError', reason: 'external_history' }));
  });

  it('keeps missing, unfinished and refused replies distinct from a missing parcel', () => {
    expect(() => parseHonducor(html.replace(/<article[\s\S]*<\/article>/, ''), NUMBER))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError', kind: 'indeterminate' }));
    expect(() => parseHonducor('<form id="trackingForm"></form><div class="pt_alert">Esperando información del proveedor</div>', NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHonducor('<div class="pt_alert">Verificación ALTCHA inválida</div>', NUMBER))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseHonducor('<title>Just a moment</title>', NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('rejects changed clock and event layouts', () => {
    for (const bad of ['2026-02-30 13:38:00', '2026-10-22 24:00:00', '2026-10-22T13:38:00Z']) {
      expect(() => parseHonducor(html.replace('2026-10-22 13:38:00', bad), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseHonducor(html.replace('class="pt_date"', 'class="other"'), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('uses only the current guest form and preserves its anonymous hidden state', () => {
    expect([...honducorForm(html)]).toEqual([]);
    const csrf = html.replace('<input name="tracking_number"', '<input type="hidden" name="csrf_token" value="synthetic"><input name="tracking_number"');
    expect(honducorForm(csrf).get('csrf_token')).toBe('synthetic');
    for (const changed of [html.replace('action="/rastreo"', 'action="/account"'), html.replace('name="altcha"', 'name="other"')]) {
      expect(() => honducorForm(changed)).toThrow();
    }
  });

  it('follows just the native same-origin navigation for the whole reference', () => {
    expect(honducorResultUrl('/rastreo?tracking_number=' + NUMBER, NUMBER)).toBe(HONDUCOR_ORIGIN + '/rastreo?tracking_number=' + NUMBER);
    for (const value of [null, '/rastreo', '/rastreo?tracking_number=' + OTHER,
      '/rastreo?tracking_number=' + NUMBER + '&tracking_number=' + NUMBER,
      '/rastreo?tracking_number=' + NUMBER + '&next=1', '/rastreo?tracking_number=' + NUMBER + '#x',
      'http://rastreo.honducor.gob.hn/rastreo?tracking_number=' + NUMBER,
      'https://other.invalid/rastreo?tracking_number=' + NUMBER]) expect(() => honducorResultUrl(value, NUMBER)).toThrow();
  });

  it('matches the exact published worker nonzero-counter vector', async () => {
    const c = parseHonducorChallenge(challenge());
    const encoded = await solveHonducorChallenge(c, new AbortController().signal, performance.now() + 5000, 5000);
    const proof = JSON.parse(Buffer.from(encoded, 'base64').toString()) as { challenge: unknown; solution: { counter: number; derivedKey: string } };
    expect(proof.challenge).toEqual(c);
    expect(proof.solution).toMatchObject(expectedSolution);
  });

  it('declines expired, malformed or costlier challenges', () => {
    for (const p of [{ cost: 40001 }, { algorithm: 'other' }, { expiresAt: 1 }, { keyPrefix: 'abc' }, { nonce: 'bad' }, { extra: 1 }]) {
      expect(() => parseHonducorChallenge({ ...challenge(), parameters: { ...challenge().parameters, ...p } }))
        .toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
  });

  it('stops computing before a cancelled or exhausted lookup can submit', async () => {
    const c = parseHonducorChallenge(challenge());
    await expect(solveHonducorChallenge(c, AbortSignal.abort(new Error('cancelled')), performance.now() + 1000, 1000)).rejects.toThrow('cancelled');
    await expect(solveHonducorChallenge(c, new AbortController().signal, performance.now() - 1, 1)).rejects.toMatchObject({ kind: 'budget' });
    const controller = new AbortController();
    const solving = solveHonducorChallenge(c, controller.signal, performance.now() + 1000, 1000);
    controller.abort(new Error('cancelled after yielding'));
    await expect(solving).rejects.toThrow('cancelled after yielding');
  });

  it('uses the supplied transport, one fresh jar and the form POST/303/result sequence', async () => {
    const c = challenge(), seen: string[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const u = new URL(String(input)), method = init?.method ?? 'GET';seen.push(method + ' ' + u.pathname);
      if (u.origin !== HONDUCOR_ORIGIN) throw new Error('unexpected egress');
      if (u.pathname === '/' && method === 'GET') return at(new Response(html, { headers: { 'Set-Cookie': 'guest=synthetic; Secure; Path=/' } }), input);
      expect(new Headers(init?.headers).get('cookie')).toBe('guest=synthetic');
      if (u.pathname === '/rastreo/altcha/challenge' && method === 'GET') return at(json(c), input);
      if (u.pathname === '/rastreo' && method === 'POST') {
        const form = new URLSearchParams(String(init?.body));expect(form.get('tracking_number')).toBe(NUMBER);
        expect(JSON.parse(Buffer.from(form.get('altcha')!, 'base64').toString())).toMatchObject({ challenge: c, solution: expectedSolution });
        return at(new Response(null, { status: 303, headers: { Location: '/rastreo?tracking_number=' + NUMBER } }), input);
      }
      if (u.pathname === '/rastreo' && method === 'GET' && u.searchParams.get('tracking_number') === NUMBER) return at(page(), input);
      throw new Error('unexpected egress');
    });
    const result = await new HonducorTracker({ fetcher }).fetch(NUMBER, { budgetMs: 10_000 });
    expect(result.events).toHaveLength(9);
    expect(seen).toEqual(['GET /', 'GET /rastreo/altcha/challenge', 'POST /rastreo', 'GET /rastreo']);
  });

  it('preserves rate limits and never retries a refused request with a spent proof', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('synthetic refusal', { status: 429, headers: { 'Retry-After': '5' } }));
    await expect(make(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'rate_limited', status: 429, retryAfterMs: 5000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed identifiers and pre-cancelled lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', '12345678', 'EE719405284HN,EE719405285HN', 'A'.repeat(65)]) expect(() => normalizeHonducorNumber(number)).toThrow();
    expect(normalizeHonducorNumber(' ee 719405284 hn ')).toBe(NUMBER);
    await expect(make(fetcher).track({ number: NUMBER }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('serves a parcel filed under Honducor through the public tracker', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== HONDUCOR_ORIGIN) throw new Error('unexpected egress');
      if (url.pathname === '/rastreo/altcha/challenge') return at(json(challenge()), input);
      if (init?.method === 'POST') return at(new Response(null, { status: 303, headers: { Location: '/rastreo?tracking_number=' + NUMBER } }), input);
      return at(page(), input);
    });
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: NUMBER, carrier: 'honducor' }, { budgetMs: 10_000 });
    expect(answer).toMatchObject({ source: 'honducor', carrier: 'honducor', result: { current_stage: 'delivered' } });
    expect(answer.result.events).toHaveLength(9);
    expect(answer.result.events.map(event => event.local_time)).toEqual(parseHonducor(html, NUMBER).events!.map(event => event.local_time));
    expect(answer.result.events.every(event => !event.time || event.time_zone_basis)).toBe(true);
  });
});
