import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AdapterRegistry, type AdapterEnvironment } from '../../core/adapter/index.js';
import { trackCarrier } from '../../core/adapter/track.js';
import { carrierAdapter, carrierDefinition, tracksAutomatically } from '../../core/catalog/index.js';
import { deliveryHandoff, hasDirectHandoffAdapter } from '../../core/catalog/handoff.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker, TrackingError } from '../../facade/index.js';
import { REGISTRY } from '../../generated/registry.js';
import type { UniversalTracker } from '../../providers/universal.js';

const number = 'EM000000000001CA';
const consolidator = 'YT0000000000000001';
const history: unknown = JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
const reply = () => new Response(JSON.stringify(history), { headers: { 'Content-Type': 'application/json' } });

describe('Emile catalog and tracking', () => {
  it('tracks a number filed under Emile through an enabled provider', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply());
    const answer = await createTracker({ providers: ['ParcelsApp'], fetcher }).track({ number, carrier: 'emile' });
    expect(answer).toMatchObject({
      carrier: 'emile', source: 'ParcelsApp', attempts: [{ source: 'ParcelsApp', kind: 'ok' }],
      result: { status: 'delivered', current_stage: 'delivered' },
    });
    expect(answer.result.events.map(event => [event.time, event.description])).toEqual([
      ['2026-01-06T15:00:00.000Z', 'Delivered'],
      ['2026-01-06T13:00:00.000Z', 'OUT FOR DELIVERY'],
      ['2026-01-05T18:00:00.000Z', 'ORDER SORTED'],
      ['2026-01-05T09:00:00.000Z', 'ARRIVE TRANSITHUB'],
      ['2026-01-02T08:00:00.000Z', 'Shipment information received'],
    ]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]![0])).toBe('https://parcelsapp.com/api/v2/parcels');
  });

  it('dispatches a consumer router\'s Emile lookup to its configured providers', async () => {
    const registry = new AdapterRegistry(REGISTRY, { trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    const fetch = vi.fn().mockResolvedValue({ status: 'in_transit', current_stage: 'in_transit', tracking_provider: 'ParcelsApp',
      events: [{ time: '2026-01-05T09:00:00Z', description: 'ARRIVE TRANSITHUB', stage: 'in_transit' }] });
    const universal = { fetch } as unknown as UniversalTracker;
    const signal = new AbortController().signal;
    const result = await trackCarrier('emile', { number, postcode: null }, { registry, universal, signal, budgetMs: 5_000 });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(number, null, { signal, budgetMs: 5_000 });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', tracking_provider: 'ParcelsApp' });
  });

  it('only suggests Emile, so a number without a carrier is asked as unknown', async () => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['emile'] });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply());
    const answer = await createTracker({ providers: ['ParcelsApp'], fetcher }).track({ number });
    expect(answer).toMatchObject({ carrier: 'unknown', source: 'ParcelsApp' });
  });

  it('keeps providers opt-in and advertises no direct adapter or assumed scan timezone', async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(carrierAdapter('emile')).toBe('universal');
    expect(tracksAutomatically('emile')).toBe(true);
    expect(carrierDefinition('emile').timezone).toBe('UTC');
    await expect(createTracker({ fetcher }).track({ number, carrier: 'emile' })).rejects.toBeInstanceOf(TrackingError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps a consolidator naming Emile as its delivery partner without a second lookup', async () => {
    expect(hasDirectHandoffAdapter('emile', number)).toBe(false);
    expect(deliveryHandoff('yunexpress', consolidator, { delivery_carrier: 'emile', delivery_tracking_number: number })).toBeNull();
    const environment: AdapterEnvironment = { trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} };
    const track = vi.fn().mockResolvedValue({
      status: 'in_transit', delivery_carrier: 'emile', delivery_tracking_number: number,
      events: [{ time: '2026-01-05T09:00:00Z', description: 'ARRIVE TRANSITHUB', stage: 'in_transit' }],
    });
    const registry = new AdapterRegistry({
      factories: { yunexpress: () => ({ id: 'yunexpress', steps: ['direct'], track }) },
      carriers: { yunexpress: 'yunexpress', emile: 'universal' },
    }, environment);
    const fetcher = vi.fn<typeof fetch>();
    const answer = await createTracker({ registry, providers: ['ParcelsApp'], fetcher }).track({ number: consolidator, carrier: 'yunexpress' });
    expect(answer).toMatchObject({ carrier: 'yunexpress', source: 'yunexpress', result: { delivery_carrier: 'emile', delivery_tracking_number: number } });
    expect(answer.handoff).toBeUndefined();
    expect(track).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
