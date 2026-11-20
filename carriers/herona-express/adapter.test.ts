import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const found = readFileSync(new URL('./fixtures/in-transit.json', import.meta.url), 'utf8');
const missing = readFileSync(new URL('./fixtures/missing.json', import.meta.url), 'utf8');

describe('Herona Express guest tracking', () => {
  it('sends the form token and session with one whole tracking number', async () => {
    const token = 'a'.repeat(64);
    const form = `<input type="hidden" id="track_token" value="${token}">`;
    const page = new Response(form, { headers: { 'Set-Cookie': 'PHPSESSID=test; Path=/' } });
    Object.defineProperty(page, 'url', { value: 'https://tracking.heronaexpress.co.id/lacak.php' });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce(new Response(found));
    const result = await adapter({ fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} })
      .track({ number: 'TSMA23000750' });
    const request = fetcher.mock.calls[1]?.[1];
    expect(new Headers(request?.headers).get('Cookie')).toBe('PHPSESSID=test');
    expect(request?.body).toEqual(new URLSearchParams({ ref_no: 'TSMA23000750', track_token: token }));
    expect(result).toMatchObject({ current_stage: 'in_transit', last_update_local: '2023-06-20T11:11:31' });
    expect(result.events).toHaveLength(4);
  });

  it('requires the explicit empty reply for absence', () => {
    expect(() => parseTracking(missing)).toThrow(NotFoundError);
    expect(() => parseTracking('{"history":[]}')).toThrow(/invalid herona express shipment/i);
  });
});
