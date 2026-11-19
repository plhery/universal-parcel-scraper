import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, LOGISTICS_SOLUTION_ENDPOINT, LogisticsSolutionTracker } from './adapter.js';
import { parseLogisticsSolution } from './parser.js';

const NUMBER = 'LSX000000001';
type Event = { eventCode?: unknown; eventMessage?: unknown; eventTime?: unknown; eventLocation?: unknown; weightGrams?: unknown };
const event = (overrides: Event = {}): Event => ({ eventCode: 'SYNTHETIC_CODE', eventMessage: 'Synthetic unmapped wording',
  eventTime: '2026-03-10T09:15:00Z', eventLocation: 'Cologne', weightGrams: 1200, ...overrides });
const answer = (events: unknown, parcelNr: unknown = NUMBER) => [{ parcelNr, carrier: 'PRIVATE partner', originCountry: 'DE', destinationCountry: 'AM',
  senderName: 'PRIVATE sender', recipientName: 'Sample Recipient', events }];
const history = [
  event({ eventCode: 'DELIVERED', eventMessage: 'Delivered', eventTime: '2026-03-16T14:02:00+04:00', eventLocation: '12 Private Street, 0010 Yerevan' }),
  event({ eventCode: 'ITEM_AT_DELIVERY_DEPOT', eventMessage: 'Arrived at the delivery depot', eventTime: '2026-03-15T08:00:00+04:00', eventLocation: '0010 Yerevan' }),
  event({ eventCode: 'OFFICE_OF_EXCHANGE_DEPARTED', eventMessage: 'Departed from the office of exchange', eventTime: '2026-03-12T18:30:00Z' }),
  event({ eventCode: 'OFFICE_OF_EXCHANGE_PREALERT', eventMessage: 'Prealert sent', eventTime: '2026-03-11T07:00:00Z' }),
];
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null, userAgent: 'SyntheticHost/1.0' });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('Logistics Solution tracking', () => {
  it('reads the events as instants with their codes and towns, and the recipient, but not the sender, the partner or the weight', () => {
    const result = parseLogisticsSolution(answer(history), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-03-16T14:02:00+04:00', receiver_name: 'Sample Recipient' });
    expect(result.events).toEqual([
      { time: '2026-03-16T14:02:00+04:00', description: 'Delivered', provider_code: 'DELIVERED', stage: 'delivered', stage_source: 'carrier_map' },
      { time: '2026-03-15T08:00:00+04:00', description: 'Arrived at the delivery depot', provider_code: 'ITEM_AT_DELIVERY_DEPOT', location: 'Yerevan',
        stage: 'in_transit', stage_source: 'carrier_map' },
      { time: '2026-03-12T18:30:00Z', description: 'Departed from the office of exchange', provider_code: 'OFFICE_OF_EXCHANGE_DEPARTED', location: 'Cologne',
        stage: 'in_transit', stage_source: 'carrier_map' },
      { time: '2026-03-11T07:00:00Z', description: 'Prealert sent', provider_code: 'OFFICE_OF_EXCHANGE_PREALERT', location: 'Cologne',
        stage: 'registered', stage_source: 'carrier_map' },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|Private|0010|1200|weight/);
  });

  it('reads another code by its message, or leaves it without a stage', () => {
    const worded = parseLogisticsSolution(answer([event({ eventMessage: 'Out for delivery' })]), NUMBER);
    expect(worded).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
    const unmapped = parseLogisticsSolution(answer([event()]), NUMBER);
    expect(unmapped).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic unmapped wording' });
    expect(unmapped).not.toHaveProperty('current_stage');
  });

  it('keeps an answer for another number, an empty one and a changed one apart from a missing parcel', () => {
    expect(() => parseLogisticsSolution(answer(history, 'LSX000000002'), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseLogisticsSolution(answer(history, null), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseLogisticsSolution([], NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const empty of [[], null, undefined]) {
      expect(() => parseLogisticsSolution(answer(empty), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    }
    expect(() => parseLogisticsSolution({ parcelNr: NUMBER }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseLogisticsSolution(answer('none'), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // A clock without its offset or zone is not one the tracker has shown.
    for (const broken of [event({ eventTime: '2026-03-10T09:15:00' }), event({ eventTime: '10.03.2026 09:15' }), event({ eventCode: '', eventMessage: '' })]) {
      expect(() => parseLogisticsSolution(answer([broken]), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('asks for the one number in capitals as the tracker does, over the supplied transport and signal', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(answer(history)));
    await expect(carrier(fetcher).track({ number: ` ${NUMBER.toLowerCase()} ` })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher.mock.calls[0]![0]).toBe(`${LOGISTICS_SOLUTION_ENDPOINT}?barcode=${NUMBER}&language=en`);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    await expect(new LogisticsSolutionTracker({ fetcher }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    for (const number of ['LS,1', 'LS01', `LS${'0'.repeat(40)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reads only the site\'s own answer for an unknown number as not found', async () => {
    const reply = (response: Response) => carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).track({ number: NUMBER });
    for (const error of ['Tracking data not found', 'API returned status 404']) {
      await expect(reply(json({ error }, 404)), error).rejects.toMatchObject({ kind: 'not_found' });
    }
    await expect(reply(json({ error: 'Synthetic failure' }, 404))).rejects.toMatchObject({ kind: 'transport' });
    await expect(reply(new Response('<html><title>404: This page could not be found.</title></html>', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(reply(json({ error: 'API returned status 500' }, 500))).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('tells a block page from a changed answer', async () => {
    const page = (html: string) => carrier(vi.fn<typeof fetch>().mockResolvedValue(new Response(html))).track({ number: NUMBER });
    await expect(page('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(page('<html><title>Logistics Solution</title></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[410, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)('preserves HTTP %i as %s', async (status, kind) => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status }))).track({ number: NUMBER })).rejects.toMatchObject({ kind });
  });
});
