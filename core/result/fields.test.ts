import { describe, expect, it } from 'vitest';
import { normalizeCarrierResult } from './index.js';

// Synthetic identifiers; the PIC check digits are calculated independently.
const PIC = '9210090000000012345679';
const PIC26 = '92000000000123456789012344';
const NUMBER_FIELDS = ['delivery_tracking_number', 'canonical_tracking_number', 'international_tracking_number'] as const;

describe('reported tracking numbers', () => {
  it('keep only the package identifier of a USPS routing barcode', () => {
    expect(normalizeCarrierResult({
      delivery_carrier: 'usps',
      delivery_tracking_number: `42000000${PIC}`,
      canonical_tracking_number: `420 00000 0000 ${PIC}`,
      international_tracking_number: `42000000${PIC26}`,
    })).toMatchObject({ delivery_carrier: 'usps', delivery_tracking_number: PIC, canonical_tracking_number: PIC,
      international_tracking_number: PIC26 });
    // A ZIP+4 before a 26-digit PIC, and a split whose other reading lacks the Mailer ID its channel needs.
    expect(normalizeCarrierResult({ delivery_tracking_number: `420000000000${PIC26}`, canonical_tracking_number: `420000009201${PIC}` }))
      .toMatchObject({ delivery_tracking_number: PIC26, canonical_tracking_number: PIC });
  });

  it('drop a routing barcode whose package identifier cannot be split off cleanly', () => {
    // Two readings with conforming Mailer IDs and passing check digits, then a wrong check digit.
    for (const number of [`420000009300${PIC}`, `42000000${PIC.slice(0, -1)}0`, `420000000000${PIC26.slice(0, -1)}5`]) {
      const result = normalizeCarrierResult(Object.fromEntries([['delivery_carrier', 'usps'], ...NUMBER_FIELDS.map((field) => [field, number])]));
      expect(result.delivery_carrier, number).toBe('usps');
      for (const field of NUMBER_FIELDS) expect(result[field], `${field} ${number}`).toBeUndefined();
    }
  });

  it('leave every other number as reported', () => {
    for (const number of [PIC, PIC26, 'ZZ000000005GB', '420000000000000001']) {
      const result = normalizeCarrierResult(Object.fromEntries(NUMBER_FIELDS.map((field) => [field, number])));
      for (const field of NUMBER_FIELDS) expect(result[field]).toBe(number);
    }
  });
});

describe('the shipping service', () => {
  it('keeps the name a carrier gives its service', () => {
    expect(normalizeCarrierResult({ service_name: 'Example Express Saver' }).service_name).toBe('Example Express Saver');
  });

  it('drops a service name that is empty, too long or not text', () => {
    for (const service_name of ['', '   ', 'x'.repeat(81), 7, null, { name: 'Example Ground' }]) {
      expect(normalizeCarrierResult({ service_name })).not.toHaveProperty('service_name');
    }
  });
});

describe('the pickup point of a delivered parcel', () => {
  const POINT = 'Example Parcel Shop\nExample Street 1\n1000 Example Town';
  const scan = (stage: string | undefined, time: string) => ({ time, description: `Synthetic ${stage ?? 'scan'}`, ...(stage ? { stage } : {}) });
  const delivered = (...events: ReturnType<typeof scan>[]) => normalizeCarrierResult({
    status: 'delivered', current_stage: 'delivered', pickup_point: POINT, events });

  it('is dropped after a door delivery the parcel went out for after waiting there', () => {
    const result = delivered(scan('delivered', '2026-03-04T15:00:00+01:00'), scan('out_for_delivery', '2026-03-04T08:00:00+01:00'),
      scan('ready_for_pickup', '2026-03-02T10:00:00+01:00'), scan('in_transit', '2026-03-01T10:00:00+01:00'));
    expect(result).not.toHaveProperty('pickup_point');
    // A notice or a problem report between moves nothing; neither does a second delivery scan.
    expect(delivered(scan('delivered', '2026-03-04T15:05:00+01:00'), scan('delivered', '2026-03-04T15:00:00+01:00'),
      scan('pending', '2026-03-04T12:00:00+01:00'), scan('exception', '2026-03-04T11:00:00+01:00'),
      scan('out_for_delivery', '2026-03-04T08:00:00+01:00'), scan('ready_for_pickup', '2026-03-02T10:00:00+01:00')))
      .not.toHaveProperty('pickup_point');
    // A status alone, without a current stage, still says delivered.
    expect(normalizeCarrierResult({ status: 'delivered', pickup_point: POINT,
      events: [scan('delivered', '2026-03-04T15:00:00+01:00'), scan('out_for_delivery', '2026-03-04T08:00:00+01:00')] }))
      .not.toHaveProperty('pickup_point');
  });

  it('reads scans oldest first by their instants', () => {
    expect(delivered(scan('ready_for_pickup', '2026-03-02T10:00:00+01:00'), scan('out_for_delivery', '2026-03-04T08:00:00+01:00'),
      scan('delivered', '2026-03-04T15:00:00+01:00'))).not.toHaveProperty('pickup_point');
    expect(delivered(scan('out_for_delivery', '2026-03-02T08:00:00+01:00'), scan('ready_for_pickup', '2026-03-02T10:00:00+01:00'),
      scan('delivered', '2026-03-04T15:00:00+01:00')).pickup_point).toBe(POINT);
  });

  it('stays where the parcel was collected', () => {
    expect(delivered(scan('delivered', '2026-03-04T15:00:00+01:00'), scan('pending', '2026-03-03T09:00:00+01:00'),
      scan('ready_for_pickup', '2026-03-02T10:00:00+01:00'), scan('out_for_delivery', '2026-03-02T08:00:00+01:00')).pickup_point).toBe(POINT);
    // A point-delivery service whose collection follows a transit scan.
    expect(delivered(scan('delivered', '2026-03-04T15:00:00+01:00'), scan('in_transit', '2026-03-02T10:00:00+01:00')).pickup_point).toBe(POINT);
  });

  it('stays as the carrier gave it when the scans prove no door delivery', () => {
    // Nothing moved, or no scan is known.
    expect(delivered(scan('delivered', '2026-03-04T15:00:00+01:00'), scan('registered', '2026-03-01T10:00:00+01:00')).pickup_point).toBe(POINT);
    expect(delivered().pickup_point).toBe(POINT);
    // A scan without a stage may have been the arrival at the point.
    expect(delivered(scan('delivered', '2026-03-04T15:00:00+01:00'), scan(undefined, '2026-03-04T12:00:00+01:00'),
      scan('out_for_delivery', '2026-03-04T08:00:00+01:00')).pickup_point).toBe(POINT);
    // Local clocks keep the order given; a movement listed before the delivery leaves it in doubt.
    expect(delivered(scan('out_for_delivery', '2026-03-04T08:00:00'), scan('delivered', '2026-03-04T15:00:00')).pickup_point).toBe(POINT);
    expect(delivered(scan('delivered', '2026-03-04T15:00:00'), scan('out_for_delivery', '2026-03-04T08:00:00'))).not.toHaveProperty('pickup_point');
    // A parcel not yet delivered keeps it.
    expect(normalizeCarrierResult({ status: 'out_for_delivery', current_stage: 'out_for_delivery', pickup_point: POINT,
      events: [scan('out_for_delivery', '2026-03-04T08:00:00+01:00'), scan('ready_for_pickup', '2026-03-02T10:00:00+01:00')] }).pickup_point).toBe(POINT);
  });
});
