import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const example = fixture('example');
const missing = fixture('missing');

describe('PaqMex guest guide tracking', () => {
  it('reconnects streamed history and reads each local scan once', () => {
    const result = parseTracking(example, 'Y128037');
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'explicit_mapping',
      last_status_text: 'Entregada', last_update: null, last_update_local: '2022-10-01T10:16',
    });
    expect(result.events).toHaveLength(10);
    expect(result.events?.[0]).toMatchObject({
      description: 'Mercancía entregada confirmada', local_time: '2022-10-01T10:16', stage: 'delivered', location: 'Tampico',
    });
    expect(result.events?.[5]).toMatchObject({ local_time: '2022-09-27T09:54', stage: 'ready_for_pickup' });
    expect(result.events?.[9]).toMatchObject({
      description: 'Envío documentado', local_time: '2022-09-23T17:00', stage: 'registered', location: 'Monterrey',
    });
  });

  it('distinguishes a missing guide, a changed page, and an unfinished stream', () => {
    expect(() => parseTracking(missing, 'ZZZZZZZZ000000000000')).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTracking(missing, 'Y128037')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTracking(example, 'Z128037')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTracking(example.replace('$RS("S:4","P:4")', ''), 'Y128037'))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTracking('<title>Just a moment...</title>', 'Y128037'))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('uses one public GET with the guide and caller signal', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(example));
    const tracker = adapter({
      fetcher, userAgent: 'PaqMex Test', trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER,
    });
    await expect(tracker.track({ number: 'y128037' }, { budgetMs: 2_000 })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      new URL('https://paqmex.com/rastreo?guias=Y128037'),
      expect.objectContaining({ signal: expect.any(AbortSignal), headers: expect.objectContaining({ 'User-Agent': 'PaqMex Test' }) }),
    );
  });
});
