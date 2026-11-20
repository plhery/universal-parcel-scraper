import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const example = fixture('example');
const number = '1980894';

describe('IBEX Express guest guide tracking', () => {
  it('keeps the seven scan clocks and the separate actual delivery', () => {
    const answer = parseTracking(example, number);
    expect(answer).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'explicit_mapping',
      last_status_text: 'ENTREGADO', last_update: null, last_update_local: '2026-06-30T00:01:04',
      expected_delivery: null,
    });
    expect(answer.events).toHaveLength(8);
    expect(answer.events?.slice(0, 2)).toEqual([
      { local_time: '2026-06-30T00:01:04', description: 'ENTREGADO', stage: 'delivered', stage_source: 'explicit_mapping' },
      { local_time: '2026-06-24T13:15:45', description: 'Envío en poder del Cartero', location: 'Line La Paz',
        stage: 'out_for_delivery', stage_source: 'explicit_mapping' },
    ]);
    expect(answer.events?.[4]?.local_time).toBe('2026-06-23T11:34:33');
    expect(answer.events?.[5]?.local_time).toBe('2026-06-23T11:34:00');
    expect(answer.events?.[7]?.stage).toBe('accepted');
  });

  it('binds every row to the expected guide', () => {
    expect(() => parseTracking(example, '1980895')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const firstRow = example.indexOf('"guia"');
    const secondRow = example.indexOf('"guia"', firstRow + 1);
    const mismatched = example.slice(0, secondRow) + example.slice(secondRow).replace(number, '1980895');
    expect(() => parseTracking(mismatched, number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('distinguishes explicit absence, an error response and a challenge', () => {
    expect(() => parseTracking(fixture('not-found'), number)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTracking('{"success":false,"message":"temporarily unavailable"}', number))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTracking('<title>Just a moment...</title>', number))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('uses the public endpoint with the caller’s user agent and signal', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(example));
    const tracker = adapter({
      fetcher, userAgent: 'IBEX Test', trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER,
    });
    await expect(tracker.track({ number }, { budgetMs: 2_000 })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      new URL('https://www.ibex.com.bo/forms/rastreo.php?guia=1980894'),
      expect.objectContaining({ signal: expect.any(AbortSignal), headers: expect.objectContaining({ 'User-Agent': 'IBEX Test' }) }),
    );
  });
});
