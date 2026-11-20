import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const example = fixture('example');
const number = 'OBN-20260430-IYU2FXS7';

describe('Obana Logistics guest tracking', () => {
  it('reads the identified shipment and its observed creation event', () => {
    const result = parseTracking(example, 200, number);
    expect(result).toMatchObject({
      status: 'pending', current_stage: 'registered', provider_code: 'pending',
      last_status_text: 'Package Created', last_update: '2026-04-30T09:39:45.492Z',
      service_name: 'Standard', destination_country_name: 'Nigeria',
    });
    expect(result.events).toEqual([{
      provider_code: 'created', stage: 'registered', stage_source: 'explicit_mapping',
      description: 'Shipment created successfully', time: '2026-04-30T09:39:45.492Z',
    }]);
  });

  it('uses actual delivery separately from the history when the carrier confirms it', () => {
    const { data } = JSON.parse(example);
    const result = parseTracking(JSON.stringify({ success: true, data: {
      ...data, status: 'fulfilled', display_status: 'Fulfilled', actual_delivery_at: '2026-05-01T09:00:12+01:00',
    } }), 200, number);
    expect(result).toMatchObject({
      status: 'delivered', delivered_at: '2026-05-01T09:00:12+01:00', last_update: '2026-05-01T09:00:12+01:00',
    });
    expect(result.events).toHaveLength(1);
  });

  it('distinguishes an absent shipment from a different identity, malformed reply or browser gate', () => {
    expect(() => parseTracking(fixture('not-found'), 404, 'OBN-7F3K2Q'))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTracking(example, 200, 'OBN-7F3K2Q')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTracking('{"success":true}', 200, number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTracking('<title>Just a moment...</title>', 200, number))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('uses the public URL with one whole reference and no other input', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(JSON.parse(example)));
    const tracker = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(tracker.track({ number: number.toLowerCase() })).resolves.toMatchObject({ current_stage: 'registered' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://obana-logistics-t6qg.onrender.com/shipments/public/track/' + number);
    expect(init?.body).toBeUndefined();
  });
});
