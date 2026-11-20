import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import delivered from './fixtures/delivered.json' with { type: 'json' };
import handoff from './fixtures/last-mile-awb.json' with { type: 'json' };
import missing from './fixtures/not-found.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const number = delivered.data[0]!.awb;

it('keeps QuickShip’s actual milestones and uses its separate delivery timestamp', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(delivered));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('quickship-canada', number) });

  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://qsapi.quickshipnow.com/public/track?awb=QS207431&origin=track.quickshipnow.com',
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(result).toMatchObject({
    current_stage: 'delivered', last_status_text: 'Delivered',
    last_update: '2026-05-29T05:31:30Z', delivered_at: '2026-05-29T05:31:30Z',
  });
  expect(result.events?.[0]).toMatchObject({ provider_code: '309', stage: 'in_transit', local_time: '2026-06-08T08:40' });
  expect(result.events?.some(event => event.provider_code === '308')).toBe(false);
  expect(result.events?.find(event => event.provider_code === '407')).toMatchObject({
    description: 'Delivered', local_time: '2026-05-29T11:01',
  });
  expect(result.events?.some(event => event.time || event.location)).toBe(false);
});

it('verifies the echoed last-mile AWB and combines the scans of the matching packages', () => {
  const handoffNumber = handoff.data[0]!.lmAwb;
  expect(parseTracking(handoff, handoffNumber)).toMatchObject({
    current_stage: 'delivered', delivered_at: '2026-04-05T11:33:09Z',
  });
  expect(() => parseTracking(handoff, number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));

  const pending = { ...delivered.data[0]!, statusCode: '406', status: 'Out for delivery' };
  const mixed = parseTracking({ ...delivered, data: [...delivered.data, pending] }, number);
  expect(mixed.status).toBe('unknown');
  expect(mixed.delivered_at).toBeUndefined();
  expect(mixed.events?.length).toBeGreaterThan(1);
});

it('recognizes the carrier’s specific absent waybill response', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(missing, { status: 400 }));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  await expect(tracker.track({ number: 'QS570719299745' })).rejects.toMatchObject({ kind: 'not_found' });
});
