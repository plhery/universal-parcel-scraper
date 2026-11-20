import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking, SEARCH_URL, SUBMIT_URL } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const example = fixture('example');
const courtGuide = fixture('court-guide');
const guide = '1019201223';
const courtNumber = '1103615274';
const mockToken = 'a'.repeat(40);
const guestForm = `<title>Paquetería | Grupo Vencedor</title>
<form method="POST" action="${SUBMIT_URL}">
  <input type="hidden" name="_token" value="${mockToken}">
  <input name="tracknumber">
</form>`;

describe('Paquetería Vencedor tracking history', () => {
  it('reads the published example and keeps its local clocks', () => {
    const result = parseTracking(example, guide);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', last_status_text: 'ENTREGADA',
      last_update: null, last_update_local: '2026-09-04T16:02',
      events: expect.arrayContaining([{ local_time: '2026-09-04T16:02', location: 'TAMPICO',
        description: 'ENTREGADA', stage: 'delivered', stage_source: 'explicit_mapping' }]),
    });
    expect(result.events).toHaveLength(9);
  });

  it('reads the dated history of a second, independently published guide', () => {
    const result = parseTracking(courtGuide, courtNumber);
    expect(result.events?.[0]).toMatchObject({ local_time: '2020-08-07T15:44', location: 'EBANO' });
    expect(result.events?.at(-1)).toMatchObject({ description: 'VENDIDA', stage: 'registered' });
  });

  it('keeps a mismatched guide and a try-later notice indeterminate', () => {
    expect(() => parseTracking(example, courtNumber)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTracking(fixture('no-result'), guide)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reports a changed scan date or a verification page', () => {
    expect(() => parseTracking(example.replace('04 de septiembre', '31 de septiembre'), guide))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTracking('<title>Just a moment...</title>', guide))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
  });
});

function responseAt(url: string, body: BodyInit | null, init?: ResponseInit): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

describe('Paquetería Vencedor guest form', () => {
  const environment = { trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER, userAgent: 'Vencedor Test' };

  it('carries the fresh form token and the updated session through the redirect', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(responseAt(SEARCH_URL, guestForm, { headers: { 'Set-Cookie': 'laravel-session=form; Path=/' } }))
      .mockResolvedValueOnce(responseAt(SUBMIT_URL, null, { status: 302,
        headers: { Location: '/paqueteria', 'Set-Cookie': 'laravel-session=answer; Path=/' } }))
      .mockResolvedValueOnce(new Response(example));
    await expect(adapter({ ...environment, fetcher }).track({ number: guide }, { budgetMs: 3_000 }))
      .resolves.toMatchObject({ status: 'delivered' });

    const calls = fetcher.mock.calls;
    expect(calls.map(([url]) => String(url))).toEqual([SEARCH_URL, SUBMIT_URL, SEARCH_URL]);
    expect(new Headers(calls[0]?.[1]?.headers).get('User-Agent')).toBe('Vencedor Test');
    expect(new Headers(calls[1]?.[1]?.headers).get('Cookie')).toBe('laravel-session=form');
    expect(String(calls[1]?.[1]?.body)).toBe(new URLSearchParams({ _token: mockToken, tracknumber: guide }).toString());
    expect(new Headers(calls[2]?.[1]?.headers).get('Cookie')).toBe('laravel-session=answer');
    expect(calls.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(true);
  });

  it('rejects a redirect away from the tracker', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(responseAt(SEARCH_URL, guestForm, { headers: { 'Set-Cookie': 'laravel-session=form; Path=/' } }))
      .mockResolvedValueOnce(responseAt(SUBMIT_URL, null, { status: 302, headers: { Location: 'https://example.com/' } }));
    await expect(adapter({ ...environment, fetcher }).track({ number: guide }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
