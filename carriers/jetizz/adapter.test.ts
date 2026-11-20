import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, JetizzTracker } from './adapter.js';

const PUBLIC = '2601794363';
const PAGE = 'https://app.jetizz.com/gonderi-takip';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
// The form's hidden fields for an instance whose code "SEC6" the tracker took typed as "SEc6".
const FORM = `<form><input type="hidden" name="BDC_VCID_ExampleCaptcha" id="BDC_VCID_ExampleCaptcha" value="3c6db0da24a148f89fadb99525a0b984" />
<input type="hidden" name="BDC_Hs_ExampleCaptcha" id="BDC_Hs_ExampleCaptcha" value="89a8439d7f3acb9c43500670ce8d1fadb72a69c7" />
<input type="hidden" name="BDC_SP_ExampleCaptcha" id="BDC_SP_ExampleCaptcha" value="1142667381" /></form>`;
const html = (body: BodyInit, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } });

/** A synthetic tracker: the form page, its picture, then the lookup's answers in turn. */
function tracker(lookups: (() => Response)[], page: () => Response = () => html(FORM, 200, { 'Set-Cookie': 'ASP.NET_SessionId=synthetic; path=/; HttpOnly' })) {
  const requests: { url: string; headers: Headers; body?: string; at: number }[] = [];
  let lookup = 0;
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push({ url, headers: new Headers(init?.headers), body: typeof init?.body === 'string' ? init.body : undefined, at: performance.now() });
    if (url === `${PAGE}?AspxAutoDetectCookieSupport=1`) {
      const response = page();
      // The cookie jar files a cookie under the address that answered.
      Object.defineProperty(response, 'url', { value: url });
      return response;
    }
    if (url.startsWith(`${PAGE}/BotDetectCaptcha.ashx?`)) return new Response(fixture('captcha-SEC6.jpg'), { headers: { 'Content-Type': 'image/jpeg' } });
    if (url === `${PAGE}/Home/GonderiBilgi`) return lookups[Math.min(lookup++, lookups.length - 1)]!();
    return new Response('unexpected', { status: 500 });
  }) as unknown as typeof fetch;
  return { fetcher, requests };
}

const refused = () => html(fixture('refused.html'));
const found = () => html(fixture('returned.html'));
const answers = (...values: string[]) => {
  let index = 0;
  return vi.fn(async () => values[Math.min(index++, values.length - 1)]!);
};
const lookups = <T extends { url: string }>(requests: T[]) => requests.filter(request => request.url.endsWith('/Home/GonderiBilgi'));

describe('Jetizz tracker lookup', () => {
  it('sends the whole number with the code typed as the form would, in the session that drew it, and takes a new picture after a refusal', async () => {
    const { fetcher, requests } = tracker([refused, found]);
    const solveCaptcha = answers('SEC6', 'SEC6');
    const result = await new JetizzTracker({ fetcher, solveCaptcha, settleMs: 0 }).fetch(' 2601 794 363 ');
    expect(result).toMatchObject({ current_stage: 'returned', delivery_carrier: 'aras-kargo' });
    expect(solveCaptcha).toHaveBeenCalledTimes(2);
    expect(lookups(requests).map(request => JSON.parse(request.body!))).toEqual(Array(2).fill({ searchModel: {
      TakipNo: PUBLIC, CaptchaCode: 'SEc6', CaptchaId: 'ExampleCaptcha', CaptchaInstanceId: '3c6db0da24a148f89fadb99525a0b984' } }));
    expect(requests[0]!.headers.get('cookie')).toBe('AspxAutoDetectCookieSupport=1');
    for (const request of requests.slice(1)) expect(request.headers.get('cookie')).toBe('AspxAutoDetectCookieSupport=1; ASP.NET_SessionId=synthetic');
    expect(requests[1]!.url).toBe(`${PAGE}/BotDetectCaptcha.ashx?get=image&c=ExampleCaptcha&t=3c6db0da24a148f89fadb99525a0b984`);
    expect(lookups(requests)[0]!.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(lookups(requests)[0]!.headers.get('x-requested-with')).toBe('XMLHttpRequest');
  });

  it('waits after the picture before it answers, as a person would', async () => {
    const { fetcher, requests } = tracker([found]);
    await new JetizzTracker({ fetcher, solveCaptcha: answers('SEC6'), settleMs: 120 }).fetch(PUBLIC);
    const picture = requests.find(request => request.url.includes('BotDetectCaptcha.ashx'))!;
    expect(lookups(requests)[0]!.at - picture.at).toBeGreaterThanOrEqual(110);
  });

  it('takes a new picture without a lookup when a reading is not four capitals or digits', async () => {
    const { fetcher, requests } = tracker([found]);
    await new JetizzTracker({ fetcher, solveCaptcha: answers('SEC', 'SEC6'), settleMs: 0 }).fetch(PUBLIC);
    expect(lookups(requests)).toHaveLength(1);
    expect(requests.filter(request => request.url.endsWith('?AspxAutoDetectCookieSupport=1'))).toHaveLength(2);
  });

  it('answers not found only past an accepted picture', async () => {
    const { fetcher } = tracker([() => html(fixture('not-found.html'))]);
    await expect(new JetizzTracker({ fetcher, solveCaptcha: answers('SEC6'), settleMs: 0 }).fetch('0000000000')).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('gives up as a challenge after five refused pictures, or none read', async () => {
    const { fetcher, requests } = tracker([refused]);
    await expect(new JetizzTracker({ fetcher, solveCaptcha: answers('SEC6'), settleMs: 0 }).fetch(PUBLIC))
      .rejects.toMatchObject({ kind: 'challenge', message: 'Jetizz refused every captcha answer' });
    expect(lookups(requests)).toHaveLength(5);
    const unread = tracker([found]);
    await expect(new JetizzTracker({ fetcher: unread.fetcher, solveCaptcha: answers(''), settleMs: 0 }).fetch(PUBLIC))
      .rejects.toMatchObject({ kind: 'challenge', message: 'Jetizz captcha pictures could not be read' });
    expect(lookups(unread.requests)).toHaveLength(0);
  });

  it('keeps redirects, outages, changed pages and errors apart from a missing parcel', async () => {
    for (const [page, failure] of [
      [() => html('', 302, { Location: '/gonderi-takip?AspxAutoDetectCookieSupport=1' }), { kind: 'challenge' }],
      [() => html('gone', 404), { kind: 'transport' }],
      [() => html('<form>synthetic</form>'), { kind: 'schema' }],
      [() => html('synthetic failure', 500), { name: 'UpstreamHttpError', status: 500 }],
    ] as const) {
      const { fetcher } = tracker([found], page);
      const error = await new JetizzTracker({ fetcher, solveCaptcha: answers('SEC6'), settleMs: 0 }).fetch(PUBLIC).catch(caught => caught);
      expect(error).toMatchObject(failure);
    }
  });

  it('keeps the session cookie and the answer out of a failure\'s diagnostics', async () => {
    const { fetcher } = tracker([() => html('synthetic failure', 503)]);
    const error = await new JetizzTracker({ fetcher, solveCaptcha: answers('SEC6'), settleMs: 0 }).fetch(PUBLIC).catch(caught => caught);
    expect(error).toMatchObject({ name: 'UpstreamHttpError', status: 503 });
    expect(JSON.stringify(error)).not.toMatch(/SEc6|SessionId|3c6db0da/);
  });

  it('refuses numbers the tracker does not take before any request', async () => {
    const { fetcher } = tracker([found]);
    await expect(new JetizzTracker({ fetcher }).fetch('IH-4230269')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('records its one step', () => {
    const instance = adapter({ fetcher: tracker([found]).fetcher, env: {}, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null });
    expect(instance).toMatchObject({ id: 'jetizz', recordsSteps: true, steps: ['direct'] });
  });
});
