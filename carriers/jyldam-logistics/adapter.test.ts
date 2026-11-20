import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name + '.json', import.meta.url), 'utf8');
const example = fixture('example');

describe('Jyldam Logistics shipment tracking', () => {
  it('reads accepted and confirmed registration milestones at local minute precision', () => {
    expect(parseTracking(example, 200, '2026', '27')).toEqual({
      status: 'pending', current_stage: 'registered', current_stage_source: 'explicit_mapping',
      last_status_text: 'Подтверждён', provider_code: 'CONFIRMED',
      last_update: null, last_update_local: '2026-04-07T12:09', expected_delivery: null,
      events: [
        { description: 'Подтверждён', local_time: '2026-04-07T12:09', location: 'г. Астана',
          provider_code: 'CONFIRMED', stage: 'registered', stage_source: 'explicit_mapping' },
        { description: 'Заказ принят', local_time: '2026-04-07T12:09', location: 'г. Астана',
          provider_code: 'NEW', stage: 'registered', stage_source: 'explicit_mapping' },
      ],
    });
  });

  it('binds the abbreviated result to the supplied serial and year', () => {
    expect(() => parseTracking(example, 200, '2026', '999')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTracking(example, 200, '2000', '27')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTracking(example.replace('"jyldam"', '"qazpost"'), 200, '2026', '27'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('recognizes only the native shipment absence and rejects generic HTTP body errors', () => {
    expect(() => parseTracking(fixture('missing'), 404, '2026', '27')).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTracking('{"success":false,"message":"Not Found"}', 404, '2026', '27'))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTracking('<title>Just a moment...</title>', 200, '2026', '27'))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('restores the printed reference from normalized input', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(example));
    const tracker = adapter({
      fetcher, userAgent: 'Jyldam Test', trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER,
    });
    await expect(tracker.track({ number: 'JL202627' })).resolves.toMatchObject({ status: 'pending' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      new URL('https://jyldam-logistics.kz/api/v1/track/JL-2026-27/'),
      expect.objectContaining({ signal: expect.any(AbortSignal), headers: expect.objectContaining({ 'User-Agent': 'Jyldam Test' }) }),
    );
  });
});
