import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierAdapter, carrierDefinition } from '../../core/catalog/index.js';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { createTracker, TrackingError } from '../../facade/index.js';

const number = 'OMGO0000000000001';
const history: unknown = JSON.parse(readFileSync(new URL('./fixtures/in-transit.json', import.meta.url), 'utf8'));

describe('OMGO catalog and tracking', () => {
  it('recognizes the shipment without probing Colis Privé or selecting a delivery partner', () => {
    expect(detectCarrierMatch('omgo 0000000050001')).toMatchObject({
      carrier: 'omgo', confidence: 'high', candidates: ['omgo'],
    });
    expect(parseTrackingInput(`Tracking number: ${number}`)).toMatchObject({
      carrier: 'omgo', trackingNumber: number, confidence: 'high', source: 'text',
    });
    expect(parseTrackingInput(`https://example.com/parcel/${number}`)).toMatchObject({
      carrier: 'omgo', trackingNumber: number, confidence: 'high', source: 'link',
    });
    expect(carrierIdFromName('Omgo')).toBe('omgo');
  });

  it.each(['OMGO000000000001', 'OMGO00000000000001', 'OMGA0000000000001'])(
    'does not claim unsupported number %s', (value) => {
      expect(detectCarrierMatch(value).candidates).not.toContain('omgo');
    },
  );

  it('does not extract a supported substring from a longer identifier', () => {
    expect(parseTrackingInput(`Parcel reference: X${number}`).carrier).not.toBe('omgo');
  });

  it('tracks through an enabled provider while preserving the detected carrier and clocks', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(history), {
      headers: { 'Content-Type': 'application/json' },
    }));
    const answer = await createTracker({ providers: ['ParcelsApp'], fetcher }).track({ number });
    expect(answer).toMatchObject({
      carrier: 'omgo', source: 'ParcelsApp', attempts: [{ source: 'ParcelsApp', kind: 'ok' }],
      result: { status: 'in_transit', current_stage: 'in_transit', discovered_carrier: 'omgo' },
    });
    expect(answer.result.events.map(event => event.time)).toEqual([
      '2026-01-04T12:00:00.000Z', '2026-01-03T09:00:00.000Z', '2026-01-02T08:00:00.000Z',
    ]);
    expect(JSON.stringify(answer)).not.toContain('Example Sender');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]![0])).toBe('https://parcelsapp.com/api/v2/parcels');
  });

  it('keeps providers opt-in and advertises no direct adapter or assumed scan timezone', async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(carrierAdapter('omgo')).toBe('universal');
    expect(carrierDefinition('omgo').timezone).toBe('UTC');
    await expect(createTracker({ fetcher }).track({ number })).rejects.toBeInstanceOf(TrackingError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
