import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseFastwayReply } from './parser.js';

// The two public labels cited in numbers.json, with the page's executable scripts omitted.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
const delivered = fixture('delivered');
const attempt = fixture('attempt');

describe('Fastway South Africa tracking', () => {
  it('reads the local scans and their distinct stages', () => {
    const result = parseFastwayReply(delivered, 'D60012157810');
    expect(result).toMatchObject({ current_stage: 'delivered', last_update_local: '2026-11-17T18:37:26' });
    expect(result.events?.map(scan => [scan.provider_code, scan.stage])).toEqual([
      ['YES', 'delivered'], ['ONB', 'out_for_delivery'], ['H15', 'in_transit'], ['PPP', 'in_transit'],
      ['RAW', 'in_transit'], ['ADD', 'in_transit'], ['CIP', 'customs'], ['C47', 'registered'],
    ]);
    expect(result.events?.[0]).toMatchObject({ location: 'Johannesburg', description: 'Your parcel has been delivered and signed for.' });
  });

  it('keeps the failed attempt and removes an exact duplicate delivery scan', () => {
    const result = parseFastwayReply(attempt, 'B10010799111');
    expect(result.events).toHaveLength(7);
    expect(result.events?.filter(scan => scan.stage === 'delivered')).toHaveLength(1);
    expect(result.events).toContainEqual(expect.objectContaining({ stage: 'failed_attempt', provider_code: 'FD3' }));
    expect(result.events?.at(-1)?.stage).toBe('accepted');
  });

  it('preserves a regional signature wording without calling it delivered', () => {
    const signed = delivered.replace('Your parcel has been delivered and signed for.', 'Signature obtained');
    expect(parseFastwayReply(signed, 'D60012157810').events?.[0]).toMatchObject({ description: 'Signature obtained', provider_code: 'YES' });
    expect(parseFastwayReply(signed, 'D60012157810').events?.[0]).not.toHaveProperty('stage');
  });

  it('binds to the label and distinguishes a no-scans reply from malformed data', () => {
    expect(() => parseFastwayReply(delivered, 'CN261107024285')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseFastwayReply(fixture('no-scans'), 'Z99000000007')).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseFastwayReply(`arbitrary(${delivered});`, 'D60012157810')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseFastwayReply('<title>Just a moment...</title>', 'D60012157810')).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('sends one whole label through the supplied HTTP transport', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(delivered));
    const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null,
      browserExecutablePath: null, userAgent: 'Test/1.0' });
    await expect(tracker.track({ number: 'd60012157810' })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://www.fastway.co.za/tracking-api21/?callback=parcelTracking&LabelNo=D60012157810',
      expect.objectContaining({ redirect: 'manual', signal: expect.any(AbortSignal) }));
  });
});
