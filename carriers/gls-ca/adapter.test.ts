import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseGlsCanada } from './parser.js';
import delivered from './fixtures/delivered.json' with { type: 'json' };

const text = (filename: string) => readFileSync(new URL(`./fixtures/${filename}.json`, import.meta.url), 'utf8');
const number = 'P66776054';

describe('GLS Canada guest tracking', () => {
  it('reads the canonical parcel timeline and keeps its terminal clocks local', () => {
    const result = parseGlsCanada(text('delivered'), number);
    expect(result).toMatchObject({ current_stage: 'delivered', service_name: 'Ground', destination_country: 'CA',
      last_update: null, last_update_local: '2026-10-13T15:21:01' });
    expect(result.events?.map(scan => [scan.provider_code, scan.stage])).toEqual([
      ['69D', 'delivered'], ['68', 'out_for_delivery'], ['34', 'in_transit'], ['33', 'in_transit'], ['NU', 'registered'],
    ]);
    expect(result.events?.[0]).toMatchObject({ location: 'Toronto', local_time: '2026-10-13T15:21:01' });
  });

  it('uses the shipment summary when a shipment has more than one parcel', () => {
    const data = structuredClone(delivered);
    const shipment = data.shipments[0]!;
    shipment.currentStatus.name = 'In Transit';
    shipment.parcels.push({ ...shipment.parcels[0]!, parcelId: 2, activities: [] });
    expect(parseGlsCanada(JSON.stringify(data), number)).toMatchObject({ current_stage: 'in_transit', summary_only: true, events: [] });
  });

  it('distinguishes a matching no-record reply from the wrong number and invalid data', () => {
    expect(() => parseGlsCanada(text('no-record'), 'W99000007')).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseGlsCanada(text('no-record'), number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseGlsCanada('[]', number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseGlsCanada('<title>Just a moment...</title>', number)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('uses the supplied transport for one number with the locale read by the parser', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(text('delivered')));
    const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null,
      browserExecutablePath: null, userAgent: 'Test/1.0' });
    await expect(tracker.track({ number: 'p66776054' })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`https://web.gls-canada.com/api/tracking/${number}`,
      expect.objectContaining({ redirect: 'manual', signal: expect.any(AbortSignal),
        headers: expect.objectContaining({ 'Accept-Language': 'en-CA', 'User-Agent': 'Test/1.0' }) }));
  });
});
