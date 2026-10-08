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
  });

  it('drop a routing barcode whose package identifier cannot be split off cleanly', () => {
    // An ambiguous ZIP/PIC split, a wrong check digit, and a ZIP+4 before a 26-digit PIC.
    for (const number of [`420000009201${PIC}`, `42000000${PIC.slice(0, -1)}0`, `420000000000${PIC26}`]) {
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
