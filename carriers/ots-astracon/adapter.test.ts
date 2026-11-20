import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import delivery from './fixtures/delivery.json' with { type: 'json' };
import listedContainer from './fixtures/listed-container.json' with { type: 'json' };
import notFound from './fixtures/not-found.json' with { type: 'json' };
import onBoard from './fixtures/on-board.json' with { type: 'json' };
import { astraconNumber, parseAstracon } from './parser.js';

describe('O.T.S. ASTRACON public tracking', () => {
  it('takes delivery from the shipment event and orders UTC history newest first', () => {
    const result = parseAstracon(delivery, 'SE260402290');
    expect(result).toMatchObject({
      current_stage: 'delivered', last_status_text: 'Delivery Complete',
      last_update: '2026-10-30T14:19:00Z', delivered_at: '2026-10-30T14:19:00Z',
      expected_delivery: null,
    });
    expect(result.events).toHaveLength(7);
    expect(result.events?.at(-1)).toMatchObject({ description: 'Received the Order', stage: 'registered' });
    expect(parseAstracon(delivery, 'SE260402290BRE')).toEqual(result);
  });

  it('reads the latest physical status when the carrier has yet to scan delivery', () => {
    const result = parseAstracon(onBoard, 'SE260401571');
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Shipped On Board' });
    expect(result.delivered_at).toBeUndefined();
    expect(result.events).toHaveLength(5);
  });

  it('ignores estimates, collapses duplicate events and retains an unknown actual status', () => {
    const shipment = delivery[0]!;
    const result = parseAstracon([{
      ...shipment,
      events: [
        { eventDescription: 'Future delivery', eventTimeUtc: '2026-11-25T00:00:00Z', isEstimate: true },
        { eventDescription: 'Terminal advisory', eventTimeUtc: '2026-10-29T00:00:00Z', isEstimate: false },
        ...shipment.events, shipment.events[0],
      ],
    }], 'SE260402290');
    expect(result.events).toHaveLength(8);
    expect(result.events?.[1]).toMatchObject({ description: 'Terminal advisory' });
    expect(result.events?.[1]?.stage).toBeUndefined();
    expect(result.current_stage).toBe('delivered');
  });

  it('distinguishes a native miss from a listed container and schema errors', () => {
    expect(() => parseAstracon(notFound, 'EGLV560650065707')).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseAstracon(listedContainer, 'TIIU6727162'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
    expect(() => parseAstracon(onBoard, 'SE260402290')).toThrow(/Expected one exact/);
    expect(() => parseAstracon([...delivery, ...delivery], 'SE260402290')).toThrow(/Expected one exact/);
    expect(() => parseAstracon([{ ...delivery[0], events: null }], 'SE260402290')).toThrow(/Missing/);
  });

  it('submits one normalized reference to the guest tracker', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(delivery));
    const tracker = adapter({ env: {}, recorder: NOOP_RECORDER, fetcher, trawl: null, browserExecutablePath: null });
    await expect(tracker.track({ number: ' asqr se260402290 ' })).resolves.toMatchObject({ current_stage: 'delivered' });
    const [url, options] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://www-oaoosf.wisegrid.net/Glow/api/tracker/trackerList');
    expect(options?.method).toBe('POST');
    expect(JSON.parse(String(options?.body))).toEqual({ trackingNumbers: ['SE260402290'], trackingKeys: [] });
    expect(astraconNumber('ASQRSE260399713')).toBe('SE260399713');
    await expect(tracker.track({ number: '/not-a-number' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps challenge pages distinct from empty JSON and malformed replies', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => new Response('Forbidden', { status: 403 }))
      .mockImplementationOnce(async () => Response.json(notFound))
      .mockImplementationOnce(async () => Response.json({}));
    const tracker = adapter({ env: {}, recorder: NOOP_RECORDER, fetcher, trawl: null, browserExecutablePath: null });
    for (const kind of ['challenge', 'not_found', 'schema']) {
      await expect(tracker.track({ number: 'SE260402290' })).rejects.toMatchObject({ kind });
    }
  });
});
