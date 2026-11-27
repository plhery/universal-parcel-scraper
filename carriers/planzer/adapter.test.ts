import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { outsideCountryLast } from '../../core/testing/recognition.js';
import {
  adapter,
  fetchPlanzer,
  parsePlanzerTrackingResponse,
  PlanzerTracker,
  planzerShipmentNumber,
} from './adapter.js';
import { planzerDescription, planzerEventStage } from './status.js';

const folder = path.dirname(fileURLToPath(import.meta.url));
const carrier = JSON.parse(
  readFileSync(path.join(folder, 'carrier.json'), 'utf8'),
) as { capabilities: string[] };

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(folder, 'fixtures', name), 'utf8'));
}

const QUICKPAC_NUMBER = '440000000000000001';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/** The tracking app's own answer for a number it holds no shipment under: an empty 404 with its correlation cookie. */
function planzerNotFound(): Response {
  return new Response(null, {
    status: 404,
    headers: { 'Set-Cookie': 'TnT-Correlation-Id=00000000-0000-0000-0000-000000000000; domain=.tracking.app.planzer.ch; path=/; secure; samesite=lax; httponly' },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Planzer and Quickpac transient failures', () => {
  beforeEach(() => vi.useFakeTimers());

  it('recovers from a Quickpac transport timeout without losing shipment validation', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new DOMException('Timed out', 'TimeoutError'))
      .mockResolvedValueOnce(jsonResponse({
        overallStatus: { text: { english: 'Recorded' } },
        transportPositions: [{ positionNumber: QUICKPAC_NUMBER, positionEvents: [] }],
      }));
    const result = fetchPlanzer(QUICKPAC_NUMBER);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toMatchObject({ status: 'pending', events: [] });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('Planzer rate limits', () => {
  it('fails at once as rate limited when the wait Retry-After asks for outlasts the lookup', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('Too many requests', {
      status: 429, headers: { 'Retry-After': '30' },
    }));
    const started = performance.now();
    await expect(new PlanzerTracker({ fetcher }).fetch(QUICKPAC_NUMBER, { budgetMs: 3_000 }))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    // The budget is not spent waiting for a retry that could not be made.
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe('Planzer and Quickpac no-data responses', () => {
  it('keeps both direct tracking number formats and reads the API\'s own 404 as not found', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => planzerNotFound());
    const cases = [
      ['12345678901234567890', '12345678901234567890'],
      ['440000000000000000', '440000000000000000'],
    ] as const;

    for (const [trackingNumber, shipmentNumber] of cases) {
      expect(planzerShipmentNumber(trackingNumber)).toBe(shipmentNumber);
      await expect(fetchPlanzer(trackingNumber)).rejects.toMatchObject({
        name: 'NotFoundError',
        kind: 'not_found',
        status: 404,
      });
    }

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]?.[0]))
      .toContain('/shipments/12345678901234567890/Pak');
    expect(String(fetcher.mock.calls[1]?.[0]))
      .toContain('/shipments/440000000000000000/Pak');
  });

  it('looks up only the shipment half of a reference composite', () => {
    expect(planzerShipmentNumber('ref.000123456')).toBe('123456');
    expect(planzerShipmentNumber('ref.000')).toBe('000');
    // The same composite as the app stores it, without the dot.
    expect(planzerShipmentNumber('12345.0012345678')).toBe('12345678');
    expect(planzerShipmentNumber('123450012345678')).toBe('12345678');
    // Other shapes go to the API unchanged.
    expect(planzerShipmentNumber('123451234567890')).toBe('123451234567890');
    expect(planzerShipmentNumber('12345678')).toBe('12345678');
  });

  it('reads every parcel of a shipment looked up by shipment number, once per milestone', async () => {
    const parcel = (positionNumber: string, times: string[]) => ({
      positionNumber,
      positionEvents: ['Recorded', 'Transferred', 'In delivery', 'Shipped']
        .map((english, index) => ({ createdAt: times[index], text: { english } })),
    });
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      shipmentNumber: '12345678',
      overallStatus: { text: { english: 'Shipment delivered' } },
      deliveryAddress: { name: 'Made Up Recipient', street: 'Example Street', houseNumber: '1' },
      transportPositions: [
        parcel('00000000000000000017', ['2026-09-01T13:24:52.0503924', '2026-09-01T17:21:52.001', '2026-09-02T03:54:29.410465', '2026-09-02T11:38:03.275']),
        parcel('00000000000000000024', ['2026-09-01T13:24:52.0503989', '2026-09-01T17:21:55.001', '2026-09-02T03:54:35.0183809', '2026-09-02T11:38:03.275']),
      ],
    }));

    const result = await fetchPlanzer('123450012345678');
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('/shipments/12345678/Pak');
    expect(result).toMatchObject({ status: 'delivered', last_update: '2026-09-02T11:38:03.275' });
    expect(result.events?.map((event) => [event.time, event.description, event.stage])).toEqual([
      ['2026-09-02T11:38:03.275', 'Delivered', 'delivered'],
      ['2026-09-02T03:54:29.410465', 'In delivery', 'out_for_delivery'],
      ['2026-09-01T17:21:52.001', 'Transferred', 'in_transit'],
      ['2026-09-01T13:24:52.0503924', 'Recorded', 'registered'],
    ]);
    expect(result).toMatchObject({ receiver_name: 'Made Up Recipient', receiver_address: 'Example Street 1' });
  });

  it('keeps a milestone per parcel when the parcels reach it at different times', () => {
    const result = parsePlanzerTrackingResponse({
      shipmentNumber: '12345678',
      overallStatus: { text: { english: 'Shipment delivered' } },
      transportPositions: ['2026-09-02T11:38:03', '2026-09-03T09:10:00'].map((createdAt, index) => ({
        positionNumber: `0000000000000000001${index}`,
        positionEvents: [{ createdAt, text: { english: 'Shipped' } }],
      })),
    }, '12345678');
    expect(result.events?.map((event) => event.time)).toEqual(['2026-09-03T09:10:00', '2026-09-02T11:38:03']);
  });

  it('uses only the matching transport position and recognizes the delivered label', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      overallStatus: { text: { english: 'Shipment delivered' } },
      transportPositions: [
        {
          positionNumber: '123456',
          positionEvents: [{
            createdAt: '2026-08-30T12:00:00Z',
            text: { english: 'Shipment delivered' },
          }],
        },
        {
          positionNumber: '999999',
          positionEvents: [{
            createdAt: '2026-08-31T12:00:00Z',
            text: { english: 'Private event from a different shipment' },
          }],
        },
      ],
    }));

    await expect(fetchPlanzer('ref.000123456')).resolves.toMatchObject({
      status: 'delivered',
      last_status_text: 'Shipment delivered',
      events: [{ description: 'Shipment delivered' }],
    });
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('/shipments/123456/Pak');
  });

  it('rejects transport positions belonging to another shipment', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      overallStatus: { text: { english: 'Shipment on the way' } },
      transportPositions: [{ positionNumber: '999999', positionEvents: [] }],
    }));

    await expect(fetchPlanzer('123456')).rejects.toThrow('different shipment');
  });

  it('rejects a reply for another shipment number', () => {
    expect(() => parsePlanzerTrackingResponse({
      shipmentNumber: '99999980',
      overallStatus: { text: { english: 'Shipment on the way' } },
      transportPositions: [{ positionNumber: '00000000000000000017', positionEvents: [] }],
    }, '12345678')).toThrow('different shipment');
  });

  it('uses the environment fetcher the factory hands the tracker', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      overallStatus: { text: { english: 'Recorded' } },
      transportPositions: [{ positionNumber: QUICKPAC_NUMBER, positionEvents: [] }],
    }));
    const global = vi.spyOn(globalThis, 'fetch');

    await expect(new PlanzerTracker({ fetcher }).fetch(QUICKPAC_NUMBER))
      .resolves.toMatchObject({ status: 'pending' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(global).not.toHaveBeenCalled();
  });
});

describe('Planzer 91 parcel numbers', () => {
  // Synthetic: 91, a zero-filled customer number and a serial, in each length senders build.
  const SHAPES = ['91000000000000000001', '910000000000000000001', '9100000000000000000001'];
  const PARCEL = SHAPES[2]!;
  const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const found = () => {
    const payload = fixture('delivered.json') as { transportPositions: Array<{ positionNumber: string }> };
    payload.transportPositions[0]!.positionNumber = PARCEL;
    return jsonResponse(payload);
  };

  it('offers Planzer for 20 to 22 digits from 91, and only those', () => {
    for (const number of SHAPES) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low' });
      expect(detectCarrierMatch(number).candidates, number).toContain('planzer');
    }
    for (const number of ['9100000000000000001', '91000000000000000000001', '9200000000000000000001']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('planzer');
    }
    // The 91346097 block stays Planzer's own.
    expect(detectCarrierMatch('91346097999999999980')).toMatchObject({ carrier: 'planzer', confidence: 'high' });
  });

  it('keeps USPS PICs from 91 as USPS', () => {
    for (const number of ['9101999999999999999989', '9114999999999999999983']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'usps', confidence: 'high', candidates: ['usps'] });
      expect(recognitionCandidates(number, { countryHint: 'CH' }), number).toEqual([]);
    }
  });

  it('asks Planzer first from Switzerland, and elsewhere only once the others have missed the number', () => {
    for (const number of SHAPES) {
      expect(recognitionCandidates(number, { countryHint: 'CH' })[0], number)
        .toMatchObject({ carrier: 'planzer', countryMatch: 'home' });
      for (const countryHint of ['US', 'DE', undefined]) {
        expect(outsideCountryLast(number, 'planzer', { countryHint }), `${number} ${countryHint}`).toBe(true);
      }
    }
    // A shared shipment's number needs its link, so it is never asked.
    expect(recognitionCandidates('9999000000017', { countryHint: 'CH' }).map(({ carrier }) => carrier)).not.toContain('planzer');
  });

  it('recognizes a parcel the API lists, and the API\'s own not-found as unknown', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(found()).mockResolvedValueOnce(planzerNotFound());
    await expect(carrier(fetcher).recognize!(PARCEL)).resolves
      .toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-09-01T14:07:10', finished: true });
    await expect(carrier(fetcher).recognize!(PARCEL)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(`https://api.tracking.app.planzer.ch/api/v1/shipments/${PARCEL}/Pak`);
  });

  it('fails on any other 404, a refusal, a rate limit, a malformed reply or another parcel', async () => {
    const replies: Array<[() => Response, object]> = [
      [() => new Response('<html><body>Not Found</body></html>', { status: 404, headers: { 'Content-Type': 'text/html' } }), { kind: 'indeterminate' }],
      [() => new Response(null, { status: 404 }), { kind: 'indeterminate' }],
      [() => new Response(null, { status: 403 }), { kind: 'challenge' }],
      [() => new Response(null, { status: 429, headers: { 'Retry-After': '120' } }), { kind: 'rate_limited' }],
      [() => new Response('<html>Maintenance</html>', { headers: { 'Content-Type': 'text/html' } }), { message: 'Planzer tracking returned an invalid tracking response' }],
      [() => jsonResponse({ overallStatus: { text: { english: 'Recorded' } }, transportPositions: [{ positionNumber: SHAPES[0], positionEvents: [] }] }), { kind: 'schema' }],
    ];
    for (const [reply, failure] of replies) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply());
      await expect(carrier(fetcher).recognize!(PARCEL), JSON.stringify(failure)).rejects.toMatchObject(failure);
      await expect(carrier(fetcher).track({ number: PARCEL }), JSON.stringify(failure)).rejects.toMatchObject(failure);
    }
  });

  it('fails for a shared shipment\'s number without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('9999000000017')).rejects.toMatchObject({ kind: 'input_required' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('Planzer milestone labels', () => {
  it.each([
    ['Recorded', 'registered'],
    ['Transferred', 'in_transit'],
    ['Shipment on the way', 'in_transit'],
    ['In delivery', 'out_for_delivery'],
    ['Shipment out for delivery', 'out_for_delivery'],
    ['Delivered', 'delivered'],
    ['Shipment delivered', 'delivered'],
    // Planzer's English "Shipped" means delivered, not dispatched.
    ['Shipped', 'delivered'],
    ['Not delivered', 'failed_attempt'],
    ['Not delivered – A delivery card has been deposited', 'failed_attempt'],
    ['New delivery released', 'in_transit'],
    // Generated localization aliases, matched case-insensitively.
    ['Enregistré', 'registered'],
    ['Erfasst', 'registered'],
    ['Registrato', 'registered'],
    ['Transféré', 'in_transit'],
    ['Weitergeleitet', 'in_transit'],
    ['Inoltrato', 'in_transit'],
    ['En cours de livraison', 'out_for_delivery'],
    ['In Zustellung', 'out_for_delivery'],
    ['In consegna', 'out_for_delivery'],
    ['Livré', 'delivered'],
    ['Zugestellt', 'delivered'],
    ['Consegnato', 'delivered'],
  ] as const)('maps %s to %s', (label, stage) => {
    expect(planzerEventStage(label)).toBe(stage);
  });

  it('stores the mistranslated "Shipped" as "Delivered" and keeps other labels verbatim', () => {
    expect(planzerDescription('Shipped')).toBe('Delivered');
    for (const label of ['Recorded', 'Transferred', 'In delivery', 'Delivered', 'Shipment delivered', 'Zugestellt']) {
      expect(planzerDescription(label)).toBe(label);
    }
    expect(parsePlanzerTrackingResponse({
      overallStatus: { text: { english: 'Shipped' } },
      transportPositions: [{
        positionNumber: QUICKPAC_NUMBER,
        positionEvents: [{ createdAt: '2026-09-01T12:00:00', text: { english: 'Shipped' } }],
      }],
    }, QUICKPAC_NUMBER)).toMatchObject({
      status: 'delivered',
      last_status_text: 'Delivered',
      events: [{ description: 'Delivered', stage: 'delivered' }],
    });
  });

  it('refuses to turn an unfamiliar label into history', () => {
    expect(planzerEventStage('New status with private details')).toBeUndefined();
    expect(() => parsePlanzerTrackingResponse({
      overallStatus: { text: { english: 'Shipment delivered' } },
      transportPositions: [{
        positionNumber: QUICKPAC_NUMBER,
        positionEvents: [{ createdAt: '2026-09-01T12:00:00Z', text: { english: 'New status with private details' } }],
      }],
    }, QUICKPAC_NUMBER)).toThrow('Planzer returned an unrecognized tracking event status');
  });
});

describe('Planzer declared capabilities and privacy', () => {
  const delivered = parsePlanzerTrackingResponse(fixture('delivered.json'), QUICKPAC_NUMBER);
  // The same parcel the evening before, still out for delivery.
  const moving = fixture('delivered.json') as {
    overallStatus: { text: { english: string } }; transportPositions: Array<{ positionEvents: unknown[] }>;
  };
  moving.overallStatus.text.english = 'Shipment out for delivery';
  moving.transportPositions[0]!.positionEvents.pop();
  const outForDelivery = parsePlanzerTrackingResponse(moving, QUICKPAC_NUMBER);
  const checks: Record<string, (result: CarrierResult) => boolean> = {
    history: (result) => (result.events?.length ?? 0) > 0,
    location: (result) => (result.events ?? []).some((event) => Boolean(event.location)),
    eta: (result) => Boolean(result.expected_delivery),
    eta_window: (result) => Boolean(result.expected_delivery_from),
    sender_name: (result) => Boolean(result.sender_name),
    pickup_point: (result) => Boolean(result.pickup_point),
    weight: (result) => result.weight_kg != null,
    dimensions: (result) => Boolean(result.dimensions_text),
    delivered_at: (result) => Boolean(result.delivered_at),
    provider_code: (result) => (result.events ?? []).some((event) => Boolean(event.provider_code)),
  };

  it('keeps the four milestones newest first with their own stages', () => {
    expect(delivered).toMatchObject({
      status: 'delivered',
      last_status_text: 'Shipment delivered',
      last_update: '2026-09-01T14:07:10.258',
      // The delivery day is history once delivered.
      expected_delivery: null,
      delivered_at: '2026-09-01T14:07:10.258',
    });
    // The fixture's "Shipped" is Planzer's English for "Zugestellt".
    expect(delivered.events?.map((event) => [event.description, event.stage])).toEqual([
      ['Delivered', 'delivered'],
      ['In delivery', 'out_for_delivery'],
      ['Transferred', 'in_transit'],
      ['Recorded', 'registered'],
    ]);
  });

  it('keeps scans of one instant in the carrier’s order', () => {
    const reply = fixture('delivered.json') as { transportPositions: Array<{ positionEvents: Array<{ createdAt: string }> }> };
    const [recorded, transferred] = reply.transportPositions[0]!.positionEvents;
    transferred!.createdAt = recorded!.createdAt;
    expect(parsePlanzerTrackingResponse(reply, QUICKPAC_NUMBER).events?.map((event) => event.description))
      .toEqual(['Delivered', 'In delivery', 'Transferred', 'Recorded']);
  });

  it('reads the parcel\'s weight, measurements and destination country, and the estimate while it moves', () => {
    expect(delivered).toMatchObject({ weight_kg: 3.6, dimensions_text: '61 × 41 × 18 cm', destination_country: 'CH' });
    expect(outForDelivery).toMatchObject({ status: 'out_for_delivery', expected_delivery: '2026-09-01', weight_kg: 3.6 });
    expect(outForDelivery.delivered_at).toBeUndefined();
  });

  it('adds up the weights of a shipment\'s parcels and gives no single size', () => {
    const shipment = fixture('delivered.json') as { shipmentNumber?: string; transportPositions: Array<Record<string, unknown>> };
    shipment.shipmentNumber = '61000001';
    shipment.transportPositions[1]!.positionNumber = '440000000000000002';
    shipment.transportPositions[1]!.weightGs = 1250;
    shipment.transportPositions[1]!.positionEvents = shipment.transportPositions[0]!.positionEvents;
    const result = parsePlanzerTrackingResponse(shipment, '61000001');
    expect(result).toMatchObject({ weight_kg: 4.85 });
    expect(result.dimensions_text).toBeUndefined();
    delete shipment.transportPositions[1]!.weightGs;
    expect(parsePlanzerTrackingResponse(shipment, '61000001').weight_kg).toBeUndefined();
  });

  it('keeps a country Planzer names without a known code as its name', () => {
    const abroad = fixture('delivered.json') as { deliveryAddress: { country: string } };
    abroad.deliveryAddress.country = 'Atlantis';
    expect(parsePlanzerTrackingResponse(abroad, QUICKPAC_NUMBER)).toMatchObject({ destination_country_name: 'Atlantis' });
  });

  it.each(carrier.capabilities)('declares %s and a fixture proves it', (capability) => {
    const check = checks[capability];
    expect(check, `unknown capability ${capability}`).toBeTypeOf('function');
    expect(check!(delivered) || check!(outForDelivery)).toBe(true);
  });

  it('reads the recipient and who signed, and drops the pickup address, the proof of delivery and another shipment\'s history', () => {
    expect(delivered).toMatchObject({
      receiver_name: 'Made Up Recipient', receiver_address: 'Example Street 1\n9999 Example City', signed_by: 'Made Up Recipient',
    });
    expect(outForDelivery).toMatchObject({ receiver_name: 'Made Up Recipient' });
    expect(outForDelivery).not.toHaveProperty('signed_by');
    const projected = JSON.stringify(delivered);
    for (const value of [
      'Example Town',
      '9998',
      'Made Up Dock',
      'proof-of-delivery',
      'Private event from a different shipment',
    ]) {
      expect(projected).not.toContain(value);
    }
  });

  it('reads the consignee when the delivery address names nobody', () => {
    const payload = fixture('delivered.json') as Record<string, unknown>;
    delete payload.deliveryAddress;
    expect(parsePlanzerTrackingResponse(payload, QUICKPAC_NUMBER))
      .toMatchObject({ receiver_name: 'Made Up Recipient', receiver_address: 'Example Street 1\n8000 Example City' });
  });
});
