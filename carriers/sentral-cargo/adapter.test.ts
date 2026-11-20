import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseSentralTracking } from './parser.js';

// Result and timeline from the public receipt cited in numbers.json.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const delivered = fixture('delivered');
const number = '00058020178';

describe('Sentral Cargo guest tracking', () => {
  it('keeps the scan offsets and distinguishes a partial delivery from completed delivery', () => {
    const result = parseSentralTracking(delivered, number);
    expect(result).toMatchObject({ current_stage: 'delivered', last_update: '2023-10-10T15:30:28.383+07:00' });
    expect(result.events).toHaveLength(18);
    expect(result.events?.[1]).toMatchObject({ stage: 'out_for_delivery' });
    expect(result.events?.[1]).not.toHaveProperty('location');
    expect(result.events?.[2]).toMatchObject({ stage: 'in_transit', location: 'Depok Proklamasi' });
    expect(result.events).toContainEqual(expect.objectContaining({ description: expect.stringContaining('Antar sebagian'), stage: 'in_transit' }));
    expect(result.events?.at(-1)).toMatchObject({ stage: 'accepted', location: 'Jakarta Lautze' });
  });

  it('distinguishes the whole receipt, the matching absence and an unrelated reply', () => {
    expect(() => parseSentralTracking(delivered, '09900000007')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseSentralTracking(fixture('unknown'), '09900000007')).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseSentralTracking(fixture('unknown'), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSentralTracking('<title>Just a moment...</title>', number)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('looks up the receipt through the supplied HTTP transport', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(delivered));
    const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null,
      browserExecutablePath: null, userAgent: 'Test/1.0' });
    await expect(tracker.track({ number })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`https://sentralcargo.co.id/cekresi?resi=${number}`,
      expect.objectContaining({ redirect: 'manual', signal: expect.any(AbortSignal) }));
  });
});
