import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { bmCargoReceipt, parseBmCargo } from './parser.js';

const environment = { trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} };
const NUMBER = 'WR01-025968312';
const UNKNOWN = 'WR01-000000000';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');

describe('BM Cargo public tracking', () => {
  it('reads the dated history, keeps local clocks and maps only known movement', () => {
    const result = parseBmCargo(fixture('delivered'), NUMBER);
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Entregado', last_update: null });
    expect(result.events).toHaveLength(12);
    expect(result.events?.[0]).toMatchObject({ local_time: '2024-03-16T13:14:02', description: 'Entregado', location: 'SANTO DOMINGO' });
    expect(result.events?.[2]?.stage).toBeUndefined();
    expect(result.events?.[5]?.stage).toBe('ready_for_pickup');
    expect(result.events?.at(-1)).toMatchObject({ local_time: '2024-03-13T08:37:21', stage: 'accepted', location: 'Miami' });
    expect(result.events?.some(event => event.time)).toBe(false);
  });

  it('distinguishes the empty form, other receipts and changed responses', () => {
    expect(() => parseBmCargo(fixture('unknown'), UNKNOWN)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseBmCargo(fixture('delivered'), UNKNOWN)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBmCargo(fixture('delivered').replace('2024.03.16', '2024.02.31'), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBmCargo('<title>Just a moment...</title>', UNKNOWN)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseBmCargo('<form></form>', UNKNOWN)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => bmCargoReceipt('TEST12345')).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('restores the printed hyphen and uses the caller transport and agent', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(fixture('delivered')));
    const tracker = adapter({ ...environment, fetcher, userAgent: 'Test Agent' });
    await expect(tracker.track({ number: 'wr01025968312' }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`https://bmcargo-online.iplus.com.do/lg-es/ut/Estatus.aspx?id=${NUMBER}`, expect.objectContaining({
      signal: expect.any(AbortSignal), redirect: 'manual', headers: expect.objectContaining({ 'User-Agent': 'Test Agent' }),
    }));
  });
});
