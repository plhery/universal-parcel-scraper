import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const example = fixture('example');
const number = 'JL-10232026-00017';

describe('JOMA departure tracking', () => {
  it('keeps the two completed milestones with calendar-day precision', () => {
    expect(parseTracking(example, number)).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'explicit_mapping',
      last_status_text: 'Departed New York', provider_code: 'departed', last_update: null,
      last_update_local: '2026-10-24', expected_delivery: null,
      events: [
        { local_time: '2026-10-24', description: 'Departed New York', provider_code: 'departed',
          stage: 'in_transit', stage_source: 'explicit_mapping' },
        { local_time: '2026-10-21', description: 'Received at our New York office', provider_code: 'received',
          stage: 'accepted', stage_source: 'explicit_mapping' },
      ],
    });
  });

  it('rejects a different departure with otherwise valid milestones', () => {
    expect(() => parseTracking(example, 'JL-10232026-00018')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('distinguishes the native absence reply, a generic error and a challenge', () => {
    expect(() => parseTracking(fixture('not-found'), number)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTracking('{"result":null,"error":"service unavailable"}', number))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTracking('<title>Just a moment...</title>', number))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('does not infer a completed arrival from an unreached milestone', () => {
    expect(() => parseTracking(example.replace('"current": "departed"', '"current": "arrived"'), number))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('uses the public invoice lookup with the caller’s user agent and signal', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(example));
    const tracker = adapter({
      fetcher, userAgent: 'JOMA Test', trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER,
    });
    await expect(tracker.track({ number: 'JL1023202600017' }, { budgetMs: 2_000 })).resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      new URL('https://jomalogisticsnyc.com/api/public-tracking?tracking=JL-10232026-00017'),
      expect.objectContaining({ signal: expect.any(AbortSignal), headers: expect.objectContaining({ 'User-Agent': 'JOMA Test' }) }),
    );
  });
});
