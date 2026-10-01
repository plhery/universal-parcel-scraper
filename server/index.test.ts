import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrackingError, type Tracker, type TrackingResponse } from '../facade/index.js';
import { createTrackingServer } from './index.js';

const servers: Server[] = [];
const answer: TrackingResponse = { carrier: 'ups', source: 'ups', result: { current_stage: 'delivered', events: [] }, attempts: [] };
const input = { number: '1Z999AA10123456784', carrier: 'ups' };
function tracker(track = vi.fn().mockResolvedValue(answer)): Tracker {
  return { track, detect: vi.fn(), recognize: vi.fn() };
}
async function started(options: Parameters<typeof createTrackingServer>[0]) {
  const server = createTrackingServer(options);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const post = (url: string, value = input, token?: string) => fetch(`${url}/v1/track`, { method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(value) });
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });

describe('tracking HTTP API', () => {
  it('authenticates before starting a lookup and leaves health accessible', async () => {
    const mock = tracker();
    const url = await started({ tracker: mock, token: 'synthetic-token' });
    expect((await fetch(`${url}/health`)).status).toBe(200);
    expect((await post(url)).status).toBe(401);
    expect(mock.track).not.toHaveBeenCalled();
    expect((await post(url, input, 'synthetic-token')).status).toBe(200);
  });

  it('shares concurrent duplicate requests and keeps credentials in the cache key', async () => {
    let finish!: (result: TrackingResponse) => void;
    const track = vi.fn().mockImplementation(() => new Promise<TrackingResponse>(resolve => { finish = resolve; }));
    const url = await started({ tracker: tracker(track) });
    const first = post(url), second = post(url);
    await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(1));
    finish(answer);
    expect((await Promise.all([first,second])).map(response => response.status)).toEqual([200,200]);
    expect((await post(url)).status).toBe(200);
    expect((await post(url, { number: ` ${input.number} `, carrier: 'ups' })).status).toBe(200);
    expect(track).toHaveBeenCalledTimes(1);
    track.mockResolvedValue(answer);
    expect((await post(url, { ...input, postcode: '0000' } as typeof input)).status).toBe(200);
    expect(track).toHaveBeenCalledTimes(2);
  });

  it('expires cached responses and honors the carrier minimum refresh', async () => {
    let time = 0;
    const track = vi.fn().mockResolvedValue({ ...answer, carrier: 'gls-de' });
    const url = await started({ tracker: tracker(track), cacheMs: 1, now: () => time });
    await post(url);
    time = 60_000;
    await post(url);
    expect(track).toHaveBeenCalledTimes(1);
    time = 3_600_001;
    await post(url);
    expect(track).toHaveBeenCalledTimes(2);
  });

  it('limits requests and rejects oversized bodies before tracking', async () => {
    const mock = tracker();
    const url = await started({ tracker: mock, rateLimit: 1 });
    const large = await fetch(`${url}/v1/track`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ number: 'x'.repeat(17_000) }) });
    expect(large.status).toBe(413);
    expect(mock.track).not.toHaveBeenCalled();
    const limited = await post(url);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
  });

  it('returns safe failure hints and never logs input or upstream messages', async () => {
    const log = vi.fn();
    const track = vi.fn().mockRejectedValue(new TrackingError([{ source: 'ups', kind: 'rate_limited', durationMs: 1 }], { kind: 'rate_limited', retryAfterMs: 2_000 }));
    const url = await started({ tracker: tracker(track), log });
    const response = await post(url);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('2');
    expect(await response.json()).toMatchObject({ hint: { kind: 'rate_limited' } });
    expect(JSON.stringify(log.mock.calls)).not.toContain(input.number);
    expect(log.mock.calls[0][0]).toMatchObject({ route: '/v1/track', status: 429 });
    track.mockRejectedValue(new Error(`private ${input.number}`));
    expect(JSON.stringify(await (await post(url)).json())).not.toContain(input.number);
  });
});
