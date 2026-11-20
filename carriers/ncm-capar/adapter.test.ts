import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { ncmNumber, parseNcmForm, parseNcmResult } from './parser.js';

const NUMBER = 'NCM-082026001';
const STATE = 'synthetic-guest-form-state';
const COOKIE = '.AspNetCore.Antiforgery.SyntheticKey=fixture';
const registered = readFileSync(new URL('./fixtures/registered.html', import.meta.url), 'utf8');
const blank = readFileSync(new URL('./fixtures/blank-form.html', import.meta.url), 'utf8');
const form = blank.replace('name="__RequestVerificationToken" type="hidden" value=""', `name="__RequestVerificationToken" type="hidden" value="${STATE}"`);

describe('NCM Çapar public tracking', () => {
  it('reads registration and keeps the wall clock stated by the result', () => {
    expect(parseNcmResult(registered, NUMBER)).toMatchObject({
      current_stage: 'registered', last_status_text: 'Yaradıldı', last_update: '2026-08-11T12:17:00',
      expected_delivery: null, events: [{ description: 'Yaradıldı', time: '2026-08-11T12:17:00', stage: 'registered' }],
    });
    expect(parseNcmResult(registered.replace('11.08.2026 12:17', '5.8.2026 7:05'), NUMBER).last_update)
      .toBe('2026-08-05T07:05:00');
  });

  it('binds the reply to the requested number and rejects missing or malformed history', () => {
    expect(() => parseNcmResult(registered, 'NCM-OTHER')).toThrow(/did not identify/);
    expect(() => parseNcmResult(blank, NUMBER)).toThrow(/did not identify/);
    expect(() => parseNcmResult(registered.replace('11.08.2026', '31.02.2026'), NUMBER)).toThrow(/Incomplete/);
    expect(() => parseNcmResult(registered.replace('timeline__item timeline__item--current', 'unused'), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
    expect(() => parseNcmResult('<title>Just a moment</title>', NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('extracts only a token from the published POST form', () => {
    expect(parseNcmForm(form)).toBe(STATE);
    expect(() => parseNcmForm(blank)).toThrow(/Missing NCM Çapar form state/);
    expect(() => parseNcmForm(form.replace('<form ', '<form action="https://example.test/" '))).toThrow(/different tracking form/);
    expect(ncmNumber(' ncm-082026001 ')).toBe(NUMBER);
    expect(() => ncmNumber('not-a-tracking-number')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('uses a new anonymous form state and submits the tracking number on the same host', async () => {
    const headers = new Headers();
    headers.append('Set-Cookie', 'unrelated=ignored; Path=/');
    headers.append('Set-Cookie', COOKIE + '; Path=/; Secure; HttpOnly');
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => new Response(form, { headers }))
      .mockImplementationOnce(async () => new Response(registered));
    const tracker = adapter({ env: {}, recorder: NOOP_RECORDER, fetcher, trawl: null, browserExecutablePath: null });
    await expect(tracker.track({ number: NUMBER })).resolves.toMatchObject({ current_stage: 'registered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://ncmcapar.az/az/tracking');
    const [url, options] = fetcher.mock.calls[1]!;
    expect(String(url)).toBe('https://ncmcapar.az/az/tracking');
    expect(options?.method).toBe('POST');
    expect(new Headers(options?.headers).get('cookie')).toBe(COOKIE);
    expect(Object.fromEntries(new URLSearchParams(String(options?.body))))
      .toEqual({ TrackingNumber: NUMBER, __RequestVerificationToken: STATE });
  });

  it('preserves verification and form failures', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => new Response('Forbidden', { status: 403 }))
      .mockImplementationOnce(async () => new Response(form))
      .mockImplementationOnce(async () => new Response(form, { headers: { 'Set-Cookie': COOKIE } }))
      .mockImplementationOnce(async () => new Response(null, { status: 400 }));
    const tracker = adapter({ env: {}, recorder: NOOP_RECORDER, fetcher, trawl: null, browserExecutablePath: null });
    await expect(tracker.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(tracker.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(tracker.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
