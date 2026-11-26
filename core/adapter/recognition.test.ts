import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BudgetExceededError, CarrierError, ChallengeError, IndeterminateError, InputRequiredError, InvalidInputError, MaintenanceError, NoHistoryError,
  NotFoundError, RateLimitedError, SchemaError, TransportError, UNKNOWN_ITEM_REASONS, UpstreamHttpError, UpstreamNetworkError,
} from '../errors/index.js';
import { REGISTRY } from '../../generated/registry.js';
import { NOOP_RECORDER } from '../telemetry/index.js';
import { AdapterRegistry, accepted, recognizeFromBrowserLookup, recognizeFromLookup } from './index.js';

const carriersDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'carriers');

describe('recognition from a plain lookup', () => {
  it.each([['2026-09-09T08:00:00', '2026-09-09T08:00:00'], ['2026-09-09', '2026-09-09T00:00:00'], ['2026-02-30T08:00:00Z'], ['broken'],
    ['2026-09-09T08:00:00+99:00'], ['2026-09-09T08:00:00+02:99'], ['2026-09-09T08:00:00+24:00'],
    ['2026-09-09T08:00:00-24:00'], ['2026-09-09T08:00:00+0299']])(
    'does not infer an instant from %s', async (time, local?: string) => {
      await expect(recognizeFromLookup(async () => ({ status: 'in_transit', last_update: time,
        events: [{ time, description: 'Sorted' }] })))
        .resolves.toEqual({ known: true, lastActivityAt: null, ...(local ? { lastActivityLocal: local } : {}) });
    },
  );

  it.each([
    ['2026-09-09T08:00:00+02:30', '2026-09-09T05:30:00.000Z'],
    ['2026-09-09T08:00:00+0230', '2026-09-09T05:30:00.000Z'],
    ['2026-09-09T08:00:00-04:00', '2026-09-09T12:00:00.000Z'],
  ])('retains activity from a valid explicit offset: %s', async (time, expected) => {
    await expect(recognizeFromLookup(async () => ({ status: 'in_transit', last_update: time,
      events: [{ time, description: 'Sorted' }] }))).resolves.toEqual({ known: true, lastActivityAt: expected });
  });

  it('cannot promote a malformed newer clock over genuine activity', async () => {
    await expect(recognizeFromLookup(async () => ({ status: 'in_transit', last_update: '2026-09-30T08:00:00+99:00',
      events: [{ time: '2026-09-30T08:00:00+02:99', description: 'Malformed scan' },
        { time: '2026-09-09T08:00:00+02:00', description: 'Dated scan' }] })))
      .resolves.toEqual({ known: true, lastActivityAt: '2026-09-09T06:00:00.000Z' });
  });

  it('ignores a newer unresolved clock when a genuine activity instant is available', async () => {
    await expect(recognizeFromLookup(async () => ({ status: 'in_transit',
      events: [{ time: '2026-09-10T12:00:00', description: 'Local scan' },
        { time: '2026-09-09T08:00:00+02:00', description: 'Dated scan' }] })))
      .resolves.toEqual({ known: true, lastActivityAt: '2026-09-09T06:00:00.000Z' });
  });

  it('keeps the newest local clock when no scan states an instant', async () => {
    await expect(recognizeFromLookup(async () => ({ status: 'delivered', last_update_local: '2026-03-02T09:00:00',
      events: [{ local_time: '2026-03-02T09:00:00', description: 'Delivered' }, { local_time: '2026-02-27T18:30:00', description: 'Collected' }] })))
      .resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-02T09:00:00', finished: true });
    // An instant comes first, and an impossible wall time or an offset is no local clock.
    await expect(recognizeFromLookup(async () => ({ status: 'in_transit',
      events: [{ local_time: '2026-09-10T12:00:00', description: 'Local scan' }, { time: '2026-09-09T08:00:00+02:00', description: 'Dated scan' }] })))
      .resolves.toEqual({ known: true, lastActivityAt: '2026-09-09T06:00:00.000Z' });
    for (const local_time of ['2026-02-30T08:00:00', '2026-09-09T08:00:00+02:00', 'broken']) {
      await expect(recognizeFromLookup(async () => ({ status: 'in_transit', events: [{ local_time, description: 'Sorted' }] })), local_time)
        .resolves.toEqual({ known: true, lastActivityAt: null });
    }
    await expect(recognizeFromLookup(async () => ({ status: 'unknown', events: [], last_update_local: '2026-03-02T09:00:00' })))
      .resolves.toEqual({ known: false, lastActivityAt: null });
  });

  it('reads a result as known, a positive not-found as unknown, and rethrows the rest', async () => {
    await expect(recognizeFromLookup(async () => ({
      status: 'in_transit', events: [
        { time: '2026-09-08T10:00:00Z', description: 'Sorted' }, { time: '2026-09-09T08:00:00+02:00', description: 'Out' },
      ],
    }))).resolves.toEqual({ known: true, lastActivityAt: '2026-09-09T06:00:00.000Z' });
    await expect(recognizeFromLookup(async () => ({ status: 'unknown', events: [] }))).resolves.toEqual({ known: false, lastActivityAt: null });
    // "Tracking information received" for any number is no evidence.
    await expect(recognizeFromLookup(async () => ({ status: 'pending', events: [] }))).resolves.toEqual({ known: false, lastActivityAt: null });
    // A delivered or returned parcel says so, since a stranger's finished parcel is no answer for a new one.
    await expect(recognizeFromLookup(async () => ({ status: 'delivered', events: [], last_update: '2026-09-09T08:00:00Z' })))
      .resolves.toEqual({ known: true, lastActivityAt: '2026-09-09T08:00:00.000Z', finished: true });
    await expect(recognizeFromLookup(async () => ({ status: 'exception', current_stage: 'returned', events: [], last_update: '2026-09-09T08:00:00Z' })))
      .resolves.toEqual({ known: true, lastActivityAt: '2026-09-09T08:00:00.000Z', finished: true });
    await expect(recognizeFromLookup(async () => ({ status: 'delivered', current_stage: 'out_for_delivery', events: [], last_update: '2026-09-09T08:00:00Z' })))
      .resolves.toEqual({ known: true, lastActivityAt: '2026-09-09T08:00:00.000Z' });
    await expect(recognizeFromLookup(async () => { throw new NotFoundError('Carrier'); })).resolves.toEqual({ known: false });
    // A lookup that rejects the number's format knows it no better than one that cannot find it.
    await expect(recognizeFromLookup(async () => { throw new InvalidInputError('Carrier'); })).resolves.toEqual({ known: false });
    expect(accepted(() => { throw new InvalidInputError('Carrier'); })).toBe(false);
    // A form of number the adapter does not accept is unknown without a request.
    let asked = false;
    const reject = () => accepted(() => { throw new TypeError('Unsupported number'); });
    await expect(recognizeFromLookup(async () => { asked = true; return { status: 'delivered' }; }, reject)).resolves.toEqual({ known: false });
    expect(asked).toBe(false);
    // Any other TypeError is a failure, not an answer.
    await expect(recognizeFromLookup(async () => { throw new TypeError('Cannot read properties of null'); })).rejects.toThrow(TypeError);
    // Day-first carrier dates are no instant: the parcel is known, its activity dated on the local clock.
    await expect(recognizeFromLookup(async () => ({ status: 'in_transit', events: [{ time: '27/09/2026 08:15', description: 'Sorted' }] })))
      .resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-09-27T08:15:00' });
    await expect(recognizeFromLookup(async () => { throw new UpstreamHttpError('Carrier', 503); })).rejects.toThrow();
  });

  it('reads a carrier\'s answer that shows no parcel under the number as unknown', async () => {
    const answers: Error[] = [
      new NoHistoryError('Carrier', undefined, { reason: 'portal_not_found' }),
      ...[...UNKNOWN_ITEM_REASONS].map((reason) => new IndeterminateError('Carrier', undefined, { reason })),
      // An adapter that rebuilds a failure keeps its kind and reason.
      new CarrierError('indeterminate', 'Carrier', 'No history', { reason: 'portal_not_found' }),
    ];
    for (const answer of answers) {
      await expect(recognizeFromLookup(async () => { throw answer; }), answer.message).resolves.toEqual({ known: false });
      // A step runner's wrapper keeps the answer.
      await expect(recognizeFromLookup(async () => { throw new Error('direct failed', { cause: answer }); })).resolves.toEqual({ known: false });
    }
    expect([...UNKNOWN_ITEM_REASONS].sort()).toEqual(['no_history', 'portal_not_found', 'status_api_not_found', 'webtrack_no_history']);
  });

  it('knows a number the carrier holds a record of without a scan', async () => {
    const answers: Error[] = [
      new NoHistoryError('Carrier', undefined, { reason: 'listed' }),
      new NoHistoryError('Carrier', undefined, { reason: 'parcel_found' }),
      new NoHistoryError('Carrier', undefined, { reason: 'written_ahead', writtenAhead: ['2026-09-09T08:00:00+02:00'] }),
      // A record that names the delivery carrier, or steps the carrier wrote ahead of them.
      new NoHistoryError('Carrier', undefined, { deliveryCarrier: 'dpd', deliveryTrackingNumber: '01234567890123' }),
      new NoHistoryError('Carrier', undefined, { plannedEvents: [{ time: '2026-09-09T08:00:00Z', description: 'Departure', stage: 'in_transit' }] }),
      new CarrierError('indeterminate', 'Carrier', 'Listed', { reason: 'listed' }),
    ];
    for (const answer of answers) {
      await expect(recognizeFromLookup(async () => { throw answer; }), answer.message).resolves.toEqual({ known: true, lastActivityAt: null });
      await expect(recognizeFromLookup(async () => { throw new Error('direct failed', { cause: answer }); })).resolves.toEqual({ known: true, lastActivityAt: null });
    }
  });

  it('keeps every failure that says nothing about the number a failure', async () => {
    const failures: Error[] = [
      new IndeterminateError('Carrier'),
      new IndeterminateError('Carrier', 'Endpoint unavailable', { reason: 'session_rejected' }),
      // A regional tracker's miss: the carrier's global tracker may know the number.
      new IndeterminateError('Carrier', undefined, { reason: 'webtrack_not_found' }),
      new UpstreamHttpError('Carrier', 502),
      new UpstreamNetworkError('Carrier', new Error('socket hang up')),
      new ChallengeError('Carrier'),
      new RateLimitedError('Carrier', 60_000),
      new MaintenanceError('Carrier'),
      new SchemaError('Carrier'),
      new TransportError('Carrier'),
      new BudgetExceededError('Carrier', 8_000),
      // A no-history answer without a reason may be a record the carrier holds without rows, or none.
      new NoHistoryError('Carrier'),
      new NoHistoryError('Carrier', undefined, { reason: 'unsupported_reference' }),
      // The first carrier error in the chain decides: an outage that wraps an older answer is an outage.
      new IndeterminateError('Carrier', 'Unavailable', { cause: new NoHistoryError('Carrier') }),
    ];
    for (const failure of failures) {
      await expect(recognizeFromLookup(async () => { throw failure; }), failure.message).rejects.toBe(failure);
    }
  });

  it('keeps an answer the adapter reads as inconclusive a failure', async () => {
    const blank = new IndeterminateError('Carrier', 'Shows nothing for the waybill', { reason: 'portal_not_found' });
    const inconclusive = (error: unknown) => error === blank;
    await expect(recognizeFromLookup(async () => { throw blank; }, undefined, { inconclusive })).rejects.toBe(blank);
    await expect(recognizeFromLookup(async () => { throw new NotFoundError('Carrier'); }, undefined, { inconclusive })).resolves.toEqual({ known: false });
  });

  it('knows a parcel the carrier holds behind the recipient\'s postcode, and no number a form asks a postcode for', async () => {
    const held = new InputRequiredError('Carrier', 'a postcode', undefined, { reason: 'parcel_found' });
    await expect(recognizeFromLookup(async () => { throw held; })).resolves.toEqual({ known: true, lastActivityAt: null });
    // A step runner's wrapper keeps the answer.
    await expect(recognizeFromLookup(async () => { throw new Error('direct failed', { cause: held }); }))
      .resolves.toEqual({ known: true, lastActivityAt: null });
    // A carrier that asks every number for a postcode says nothing about this one.
    await expect(recognizeFromLookup(async () => { throw new InputRequiredError('Carrier', 'a postcode'); }))
      .rejects.toMatchObject({ kind: 'input_required' });
    await expect(recognizeFromLookup(async () => { throw new InputRequiredError('Carrier', 'a postcode', undefined, { reason: 'postcode_mismatch' }); }))
      .rejects.toMatchObject({ kind: 'input_required' });
  });
});

describe('catalog recognition', () => {
  it('is declared only by carriers whose adapter can recognize a number', () => {
    const registry = new AdapterRegistry(REGISTRY, { trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    const declared = readdirSync(carriersDirectory).filter((id) => {
      try {
        return Boolean(JSON.parse(readFileSync(path.join(carriersDirectory, id, 'carrier.json'), 'utf8')).tracking?.recognition);
      } catch { return false; }
    });
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((id) => typeof registry.for(id)?.recognize !== 'function')).toEqual([]);
  });
  it('declares browser recognition only where the adapter supplies it', () => {
    const registry = new AdapterRegistry(REGISTRY, { trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    const declared = readdirSync(carriersDirectory).filter((id) => {
      try { return Boolean(JSON.parse(readFileSync(path.join(carriersDirectory, id, 'carrier.json'), 'utf8')).tracking?.browserRecognition); }
      catch { return false; }
    });
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((id) => typeof registry.for(id)?.recognizeWithBrowser !== 'function')).toEqual([]);
  });
});

describe('browser confirmation', () => {
  it('retains dated local history without inventing an activity instant', async () => {
    const result = { status: 'delivered' as const, last_update_local: '2026-03-02T09:00',
      events: [{ local_time: '2026-03-02T09:00', description: 'Delivered' },
        { local_time: '2026-02-27T18:30', description: 'Collected' }] };
    await expect(recognizeFromBrowserLookup(async () => result)).resolves.toEqual({
      known: true, lastActivityAt: null, lastActivityLocal: '2026-03-02T09:00:00', finished: true, result,
    });
    for (const local_time of ['2026-02-30T08:00:00', '2026-09-09T08:00:00+99:00', 'broken']) {
      await expect(recognizeFromBrowserLookup(async () => ({ status: 'in_transit', events: [{ local_time, description: 'Sorted' }] })), local_time)
        .resolves.toEqual({ known: false, lastActivityAt: null });
    }
    await expect(recognizeFromBrowserLookup(async () => ({ status: 'unknown', events: [], last_update_local: '2026-03-02T09:00' })))
      .resolves.toEqual({ known: false, lastActivityAt: null });
  });

  it('rejects shells and undated default statuses, and retains dated history', async () => {
    await expect(recognizeFromBrowserLookup(async () => ({ status: 'in_transit', events: [] })))
      .resolves.toEqual({ known: false, lastActivityAt: null });
    await expect(recognizeFromBrowserLookup(async () => ({ status: 'unknown', events: [] })))
      .resolves.toEqual({ known: false, lastActivityAt: null });
    const result = { status: 'in_transit' as const, events: [{ time: '2026-09-09T08:00:00Z', description: 'Sorted' }] };
    await expect(recognizeFromBrowserLookup(async () => result)).resolves.toEqual({
      known: true, lastActivityAt: '2026-09-09T08:00:00.000Z', result,
    });
    await expect(recognizeFromBrowserLookup(async () => { throw new NotFoundError('Carrier'); })).resolves.toEqual({ known: false, lastActivityAt: null });
    await expect(recognizeFromBrowserLookup(async () => { throw new UpstreamHttpError('Carrier', 503); })).rejects.toThrow();
  });

  it('reads the page\'s answer without history as over HTTP, with no history to reuse', async () => {
    await expect(recognizeFromBrowserLookup(async () => { throw new IndeterminateError('Carrier', undefined, { reason: 'portal_not_found' }); }))
      .resolves.toEqual({ known: false, lastActivityAt: null });
    await expect(recognizeFromBrowserLookup(async () => { throw new NoHistoryError('Carrier', undefined, { reason: 'portal_not_found' }); }))
      .resolves.toEqual({ known: false, lastActivityAt: null });
    await expect(recognizeFromBrowserLookup(async () => { throw new NoHistoryError('Carrier', undefined, { reason: 'listed' }); }))
      .resolves.toEqual({ known: true, lastActivityAt: null });
    await expect(recognizeFromBrowserLookup(async () => { throw new ChallengeError('Carrier'); })).rejects.toThrow(ChallengeError);
  });

  it('normalizes the retained result like every tracking result', async () => {
    // An invented USPS package identifier behind a routing prefix with a made-up ZIP code.
    const pic = '9210090000000012345679';
    const answer = await recognizeFromBrowserLookup(async () => ({ status: 'in_transit', delivery_carrier: 'usps',
      delivery_tracking_number: `42000000${pic}`, events: [{ time: '2026-09-09T08:00:00Z', description: 'Sorted' }] }));
    expect(answer).toMatchObject({ known: true, result: { delivery_carrier: 'usps', delivery_tracking_number: pic } });
    // A result no tracking lookup would accept is a failure, not an answer.
    await expect(recognizeFromBrowserLookup(async () => ({ status: 'in_transit', events: [{ time: '2026-09-09T08:00:00Z', description: 7 }] } as never)))
      .rejects.toThrow(TypeError);
  });
});
