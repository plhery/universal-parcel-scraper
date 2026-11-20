import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, BestExpressVnTracker } from './adapter.js';

const PUBLIC = '84859234749299';
const CAPTCHA = 'https://captcha-sg.800best.com/api/captcha';
const LOOKUP = 'https://www.best-inc.vn/express-cc/express/expresslistinfo';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const json = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json;charset=UTF-8' } });
const pass = () => json({ code: '200', success: true, data: { code: 'synthetic-code', validate: 'synthetic-validate', verifyReq: 0 } });
const wrong = () => json({ code: '5002', success: false, message: 'synthetic refusal' });
const found = () => json(fixture('delivered.json'));

/** A synthetic verification service and tracker: each picture's instance, then the answers and lookups in turn. */
function service(verifies: (() => Response)[], lookups: (() => Response)[] = [found], init: () => Response | null = () => null) {
  const requests: { url: string; headers: Headers; body?: string; at: number }[] = [];
  let pictures = 0, verify = 0, lookup = 0;
  const fetcher = vi.fn(async (input: string | URL | Request, request?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push({ url, headers: new Headers(request?.headers), body: typeof request?.body === 'string' ? request.body : undefined, at: performance.now() });
    if (url === `${CAPTCHA}/init`) {
      return init() ?? json({ code: '200', success: true, data: { instanceId: `synthetic-instance-${++pictures}`, type: 'rotate_pic', imageEncryption: false } });
    }
    if (url.startsWith(`${CAPTCHA}/resource?`)) return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { 'Content-Type': 'image/*;charset=UTF-8' } });
    if (url === `${CAPTCHA}/verify/first`) return verifies[Math.min(verify++, verifies.length - 1)]!();
    if (url.startsWith(`${LOOKUP}?`)) return lookups[Math.min(lookup++, lookups.length - 1)]!();
    return new Response('unexpected', { status: 500 });
  }) as unknown as typeof fetch;
  return { fetcher, requests };
}

const answers = (...values: string[]) => {
  let index = 0;
  return vi.fn(async () => values[Math.min(index++, values.length - 1)]!);
};
const only = <T extends { url: string }>(requests: T[], prefix: string) => requests.filter(request => request.url.startsWith(prefix));
const tracker = (fetcher: typeof fetch, solveRotation: ReturnType<typeof answers>, settleMs = 0) =>
  new BestExpressVnTracker({ fetcher, solveRotation, settleMs });

describe('BEST Express Vietnam tracker lookup', () => {
  it('answers each picture once, with the verification it earned, and takes a new picture after a refusal', async () => {
    const { fetcher, requests } = service([wrong, pass]);
    const solve = answers('231.700', '17.400');
    const result = await tracker(fetcher, solve).fetch(' 8485 9234 749299 ');
    expect(result).toMatchObject({ current_stage: 'delivered', signed_by: 'Lê Trần Trí Nhu' });
    expect(solve).toHaveBeenCalledTimes(2);
    expect(only(requests, `${CAPTCHA}/init`).map(request => request.body)).toEqual(Array(2).fill('appKey=ef49c150db25a98c410bae455cc3ec79&type=rotate_pic'));
    expect(only(requests, `${CAPTCHA}/verify/first`).map(request => Object.fromEntries(new URLSearchParams(request.body)))).toEqual([
      { appKey: 'ef49c150db25a98c410bae455cc3ec79', instanceId: 'synthetic-instance-1', verifyReq: '232' },
      { appKey: 'ef49c150db25a98c410bae455cc3ec79', instanceId: 'synthetic-instance-2', verifyReq: '17' },
    ]);
    const picture = new URL(only(requests, `${CAPTCHA}/resource?`)[1]!.url);
    expect(Object.fromEntries(picture.searchParams)).toMatchObject({ source: 'web', appKey: 'ef49c150db25a98c410bae455cc3ec79', instanceId: 'synthetic-instance-2' });
    const [lookup] = only(requests, `${LOOKUP}?`);
    expect(Object.fromEntries(new URL(lookup!.url).searchParams)).toEqual({ instanceId: 'synthetic-instance-2', code: 'synthetic-code', validate: 'synthetic-validate' });
    expect(JSON.parse(lookup!.body!)).toEqual({ expressIds: [PUBLIC] });
    expect(lookup!.headers.get('content-type')).toBe('application/json');
    expect(lookup!.headers.get('lang-type')).toBe('vi-VN');
    for (const request of requests) expect(request.headers.get('origin')).toBe('https://www.best-inc.vn');
  });

  it('waits after the picture before it answers, as a person would', async () => {
    const { fetcher, requests } = service([pass]);
    await tracker(fetcher, answers('10'), 120).fetch(PUBLIC);
    const [picture] = only(requests, `${CAPTCHA}/resource?`), [verify] = only(requests, `${CAPTCHA}/verify/first`);
    expect(verify!.at - picture!.at).toBeGreaterThanOrEqual(110);
  });

  it('takes a new picture without an answer when the solver does not know it, and after a refused verification', async () => {
    const { fetcher, requests } = service([pass], [() => json(fixture('risk.json')), found]);
    await tracker(fetcher, answers('', '400', '10', '20')).fetch(PUBLIC);
    expect(only(requests, `${CAPTCHA}/init`)).toHaveLength(4);
    expect(only(requests, `${CAPTCHA}/verify/first`)).toHaveLength(2);
    expect(only(requests, `${LOOKUP}?`)).toHaveLength(2);
  });

  it('answers not found only past an accepted picture', async () => {
    const { fetcher } = service([pass], [() => json(fixture('not-found.json'))]);
    await expect(tracker(fetcher, answers('10')).fetch('00000000000000')).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('gives up as a challenge after eight refused answers, or sixteen pictures none matched', async () => {
    const { fetcher, requests } = service([wrong]);
    await expect(tracker(fetcher, answers('10')).fetch(PUBLIC)).rejects.toMatchObject({ kind: 'challenge', message: 'BEST Express Vietnam refused every picture answer' });
    expect(only(requests, `${CAPTCHA}/verify/first`)).toHaveLength(8);
    const unknown = service([pass]);
    await expect(tracker(unknown.fetcher, answers('')).fetch(PUBLIC)).rejects.toMatchObject({ kind: 'challenge', message: 'BEST Express Vietnam pictures could not be matched' });
    expect(only(unknown.requests, `${CAPTCHA}/verify/first`)).toHaveLength(0);
    expect(only(unknown.requests, `${CAPTCHA}/init`)).toHaveLength(16);
    // Pictures it does not know leave the answers for those it does.
    const mixed = service([wrong]);
    await expect(tracker(mixed.fetcher, answers('', '10', '', '10', '', '10', '', '10', '', '10', '', '10', '', '10', '', '10')).fetch(PUBLIC))
      .rejects.toMatchObject({ kind: 'challenge', message: 'BEST Express Vietnam refused every picture answer' });
    expect(only(mixed.requests, `${CAPTCHA}/verify/first`)).toHaveLength(8);
  });

  it('keeps outages, changed replies and blocked pages apart from a missing parcel', async () => {
    for (const [init, verify, failure] of [
      [() => json('gone', 404), pass, { kind: 'transport' }],
      [() => json({ code: '200', data: { instanceId: 'synthetic-instance', type: 'slide_pic' } }), pass, { kind: 'schema' }],
      [() => json({ code: '200', data: { instanceId: 'synthetic-instance', type: 'rotate_pic', imageEncryption: true } }), pass, { kind: 'schema' }],
      [() => new Response('<html>synthetic block</html>', { headers: { 'Content-Type': 'text/html' } }), pass, { kind: 'challenge' }],
      [() => json('synthetic failure', 500), pass, { name: 'UpstreamHttpError', status: 500 }],
      [() => null, () => json({ code: '5001', success: false }), { kind: 'challenge' }],
      [() => null, () => json({ code: '200', success: true, data: { code: '', validate: 'synthetic' } }), { kind: 'schema' }],
    ] as const) {
      const { fetcher } = service([verify], [found], init);
      const error = await tracker(fetcher, answers('10')).fetch(PUBLIC).catch(caught => caught);
      expect(error).toMatchObject(failure);
    }
  });

  it('keeps the verification out of a failure\'s diagnostics', async () => {
    const { fetcher } = service([pass], [() => json('synthetic failure', 503)]);
    const error = await tracker(fetcher, answers('10')).fetch(PUBLIC).catch(caught => caught);
    expect(error).toMatchObject({ name: 'UpstreamHttpError', status: 503 });
    expect(JSON.stringify(error)).not.toMatch(/synthetic-(?:code|validate|instance)/);
  });

  it('refuses numbers the tracker does not take before any request', async () => {
    const { fetcher } = service([pass]);
    await expect(new BestExpressVnTracker({ fetcher }).fetch('84-85')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('records its one step', () => {
    const instance = adapter({ fetcher: service([pass]).fetcher, env: {}, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null });
    expect(instance).toMatchObject({ id: 'best-express-vn', recordsSteps: true, steps: ['direct'] });
  });
});
