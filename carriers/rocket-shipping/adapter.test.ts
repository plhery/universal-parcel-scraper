import { expect, it, vi } from 'vitest';
import { IndeterminateError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';
import delivered from './fixtures/delivered.json' with { type: 'json' };

const number = String(delivered.loadNumber);

it('reads the public events and their UTC clocks for the matching load', () => {
  const result = parseTracking(delivered, number);
  expect(result).toMatchObject({ current_stage: 'delivered', last_update: '2026-01-21T01:33:31.095Z' });
  expect(result.events?.map(event => event.stage)).toEqual(['delivered', 'accepted']);
});

it('reads notes when the tracker offers no customer-facing events', () => {
  const result = parseTracking({
    loadNumber: number, friendly: { events: [] },
    trackingNotes: [{ createdDateUtc: '2026-01-14T01:37:45Z', notes: 'Pickup confirmed' }],
  }, number);
  expect(result.events).toEqual([{ time: '2026-01-14T01:37:45Z', description: 'Pickup confirmed' }]);
});

it('distinguishes another load, an empty history and a failed lookup', () => {
  expect(() => parseTracking(delivered, '999999999')).toThrow(IndeterminateError);
  expect(() => parseTracking({ loadNumber: number, trackingNotes: [] }, number)).toThrow(NoHistoryError);
  expect(() => parseTracking({ error: 'Error fetching tracking notes' }, number)).toThrow(SchemaError);
});

it('passes the entire load number and caller transport to the public route', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(delivered));
  const instance = adapter({ fetcher, userAgent: 'Rocket test agent', env: {}, recorder: NOOP_RECORDER,
    trawl: null, browserExecutablePath: null });
  await expect(instance.track({ number })).resolves.toMatchObject({ current_stage: 'delivered' });
  const [request, init] = fetcher.mock.calls[0]!;
  expect(String(request)).toBe(`https://tracking.rocketshipping.io/.netlify/functions/tracking?loadId=${number}`);
  expect(new Headers(init?.headers).get('User-Agent')).toBe('Rocket test agent');
});
