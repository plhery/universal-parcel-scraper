import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const example = fixture('example');
const number = 'DJC-POR-03-10-21-0009';

describe('D’Jesu COMER public shipment tracking', () => {
  it('keeps confirmed steps and applies the creation day only to registration', () => {
    const result = parseTracking(example, number);
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'explicit_mapping',
      last_status_text: 'Enviado', last_update: null,
    });
    expect(result.last_update_local).toBeUndefined();
    expect(result.events?.map(event => [event.description, event.local_time, event.stage])).toEqual([
      ['Enviado', undefined, 'in_transit'],
      ['Recibido', undefined, 'accepted'],
      ['Pendiente', '2026-10-21', 'registered'],
    ]);
  });

  it('distinguishes a missing shipment from a changed date, a different guide, or a browser check', () => {
    expect(() => parseTracking(fixture('missing'), number)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTracking(example.replace('21/10/2026', '31/11/2026'), number))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTracking(example, 'ZZZZ000000000000000'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTracking('<title>Just a moment...</title>', number)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('restores the printed format and looks up the guide without additional input', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(example));
    const tracker = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(tracker.track({ number: 'djcpor0310210009' })).resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(new URL('https://www.jesucomer.com/rastreo-envio/?orden=' + number),
      expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
});
