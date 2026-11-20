import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const example = fixture('example');
const number = 'ASR-10002';

describe('Pochtai Asr tracking', () => {
  it('reads the published waybill and keeps the carrier’s offsets', () => {
    const result = parseTracking(example, number, 200);
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', provider_code: 'IN_TRANSIT',
      last_status_text: 'In transit', last_update: '2026-11-20T11:39:53+05:00',
    });
    expect(result.events).toHaveLength(5);
    expect(result.events?.[0]).toEqual({
      time: '2026-11-20T11:39:53+05:00', description: 'Arrived in destination city', location: 'Khujand',
      provider_code: 'IN_TRANSIT', stage: 'in_transit', stage_source: 'explicit_mapping',
    });
    expect(result.events?.at(-1)).toMatchObject({ description: 'Accepted at branch', stage: 'accepted' });
  });

  it('uses the carrier’s Tajik labels without changing the stage', () => {
    expect(parseTracking(example, number, 200, 'tg')).toMatchObject({
      current_stage: 'in_transit', last_status_text: 'Дар роҳ',
      events: [expect.objectContaining({ location: 'Хуҷанд' }), ...Array.from({ length: 4 }, () => expect.any(Object))],
    });
  });

  it('distinguishes a native missing waybill from an unavailable API', () => {
    expect(() => parseTracking(fixture('not-found'), number, 404)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTracking('<h1>Not Found</h1>', number, 404)).toThrow(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseTracking('<title>Just a moment...</title>', number, 200))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('rejects another waybill even when its history is valid', () => {
    expect(() => parseTracking(example, 'ASR-10003', 200)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('does not assign a timezone to offset-less scans', () => {
    expect(() => parseTracking(example.replace('+05:00', ''), number, 200))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reconstructs the native waybill and forwards the supplied user agent', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(example));
    const tracker = adapter({
      fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER, userAgent: 'Asr Test',
    });
    await expect(tracker.track({ number: 'ASR10002', language: 'ru-TJ' }, { budgetMs: 2_000 }))
      .resolves.toMatchObject({ last_status_text: 'В пути' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://apost.tj/api/v1/tracking/ASR-10002', expect.objectContaining({
      signal: expect.any(AbortSignal), headers: expect.objectContaining({ 'User-Agent': 'Asr Test' }),
    }));
  });
});
