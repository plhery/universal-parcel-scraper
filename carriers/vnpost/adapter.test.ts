import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, VnpostTracker } from './adapter.js';

const PUBLIC = 'EK572324490VN';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json', ...headers } });

/** A synthetic tracker: each picture address, then the lookup's answers in turn. */
function tracker(lookups: (() => Response)[], picture = (index: number) => `https://vnpost.vn/captcha/default?Synthetic${index}`) {
  const requests: { url: string; headers: Headers }[] = [];
  let pictures = 0;
  let lookup = 0;
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push({ url, headers: new Headers(init?.headers) });
    if (url === 'https://vnpost.vn/handle-captcha/refresh-captcha') {
      const response = json({ captcha: picture(pictures++) }, 200, { 'Set-Cookie': 'vnpost_session=synthetic; Path=/; HttpOnly' });
      // The cookie jar files a cookie under the address that answered.
      Object.defineProperty(response, 'url', { value: url });
      return response;
    }
    if (url.startsWith('https://vnpost.vn/captcha/default?')) return new Response(fixture('captcha-Z78r.jpg'), { headers: { 'Content-Type': 'image/jpeg' } });
    if (url.startsWith('https://vnpost.vn/postcode/thong-tin?')) return lookups[Math.min(lookup++, lookups.length - 1)]!();
    return new Response('unexpected', { status: 500 });
  }) as unknown as typeof fetch;
  return { fetcher, requests };
}

const refused = () => json(fixture('captcha-refused.json').toString(), 422);
const found = () => json(fixture('delivered.json').toString());
const answers = (...values: string[]) => {
  let index = 0;
  return vi.fn(async () => values[Math.min(index++, values.length - 1)]!);
};

describe('VNPost tracker lookup', () => {
  it('sends the whole number with the picture\'s answer in the session that drew it, and takes a new picture after a refusal', async () => {
    const { fetcher, requests } = tracker([refused, found]);
    const solveCaptcha = answers('Z78r', 'H45N');
    const result = await new VnpostTracker({ fetcher, solveCaptcha }).fetch(' ek 572324490vn ');
    expect(result).toMatchObject({ status: 'delivered', delivered_at: '2026-03-17T09:12:55+07:00' });
    expect(solveCaptcha).toHaveBeenCalledTimes(2);
    const lookups = requests.filter(request => request.url.includes('/postcode/thong-tin?'));
    expect(lookups.map(request => new URL(request.url).searchParams.toString())).toEqual([
      `post_code=${PUBLIC}&captcha=Z78r`, `post_code=${PUBLIC}&captcha=H45N`]);
    for (const request of requests.slice(1)) expect(request.headers.get('cookie')).toBe('vnpost_session=synthetic');
    expect(lookups[0]!.headers.get('x-requested-with')).toBe('XMLHttpRequest');
  });

  it('takes a new picture without a lookup when a reading is not four letters or digits', async () => {
    const { fetcher, requests } = tracker([found]);
    await new VnpostTracker({ fetcher, solveCaptcha: answers('Z78', 'Z78r') }).fetch(PUBLIC);
    expect(requests.filter(request => request.url.includes('/postcode/thong-tin?'))).toHaveLength(1);
    expect(requests.filter(request => request.url.includes('/refresh-captcha'))).toHaveLength(2);
  });

  it('answers not found only past an accepted picture', async () => {
    const { fetcher } = tracker([() => json(fixture('not-found.json').toString(), 422)]);
    await expect(new VnpostTracker({ fetcher, solveCaptcha: answers('Z78r') }).fetch('RR000000005VN')).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('gives up as a challenge after five refused pictures', async () => {
    const { fetcher, requests } = tracker([refused]);
    await expect(new VnpostTracker({ fetcher, solveCaptcha: answers('Z78r') }).fetch(PUBLIC))
      .rejects.toMatchObject({ kind: 'challenge', message: 'VNPost refused every captcha answer' });
    expect(requests.filter(request => request.url.includes('/postcode/thong-tin?'))).toHaveLength(5);
    const unread = tracker([found]);
    await expect(new VnpostTracker({ fetcher: unread.fetcher, solveCaptcha: answers('') }).fetch(PUBLIC))
      .rejects.toMatchObject({ kind: 'challenge', message: 'VNPost captcha pictures could not be read' });
    expect(unread.requests.some(request => request.url.includes('/postcode/thong-tin?'))).toBe(false);
  });

  it('keeps blocks, outages and unknown pictures apart from a missing parcel', async () => {
    const page = () => new Response('<!doctype html><title>Just a moment</title>', { headers: { 'Content-Type': 'text/html' } });
    for (const [lookup, failure] of [[page, { kind: 'challenge' }], [() => new Response('gone', { status: 404 }), { kind: 'transport' }],
      [() => json({ message: 'Synthetic failure' }, 500), { name: 'UpstreamHttpError', status: 500 }]] as const) {
      const { fetcher } = tracker([lookup]);
      await expect(new VnpostTracker({ fetcher, solveCaptcha: answers('Z78r') }).fetch(PUBLIC)).rejects.toMatchObject(failure);
    }
    const elsewhere = tracker([found], () => 'https://captcha.example/default?Synthetic');
    await expect(new VnpostTracker({ fetcher: elsewhere.fetcher, solveCaptcha: answers('Z78r') }).fetch(PUBLIC)).rejects.toMatchObject({ kind: 'schema' });
    expect(elsewhere.requests).toHaveLength(1);
  });

  it('keeps the session cookie and the answer out of a failure\'s diagnostics', async () => {
    const { fetcher } = tracker([() => json({ message: 'Synthetic failure' }, 503)]);
    const error = await new VnpostTracker({ fetcher, solveCaptcha: answers('Z78r') }).fetch(PUBLIC).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ name: 'UpstreamHttpError', status: 503 });
    expect(JSON.stringify(error)).not.toMatch(/Z78r|vnpost_session|thong-tin/);
  });

  it('refuses references the tracker cannot read before any request', async () => {
    const { fetcher } = tracker([found]);
    for (const number of ['', 'EK5723', '漢字572324490', 'X'.repeat(31), 'x'.repeat(65)]) {
      await expect(new VnpostTracker({ fetcher }).fetch(number)).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('records its one direct step', async () => {
    const { fetcher } = tracker([found]);
    const steps: string[] = [];
    const recorder = { ...NOOP_RECORDER, step: (step: { step: string; outcome: string }) => { steps.push(`${step.step}:${step.outcome}`); } };
    const instance = adapter({ fetcher, env: {}, recorder, trawl: null, browserExecutablePath: null });
    expect(instance).toMatchObject({ id: 'vnpost', steps: ['direct'], recordsSteps: true });
    // The packaged model reads the synthetic tracker's picture.
    await expect(instance.track({ number: PUBLIC })).resolves.toMatchObject({ status: 'delivered' });
    expect(steps).toEqual(['direct:ok']);
  }, 30_000);
});
