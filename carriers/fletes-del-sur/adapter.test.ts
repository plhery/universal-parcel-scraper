import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const first = '3334537';
const second = '4013455';

describe('PFS guest guide tracking', () => {
  it('reads the older sample with local dates and exact scan locations', () => {
    const result = parseTracking(fixture(first), first);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'explicit_mapping',
      last_status_text: 'ENTREGA DE MERCANCIA', last_update: null, last_update_local: '2024-08-19T10:14',
    });
    expect(result.events?.map(event => [event.local_time, event.description, event.stage, event.location])).toEqual([
      ['2024-08-19T10:14', 'ENTREGA DE MERCANCIA', 'delivered', 'APATZINGAN'],
      ['2024-08-16T20:12', 'SALIDA DE MERCANCIA', 'in_transit', 'URUAPAN TALLER'],
      ['2024-08-16T12:00', 'DOCUMENTACION DE MERCANCIA', 'registered', 'URUAPAN, MICH.'],
    ]);
  });

  it('preserves separate depot movements in the newer history', () => {
    const result = parseTracking(fixture(second), second);
    expect(result.last_update_local).toBe('2026-08-19T14:21');
    expect(result.events).toHaveLength(8);
    expect(result.events?.[3]).toMatchObject({
      description: 'LLEGADA DE MERCANCIA', location: 'IRAPUATO', local_time: '2026-08-18T10:06', stage: 'in_transit',
    });
  });

  it('separates an absent shipment, a mismatched guide, and a CAPTCHA response', () => {
    expect(() => parseTracking(fixture('missing'), '9999999')).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTracking(fixture(first), second)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTracking('{"status":"CAPTCHA"}', first)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseTracking('{"status":"Error","cuerpo":"Servicio no disponible"}', first))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('submits one guest lookup with the caller signal', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(fixture(second)));
    const tracker = adapter({
      fetcher, userAgent: 'PFS Test', trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER,
    });
    await expect(tracker.track({ number: second }, { budgetMs: 2_000 })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      'https://www.fletesdelsur.com/api/rastreo-guia',
      expect.objectContaining({
        method: 'POST', signal: expect.any(AbortSignal), headers: expect.objectContaining({ 'User-Agent': 'PFS Test' }),
        body: new URLSearchParams({ guia: second, 'g-recaptcha-response': '' }),
      }),
    );
  });
});
