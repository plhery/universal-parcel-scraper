import { describe, expect, it } from 'vitest';
import { normalizeCarrierResult } from './index.js';
import { resolveResult, resultStage } from './resolve.js';

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

describe('the import charges', () => {
  it('keeps the charges a carrier lists, without the members that are not valid', () => {
    const import_charges = { currency: 'EUR', customs: 12.34, carrier_fee: 21, carrier_fee_online: 18, paid: true, status_code: 'PAID' };
    expect(normalizeCarrierResult({ import_charges }).import_charges).toEqual(import_charges);
    expect(normalizeCarrierResult({ import_charges: { currency: 'EUR', customs: -1, carrier_fee: '21', paid: 'yes', status_code: '', carrier_fee_online: 18 } })
      .import_charges).toEqual({ currency: 'EUR', carrier_fee_online: 18 });
  });

  it('drops charges without a currency or anything they say', () => {
    for (const import_charges of [null, 'EUR 12.34', { customs: 12.34 }, { currency: 'euro', customs: 12.34 }, { currency: 'EUR' },
      { currency: 'EUR', customs: Number.NaN }]) {
      expect(normalizeCarrierResult({ import_charges })).not.toHaveProperty('import_charges');
    }
  });
});

describe('result completeness flags', () => {
  it('keeps a boolean flag through normalization and resolution', () => {
    const scans = [{ time: '2026-01-02T12:00:00Z', description: 'In transit', stage: 'in_transit' }];
    expect(normalizeCarrierResult({ history_truncated: true, summary_only: false, events: scans }))
      .toMatchObject({ history_truncated: true, summary_only: false });
    expect(resolveResult({ status: 'in_transit', history_truncated: true, events: scans })).toMatchObject({ history_truncated: true });
  });

  it('drops a flag that is not a boolean and keeps the history', () => {
    for (const value of ['true', 1, null, {}]) {
      const result = normalizeCarrierResult({ history_truncated: value, summary_only: value, events: [{ description: 'In transit' }] });
      expect(result).not.toHaveProperty('history_truncated');
      expect(result).not.toHaveProperty('summary_only');
      expect(result.events).toEqual([{ description: 'In transit' }]);
    }
  });
});

describe('a withdrawn estimate', () => {
  it('stands only as true beside no estimate', () => {
    expect(normalizeCarrierResult({ expected_delivery: null, expected_delivery_withdrawn: true, events: [] }))
      .toMatchObject({ expected_delivery_withdrawn: true });
    for (const result of [{ expected_delivery: '2026-01-05', expected_delivery_withdrawn: true }, { expected_delivery_withdrawn: 'true' }]) {
      expect(normalizeCarrierResult({ ...result, events: [] })).not.toHaveProperty('expected_delivery_withdrawn');
    }
  });
});

describe('rows written ahead', () => {
  it('keeps the clocks of the rows a carrier holds back, and drops anything else', () => {
    const written_ahead = ['2026-01-03T09:00:17+08:00', '2026-01-04T10:06:28', '2026-01-05T11:00:00.000Z', '2026-01-06T12:30'];
    expect(normalizeCarrierResult({ written_ahead, events: [] })).toMatchObject({ written_ahead });
    for (const value of [[], ['soon'], ['2026-01-03'], [7], '2026-01-03T09:00:17Z', {}, null]) {
      expect(normalizeCarrierResult({ written_ahead: value, events: [] })).not.toHaveProperty('written_ahead');
    }
  });
});

describe('event places', () => {
  it('drop a blank place and keep a named one', () => {
    const events = normalizeCarrierResult({ status: 'in_transit', events: [
      { time: '2026-01-02T10:00:00Z', description: 'In transport', location: ' ' },
      { time: '2026-01-02T09:00:00Z', description: 'In transport', location: '' },
      { time: '2026-01-02T08:00:00Z', description: 'Posting', location: 'Sampletown' },
    ] }).events!;
    expect(events.map((event) => event.location ?? null)).toEqual([null, null, 'Sampletown']);
    expect(events[0]).not.toHaveProperty('location');
  });

  it('drop the empty parts of a place joined from parts, and a place that has none', () => {
    const places = [',,,', ' , ', 'Sampletown,,,', ',,,CA', ',Sampletown', 'SAMPLE HUB,', 'Sampletown, , Region', 'Sampletown, Region', 'Sample,Town'];
    const events = normalizeCarrierResult({ status: 'in_transit', events: places.map((location) => ({ time: '2026-01-02T10:00:00Z', description: 'In transport', location })) }).events!;
    expect(events.map((event) => event.location ?? null)).toEqual([null, null, 'Sampletown', 'CA', 'Sampletown', 'SAMPLE HUB', 'Sampletown, Region', 'Sampletown, Region', 'Sample,Town']);
  });
});

describe('recipient actions', () => {
  it('flags a scan whose customs wording asks the recipient to act, and keeps a carrier\'s own flag', () => {
    const events = normalizeCarrierResult({ status: 'in_transit', events: [
      { time: '2026-01-03T10:00:00Z', description: 'Necessidade de informar CPF/CNPJ do destinatário' },
      { time: '2026-01-03T09:00:00Z', description: 'Duties or taxes are due — pay online', recipient_action: 'duties' },
      { time: '2026-01-03T08:00:00Z', description: 'Customs clearance', recipient_action: 'sign' },
      { time: '2026-01-03T07:00:00Z', description: 'Awaiting payment' },
    ] }).events!;
    expect(events.map((event) => event.recipient_action ?? null)).toEqual(['tax_id', 'duties', null, null]);
    expect(events[2]).not.toHaveProperty('recipient_action');
  });
});

describe('a summary without a stage', () => {
  const scans = [
    { time: '2026-01-05T10:00:00+01:00', description: 'Synthetic customs step the carrier left unstaged' },
    { time: '2026-01-03T09:00:00+01:00', description: 'Held at customs', stage: 'customs', stage_source: 'carrier_map' },
    { time: '2026-01-02T08:00:00+01:00', description: 'Arrived at the office of exchange', stage: 'in_transit' },
  ];

  it('takes the newest scan that has a stage, whichever way the carrier lists them', () => {
    for (const events of [scans, [...scans].reverse()]) {
      const result = { status: 'unknown', last_status_text: scans[0]!.description, events } as const;
      expect(resultStage(result)).toBe('customs');
      expect(resolveResult(result)).toMatchObject({ status: 'unknown', current_stage: 'customs' });
    }
  });

  it('orders an instant and a wall clock without a zone the same whatever the host\'s zone', () => {
    const zone = process.env.TZ;
    const accepted = { time: '2026-01-02T08:00:00Z', description: 'Accepted', stage: 'accepted' };
    const out = { local_time: '2026-01-02T08:00:00', description: 'Out for delivery', stage: 'out_for_delivery' };
    const older = { local_time: '2026-01-01T09:00:00', description: 'Arrived', stage: 'in_transit' };
    // Written with a space, an hour before `out`: read in New York's zone it would come after it.
    const spaced = { local_time: '2026-01-02 07:00', description: 'Sorted', stage: 'in_transit' };
    const seen: unknown[][] = [];
    const parsed = new Set<number>();
    try {
      for (const host of ['UTC', 'Europe/Zurich', 'America/New_York']) {
        process.env.TZ = host;
        // The host reads an offset-free clock in its own zone.
        parsed.add(Date.parse(out.local_time));
        seen.push([[out, accepted], [accepted, out], [out, older, accepted], [accepted, older, out], [out, spaced, accepted],
          [accepted, spaced, out]].map((events) => resultStage({ status: 'unknown', events })));
      }
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
    expect(parsed.size).toBe(3);
    // Newest first, unless the wall clocks show the answer lists its scans oldest first.
    for (const stages of seen) {
      expect(stages).toEqual(['out_for_delivery', 'accepted', 'out_for_delivery', 'out_for_delivery', 'out_for_delivery', 'out_for_delivery']);
    }
  });

  it('keeps a stage the carrier gave, and borrows no delivery or return the newer scans may have undone', () => {
    expect(resultStage({ status: 'unknown', current_stage: 'in_transit', events: scans })).toBe('in_transit');
    expect(resultStage({ status: 'unknown', events: [scans[0]!] })).toBeNull();
    const delivered = { ...scans[1]!, description: 'Delivered', stage: 'delivered' };
    expect(resultStage({ status: 'unknown', events: [scans[0]!, delivered] })).toBeNull();
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

describe('scans dated alike', () => {
  const at = (time: string, description: string) => ({ time, description });
  const orders = (...events: Array<{ time: string; description: string }>) =>
    normalizeCarrierResult({ events }).events!.map((event) => [event.description, event.tie_order ?? null]);

  it('are numbered from the oldest in the order the answer lists them, newest first or last', () => {
    expect(orders(at('2026-03-04T10:00:00Z', 'Out'), at('2026-03-03T17:52:00Z', 'Departed'), at('2026-03-03T17:52:00.000Z', 'Arrived'),
      at('2026-03-02T08:00:00Z', 'Posted'))).toEqual([['Out', null], ['Departed', 1], ['Arrived', 0], ['Posted', null]]);
    expect(orders(at('2026-03-02T08:00:00Z', 'Posted'), at('2026-03-03T17:52:00Z', 'Arrived'), at('2026-03-03T17:52:00Z', 'Departed'),
      at('2026-03-04T10:00:00Z', 'Out'))).toEqual([['Posted', null], ['Arrived', 0], ['Departed', 1], ['Out', null]]);
    // A wall clock without a zone compares with the answer's other wall clocks.
    expect(orders(at('2026-03-04T10:00:00', 'Out'), at('2026-03-03T17:52:00', 'Departed'), at('2026-03-03T17:52:00', 'Arrived')))
      .toEqual([['Out', null], ['Departed', 1], ['Arrived', 0]]);
    // It never ties with an instant, whatever the host's zone.
    expect(orders(at('2026-03-04T10:00:00Z', 'Out'), at('2026-03-03T17:52:00', 'Departed'), at('2026-03-03T17:52:00Z', 'Arrived')))
      .toEqual([['Out', null], ['Departed', null], ['Arrived', null]]);
  });

  it('are not numbered when the answer does not say which way it lists its scans', () => {
    expect(orders(at('2026-03-03T17:52:00Z', 'Departed'), at('2026-03-03T17:52:00Z', 'Arrived'))).toEqual([['Departed', null], ['Arrived', null]]);
    expect(orders(at('2026-03-02T08:00:00Z', 'A'), at('2026-03-03T17:52:00Z', 'B'), at('2026-03-03T17:52:00Z', 'C'), at('2026-03-01T08:00:00Z', 'D')))
      .toEqual([['A', null], ['B', null], ['C', null], ['D', null]]);
  });

  it('take no number an adapter gave', () => {
    const events = normalizeCarrierResult({ events: [{ time: '2026-03-04T10:00:00Z', tie_order: 3 }, { time: '2026-03-03T10:00:00Z' }] }).events!;
    expect(events.map((event) => event.tie_order ?? null)).toEqual([null, null]);
  });
});

describe('scans the scraper staged', () => {
  it('marks a scan the adapter left without a stage, and only that one, across a second resolution', () => {
    const resolved = resolveResult({ status: 'in_transit', events: [
      { time: '2026-11-03T10:00:00Z', description: 'Delivery was not possible' },
      { time: '2026-11-02T10:00:00Z', description: 'Zzz qqq' },
      { time: '2026-11-01T10:00:00Z', description: 'Delivery was not possible', stage: 'failed_attempt', stage_source: 'wording:en' },
      { time: '2026-10-31T10:00:00Z', description: 'Parcel registered', stage: 'registered', stage_source: 'carrier_map', stage_inferred: true },
    ] });
    expect(resolved.events.map((event) => [event.stage, event.stage_source, event.stage_inferred])).toEqual([
      ['failed_attempt', resolved.events[0]!.stage_source, true],
      ['in_transit', 'none', true],
      ['failed_attempt', 'wording:en', undefined],
      ['registered', 'carrier_map', undefined],
    ]);
    expect(resolved.events[0]!.stage_source).toMatch(/^wording:/);
    expect(resolved.events[2]).not.toHaveProperty('stage_inferred');
    // A lookup resolves a merged answer again: the scraper's guess stays marked, a stage set since does not.
    const again = resolveResult({ ...resolved, events: [...resolved.events, { ...resolved.events[1]!, stage: 'delivered' }] });
    expect(again.events.map((event) => event.stage_inferred)).toEqual([true, true, undefined, undefined, undefined]);
  });
});
