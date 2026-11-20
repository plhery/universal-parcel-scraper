import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const guide = 'PE20266190869';
const example = readFileSync(new URL('./fixtures/PE20266190869.json', import.meta.url), 'utf8');

describe('Pack Express guest tracking', () => {
  it('reads four real milestones and retains the carrier order for equal times', () => {
    const result = parseTracking(example, guide);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', last_status_text: 'Entregado',
      last_update: null, last_update_local: '2026-06-01T08:26',
    });
    expect(result.events?.map(({ provider_code, stage, local_time, tie_order }) => [provider_code, stage, local_time, tie_order])).toEqual([
      ['entregado', 'delivered', '2026-06-01T08:26', undefined],
      ['en_ruta', 'in_transit', '2026-06-01T07:22', 1],
      ['recolectada', 'accepted', '2026-06-01T07:22', 0],
      ['creado', 'registered', '2026-06-01T07:00', undefined],
    ]);
  });

  it('keeps administrative completion and equipment workshop handoff out of delivery', () => {
    const onlyBadge = '{"ok":true,"encontrada":true,"guia":"PE20266190869","estado_guia":"Completo"}';
    expect(parseTracking(onlyBadge, guide)).toMatchObject({ status: 'unknown', summary_only: true });
    const serviceHistory = JSON.stringify({
      ok: true, encontrada: true, fuente: 'z17', guia: guide, estado: 'Entregado en taller',
      fecha: '2026-06-01', hora: '09:03',
      historial: [{ estado: 'Recolectado', fecha: '2026-06-01', hora: '07:00' },
        { estado: 'Entregado en taller', fecha: '2026-06-01', hora: '09:03' }],
    });
    const result = parseTracking(serviceHistory, guide);
    expect(result).toMatchObject({ status: 'unknown', last_update_local: '2026-06-01T09:03' });
    expect(result.events?.map(({ stage }) => stage)).toEqual([undefined, 'accepted']);
  });

  it('distinguishes native absence, invalid milestone dates and a different guide', () => {
    expect(() => parseTracking('{"ok":true,"encontrada":false}', guide)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTracking('{"ok":false}', guide)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTracking(example.replace('2026-06-01 07:00', '2026-06-99 07:00'), guide))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTracking(example, 'PE20260000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('submits only the normalized guide number to the public bridge', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(example));
    const tracker = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(tracker.track({ number: guide.toLowerCase() })).resolves.toMatchObject({ status: 'delivered' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://packexpress.com.gt/pe-rastreo/rastreo-bridge.php');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ guia: guide }));
  });
});
