import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { BestTracker } from '../best-express-vn/adapter.js';
import { adapter, BEST_TH } from './adapter.js';

const PUBLIC = '66857942189018';
const CAPTCHA = 'https://captcha-sg.800best.com/api/captcha';
const KEY = '4801fe3ea2fda54bd2aeedc9d28f2999';
const json = (body: string | object) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

describe('BEST Express Thailand tracker lookup', () => {
  it('verifies with the Thai tracker\'s key and asks for its English scans', async () => {
    const requests: { url: string; headers: Headers; body?: string }[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, request?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      requests.push({ url, headers: new Headers(request?.headers), body: typeof request?.body === 'string' ? request.body : undefined });
      if (url === `${CAPTCHA}/init`) return json({ code: '200', success: true, data: { instanceId: 'synthetic-instance', type: 'rotate_pic', imageEncryption: false } });
      if (url.startsWith(`${CAPTCHA}/resource?`)) return new Response(new Uint8Array([0xff, 0xd8, 0xff]));
      if (url === `${CAPTCHA}/verify/first`) return json({ code: '200', success: true, data: { code: 'synthetic-code', validate: 'synthetic-validate' } });
      if (url.startsWith('https://www.best-inc.co.th/express-cc/express/expresslistinfo?')) return json(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
      return new Response('unexpected', { status: 500 });
    }) as unknown as typeof fetch;
    const tracker = new BestTracker(BEST_TH, { fetcher, solveRotation: async () => '120', settleMs: 0 });
    await expect(tracker.fetch(PUBLIC)).resolves.toMatchObject({ current_stage: 'delivered', timezone: 'Asia/Bangkok' });
    expect(requests.find(request => request.url === `${CAPTCHA}/init`)!.body).toBe(`appKey=${KEY}&type=rotate_pic`);
    const lookup = requests.at(-1)!;
    expect(lookup.headers.get('x-nat')).toBe('th-TH');
    expect(lookup.headers.get('lang-type')).toBe('en-US');
    expect(lookup.headers.get('x-lan')).toBe('EN');
    for (const request of requests) expect(request.headers.get('origin')).toBe('https://www.best-inc.co.th');
  });

  it('records its one step under its own id', () => {
    const instance = adapter({ fetcher: fetch, env: {}, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null });
    expect(instance).toMatchObject({ id: 'best-express-th', recordsSteps: true, steps: ['direct'] });
  });
});
