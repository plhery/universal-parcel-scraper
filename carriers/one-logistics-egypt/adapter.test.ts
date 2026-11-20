import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import fixture from './fixtures/closed-file.json' with { type: 'json' };
import missing from './fixtures/not-found.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const number = fixture.data.shipment_ref;

it('preserves the freight reference and reports the closed file with no delivery scan', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(fixture));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('one-logistics-egypt', number) });

  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://onelogisticseg.com/wp-json/one-logistics/v1/track',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ tracking_ref: number }) }),
  );
  expect(result).toEqual({ status: 'unknown', last_status_text: 'Closed File', summary_only: true });
});

it('requires an exact echoed freight reference', () => {
  expect(() => parseTracking(fixture, 'Wrong/Reference')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});

it('maps the exact carrier response for a missing freight file', () => {
  expect(() => parseTracking(missing, number)).toThrow(expect.objectContaining({ kind: 'not_found' }));
});
