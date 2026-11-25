import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { domexGuide, parseDomex } from './parser.js';

const environment = { trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} };
const NUMBER = 'WX010008308867';
const UNKNOWN = 'WX019999999999';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');

describe('Domex Expreso public tracking', () => {
  it('reads the dated history, keeps local clocks and maps only parcel movement', () => {
    const result = parseDomex(fixture('delivered'), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Entregado Counter', last_update: null });
    expect(result.events).toHaveLength(17);
    expect(result.events?.[0]).toMatchObject({ local_time: '2026-09-08T15:29:00', description: 'Entregado Counter', location: 'Santo Domingo', stage: 'delivered' });
    expect(result.events?.[1]?.stage).toBeUndefined();
    expect(result.events?.[3]).toMatchObject({ description: 'Disponible (D07)', stage: 'ready_for_pickup' });
    expect(result.events?.[3]?.location).toBeUndefined();
    expect(result.events?.find(event => event.description === 'Aduana')?.stage).toBe('customs');
    expect(result.events?.at(-1)).toMatchObject({ local_time: '2026-08-28T11:42:00', description: 'Recibido (Origen)', location: 'MIAMI', stage: 'accepted' });
    expect(result.events?.some(event => event.time)).toBe(false);
  });

  it('separates an unknown guide from other guides, challenges and changed pages', () => {
    expect(() => parseDomex(fixture('unknown'), UNKNOWN)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseDomex(fixture('unknown'), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDomex(fixture('unknown').replace('Tracking inválido', ''), UNKNOWN)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseDomex(fixture('delivered'), UNKNOWN)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDomex(fixture('delivered').replace('2026.09.08', '2026.02.31'), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDomex('<title>Just a moment...</title>', NUMBER)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseDomex('<form></form>', NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('accepts only a Domex guide', () => {
    expect(domexGuide(' wx010008308867 ')).toBe(NUMBER);
    expect(() => domexGuide('TBA123456789000')).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => domexGuide('WX01000830886')).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('uses the caller transport and agent', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(fixture('delivered')));
    const tracker = adapter({ ...environment, fetcher, userAgent: 'Test Agent' });
    await expect(tracker.track({ number: 'wx010008308867' }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`https://domex-online.iplus.com.do/lg-es/ut/Estatus.aspx?id=${NUMBER}`, expect.objectContaining({
      signal: expect.any(AbortSignal), redirect: 'manual', headers: expect.objectContaining({ 'User-Agent': 'Test Agent' }),
    }));
  });
});
