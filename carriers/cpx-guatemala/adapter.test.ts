import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const example = fixture('example');
const number = 'FGUA107000-82026-1';

describe('CPX Guatemala guest tracking', () => {
  it('retains pickup readiness after a later payment update', () => {
    const result = parseTracking(example, number);
    expect(result).toMatchObject({
      status: 'out_for_delivery', current_stage: 'ready_for_pickup', current_stage_source: 'explicit_mapping',
      provider_code: 'CPX_PAYMENT', last_status_text: 'Tu paquete ya fue pagado',
      last_update: null, last_update_local: '2026-08-10T11:20:21.306666',
    });
    expect(result.events?.map(({ description, provider_code, local_time, location, stage }) =>
      [description, provider_code, local_time, location, stage])).toEqual([
      ['Tu paquete ya fue pagado', 'CPX_PAYMENT', '2026-08-10T11:20:21.306666', 'Guatemala', undefined],
      ['Tu paquete está listo para entrega en tienda', 'INVOICED', '2026-08-06T09:50:50.753333', 'Guatemala', 'ready_for_pickup'],
    ]);
  });

  it('uses explicit pickup wording before staging invoicing and suppresses free-form activity', () => {
    const result = parseTracking(example.replace('Tu paquete está listo para entrega en tienda', 'Generic invoice note'), number);
    expect(result.status).toBe('unknown');
    expect(result.events?.[1]).toMatchObject({ provider_code: 'INVOICED', description: 'Listo para entrega' });
    expect(result.events?.[1]).not.toHaveProperty('stage');
  });

  it('requires the echoed tracking number and distinguishes native absence from a changed shape', () => {
    expect(() => parseTracking(fixture('not-found'), 'INVALID')).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTracking(fixture('not-found'), number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTracking(example.replace('2026-08-06', '2026-08-38'), number))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTracking('<title>Just a moment...</title>', number)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('restores the dashes when CPX is selected with the compact printed reference', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(example));
    const tracker = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(tracker.track({ number: 'fgua107000820261' })).resolves.toMatchObject({ current_stage: 'ready_for_pickup' });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://tracking.cpxbox.com/api/tracking/FGUA107000-82026-1');
  });
});
