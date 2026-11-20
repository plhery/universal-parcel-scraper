import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const example = fixture('example');

describe('PaquetEx box tracking', () => {
  it('keeps the twelve dated pickup updates in current-to-oldest order', () => {
    const answer = parseTracking(example, '46086', 200);
    expect(answer).toMatchObject({
      status: 'pending', current_stage: 'registered', current_stage_source: 'explicit_mapping',
      last_status_text: 'Recogida Programada', provider_code: '3', canonical_tracking_number: 'HON046086',
      destination_country_name: 'Honduras', service_name: 'Marítimo', expected_delivery: null,
      last_update: '2026-04-25T17:45:50Z',
    });
    expect(answer.events).toHaveLength(12);
    expect(answer.events?.[0]).toEqual({
      time: '2026-04-25T17:45:50Z', description: 'Recogida Programada',
      provider_code: '3', stage: 'registered', stage_source: 'explicit_mapping',
    });
    expect(answer.events?.[1]).toMatchObject({ description: 'En Espera de Recogida', provider_code: '2', stage: 'registered' });
    expect(answer.events?.[11]?.time).toBe('2026-03-17T07:56:21Z');
  });

  it('binds both reference styles and rejects the carrier’s wrong-country match', () => {
    expect(parseTracking(example, 'HON046086', 200).canonical_tracking_number).toBe('HON046086');
    expect(() => parseTracking(example, 'MEX046086', 200)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTracking(example, '46087', 200)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('distinguishes the observed validation error, unconfirmed results and a challenge', () => {
    expect(() => parseTracking(fixture('invalid-reference'), 'HON000000', 400))
      .toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => parseTracking('{"found":false,"error":"Service unavailable"}', '46086', 200))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTracking(example.replace('"supabase"', '"fedex"'), '46086', 200))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTracking('<title>Just a moment...</title>', '46086', 200))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('calls the public box endpoint with the caller’s user agent and signal', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(example));
    const tracker = adapter({
      fetcher, userAgent: 'PaquetEx Test', trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER,
    });
    await expect(tracker.track({ number: 'hon046086' }, { budgetMs: 2_000 })).resolves.toMatchObject({ status: 'pending' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      new URL('https://paquetex.net/api/tracking?q=HON046086'),
      expect.objectContaining({ signal: expect.any(AbortSignal), headers: expect.objectContaining({ 'User-Agent': 'PaquetEx Test' }) }),
    );
  });
});
