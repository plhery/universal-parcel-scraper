import { describe, expect, it } from 'vitest';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { normalizeWhatsShipNumber, parseWhatsShip } from './parser.js';
import { statusMap, whatsShipStage, whatsShipStatus } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// Entirely synthetic: public samples and live replies stay outside the test fixtures.
const NUMBER = `WS${'1'.repeat(17)}DL`;
const OTHER = `WS${'2'.repeat(17)}DL`;
const scan = (fields: Record<string, unknown> = {}) => ({
  ProcessDate: '2026-01-10T09:00:00', ProcessTimezone: 'UTC+08:00', TrackNodeCode: 'ORDER_CREATION',
  ProcessContent: 'Shipment information received', ProcessCity: '', ProcessProvince: '', ProcessCountry: '', ...fields,
});
const reply = (rows: Record<string, unknown>[] = [scan()]) => ({
  TimeStamp: '2030-01-01T00:00:00Z',
  Item: { OrderNumber: NUMBER, CountryCode: 'US', TrackingNumber: `GF${'3'.repeat(13)}`, WayBillNumber: `YT${'4'.repeat(16)}`,
    PackageNumber: `MGP${'5'.repeat(13)}`, PackageState: '3', TrackingStatus: 50, OrderTrackingDetails: rows },
});

describe('WhatsShip public order-reference parser', () => {
  it('shares a bounded whole-reference validator with the adapter', () => {
    expect(normalizeWhatsShipNumber(`  ${NUMBER.toLowerCase()}  `)).toBe(NUMBER);
    for (const input of ['', NUMBER.slice(1), NUMBER.slice(0, -1), `${NUMBER}${OTHER}`, 'x'.repeat(65), `GF${'1'.repeat(13)}`]) {
      expect(() => normalizeWhatsShipNumber(input)).toThrow(InvalidInputError);
    }
  });

  it('requires the whole order reference, even when a partner field echoes the request', () => {
    for (const order of [OTHER, '', NUMBER.slice(0, -1), `${NUMBER};${OTHER}`, `${NUMBER}${' '.repeat(70)}`]) {
      const data = reply(); data.Item.OrderNumber = order; data.Item.TrackingNumber = NUMBER;
      expect(() => parseWhatsShip(data, NUMBER)).toThrow(SchemaError);
    }
    expect(() => parseWhatsShip({ Item: { TrackingNumber: NUMBER, OrderTrackingDetails: [scan()] } }, NUMBER)).toThrow(SchemaError);
    const normalized = reply(); normalized.Item.OrderNumber = ` ${NUMBER.toLowerCase()} `;
    expect(parseWhatsShip(normalized, NUMBER).events).toHaveLength(1);
  });

  it('recognizes only the exact observed absence envelope', () => {
    expect(() => parseWhatsShip({ error: 'Tracking number not exist!', status: 422 }, NUMBER)).toThrow(NotFoundError);
    for (const data of [
      { error: 'Tracking number not exist!', status: '422' },
      { error: 'Tracking number not exist!', status: 500 },
      { error: 'Tracking number not exist!', status: 422, Item: reply().Item },
      { error: 'Please try again', status: 422 },
      { error: 'Too many requests', status: 429 },
      { error: 'Authentication failed', status: 401 },
      { error: 'Tracking number not exist!' },
    ]) expect(() => parseWhatsShip(data, NUMBER)).toThrow(IndeterminateError);
  });

  it('keeps malformed envelopes and an empty known history separate from absence', () => {
    for (const data of [null, [], {}, { Item: null }, { Item: [] }, { Item: { OrderNumber: NUMBER } },
      { Item: { OrderNumber: NUMBER, OrderTrackingDetails: {} } }, { Item: { OrderNumber: NUMBER, OrderTrackingDetails: [null] } }]) {
      expect(() => parseWhatsShip(data, NUMBER)).toThrow(SchemaError);
    }
    expect(() => parseWhatsShip(reply([]), NUMBER)).toThrowError(expect.objectContaining({
      name: 'NoHistoryError', kind: 'indeterminate', reason: 'listed',
    }));
    expect(() => parseWhatsShip(reply([]), NUMBER)).toThrow(NoHistoryError);
  });

  it('projects dated scans newest first with each scan offset preserved', () => {
    const data = reply([
      scan(),
      scan({ ProcessDate: '2026-01-11T08:15:00', TrackNodeCode: 'FIRST_MILE_ARRIVE', ProcessContent: 'Arrived at origin facility',
        ProcessCity: 'Synthetic Origin', ProcessProvince: 'Synthetic Province' }),
      scan({ ProcessDate: '2026-01-12T09:45:00', ProcessTimezone: 'UTC-07:00', TrackNodeCode: 'DELIVERED',
        ProcessContent: 'Delivered, Door/Yard.', ProcessCity: 'Synthetic Destination', ProcessCountry: 'US' }),
    ]);
    const result = parseWhatsShip(data, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      provider_code: 'DELIVERED', last_status_text: 'Delivered, Door/Yard.', last_update: '2026-01-12T09:45:00-07:00', last_update_local: null,
      delivered_at: '2026-01-12T09:45:00-07:00', destination_country: 'US', expected_delivery: null });
    expect(result.events).toEqual([
      { time: '2026-01-12T09:45:00-07:00', description: 'Delivered, Door/Yard.', provider_code: 'DELIVERED',
        location: 'Synthetic Destination, US', stage: 'delivered', stage_source: 'carrier_map' },
      { time: '2026-01-11T08:15:00+08:00', description: 'Arrived at origin facility', provider_code: 'FIRST_MILE_ARRIVE',
        location: 'Synthetic Origin, Synthetic Province', stage: 'accepted', stage_source: 'carrier_map' },
      { time: '2026-01-10T09:00:00+08:00', description: 'Shipment information received', provider_code: 'ORDER_CREATION',
        stage: 'registered', stage_source: 'carrier_map' },
    ]);
    expect(result.history_truncated).toBeUndefined();
  });

  it('orders cross-border instants rather than their wall-clock digits', () => {
    const result = parseWhatsShip(reply([
      scan({ ProcessDate: '2026-01-10T12:00:00', ProcessTimezone: 'UTC+08:00', ProcessContent: 'Earlier instant' }),
      scan({ ProcessDate: '2026-01-10T10:00:00', ProcessTimezone: 'UTC-07:00', ProcessContent: 'Later instant' }),
    ]), NUMBER);
    expect(result.events!.map(event => event.description)).toEqual(['Later instant', 'Earlier instant']);
  });

  it('sorts shuffled dated rows and removes only duplicate projected events', () => {
    const first = scan({ ProcessDate: '2026-01-10T08:00:00', ProcessContent: 'First milestone' });
    const later = scan({ ProcessDate: '2026-01-12T08:00:00', ProcessContent: 'Newest milestone' });
    const middle = scan({ ProcessDate: '2026-01-11T08:00:00', ProcessContent: 'Middle milestone' });
    const result = parseWhatsShip(reply([middle, later, first, { ...middle, IrrelevantField: 'ignored' }]), NUMBER);
    expect(result.events!.map(event => event.description)).toEqual(['Newest milestone', 'Middle milestone', 'First milestone']);
  });

  it('preserves distinct same-clock scans and the source chronology of their ties', () => {
    const result = parseWhatsShip(reply([
      scan(),
      scan({ ProcessDate: '2026-01-11T09:00:00', ProcessContent: 'First tied milestone' }),
      scan({ ProcessDate: '2026-01-11T09:00:00', ProcessContent: 'Second tied milestone' }),
    ]), NUMBER);
    expect(result.events!.map(event => event.description)).toEqual(['Second tied milestone', 'First tied milestone', 'Shipment information received']);
    const newest = [scan({ ProcessDate: '2026-01-11T09:00:00', ProcessContent: 'Newest tie' }),
      scan({ ProcessDate: '2026-01-11T09:00:00', ProcessContent: 'Older tie' }), scan()];
    expect(parseWhatsShip(reply(newest), NUMBER).events!.map(event => event.description)).toEqual(['Newest tie', 'Older tie', 'Shipment information received']);
  });

  it('leaves clocks without an offset local, with no invented UTC delivery instant', () => {
    const result = parseWhatsShip(reply([
      scan({ ProcessTimezone: null }),
      scan({ ProcessDate: '2026-01-12T09:45:00', ProcessTimezone: '', TrackNodeCode: 'DELIVERED', ProcessContent: 'Delivered, Door/Yard.' }),
    ]), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', last_update: null, last_update_local: '2026-01-12T09:45:00' });
    expect(result.events![0]).toHaveProperty('local_time', '2026-01-12T09:45:00');
    expect(result.events![0]).not.toHaveProperty('time');
    expect(result.delivered_at).toBeUndefined();
  });

  it('reads the step from the wording of a partner feed that names no scan code', () => {
    // The shape relayed for a partner's order: a numeric status, no node code, offset or place parts.
    const raw = (fields: Record<string, unknown>) => ({ ProcessDate: '2026-01-10T01:27:00', ProcessContent: 'Shipment information received',
      TrackingStatus: 10, ProcessLocation: null, ...fields });
    const result = parseWhatsShip(reply([raw({}), raw({ ProcessDate: '2026-01-11T19:10:00', ProcessContent: 'Shipment arrived at sorting center',
      TrackingStatus: 20 })]), NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'wording:language',
      last_status_text: 'Shipment arrived at sorting center', last_update: null, last_update_local: '2026-01-11T19:10:00' });
    expect(result).not.toHaveProperty('provider_code');
    expect(result.events).toEqual([
      { local_time: '2026-01-11T19:10:00', description: 'Shipment arrived at sorting center', stage: 'in_transit', stage_source: 'wording:language' },
      { local_time: '2026-01-10T01:27:00', description: 'Shipment information received', stage: 'registered', stage_source: 'wording:language' },
    ]);
    // A delivery in wording alone stays on the scan's wall clock.
    const delivered = parseWhatsShip(reply([raw({ ProcessContent: 'Delivered' })]), NUMBER);
    expect(delivered).toMatchObject({ status: 'delivered', last_update_local: '2026-01-10T01:27:00' });
    expect(delivered.delivered_at).toBeUndefined();
    expect(parseWhatsShip(reply([raw({ ProcessContent: 'Synthetic unmapped step' })]), NUMBER)).toMatchObject({ status: 'unknown' });
  });

  it('uses comparable source order for a mixed local and explicit-offset feed', () => {
    const result = parseWhatsShip(reply([
      scan(),
      scan({ ProcessDate: '2026-01-11T09:00:00', ProcessTimezone: null, ProcessContent: 'Unresolved local milestone' }),
      scan({ ProcessDate: '2026-01-12T09:00:00', ProcessContent: 'Newest known instant' }),
    ]), NUMBER);
    expect(result.events!.map(event => event.description)).toEqual(['Newest known instant', 'Unresolved local milestone', 'Shipment information received']);
    expect(result.events![1]).toHaveProperty('local_time', '2026-01-11T09:00:00');
    expect(() => parseWhatsShip(reply([scan(), scan({ ProcessTimezone: null })]), NUMBER)).toThrow(IndeterminateError);
  });

  it('accepts agreeing explicit offsets and rejects contradictory row labels', () => {
    expect(parseWhatsShip(reply([scan({ ProcessDate: '2026-01-10T09:00:00+08:00' })]), NUMBER).last_update).toBe('2026-01-10T09:00:00+08:00');
    expect(parseWhatsShip(reply([scan({ ProcessDate: '2026-01-10T09:00:00Z', ProcessTimezone: 'UTC+00:00' })]), NUMBER).last_update).toBe('2026-01-10T09:00:00Z');
    expect(() => parseWhatsShip(reply([scan({ ProcessDate: '2026-01-10T09:00:00-07:00' })]), NUMBER)).toThrow(SchemaError);
  });

  it('rejects malformed dates, clocks, offsets and typed scan fields', () => {
    for (const fields of [
      { ProcessDate: '2026-02-30T09:00:00' }, { ProcessDate: '2026-01-10T24:00:00' }, { ProcessDate: '2026-01-10T09:60:00' },
      { ProcessDate: '2026-01-10' }, { ProcessDate: 'tomorrow' }, { ProcessDate: '' }, { ProcessDate: 123 },
      { ProcessTimezone: 'UTC+14:01' }, { ProcessTimezone: 'UTC+15:00' }, { ProcessTimezone: 'UTC+08:60' },
      { ProcessTimezone: 'America/Los_Angeles' }, { ProcessTimezone: 8 }, { ProcessDate: '2026-01-10T09:00:00+99:00' },
      { TrackNodeCode: '' }, { TrackNodeCode: 10 }, { ProcessContent: '' }, { ProcessContent: 'x'.repeat(2_001) },
      { ProcessCity: { name: 'invalid' } },
    ]) expect(() => parseWhatsShip(reply([scan(fields)]), NUMBER)).toThrow(SchemaError);
  });

  it('uses the local-carrier handoff as transit and requires explicit delivery-round wording', () => {
    const handoff = parseWhatsShip(reply([scan({ TrackNodeCode: 'TRANSITHUB_ARRIVE', ProcessContent: 'Delivered to local carrier' })]), NUMBER);
    expect(handoff).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    expect(handoff.delivered_at).toBeUndefined();
    expect(whatsShipStatus('DELIVERY_ATTEMPT', 'Out for Delivery')).toEqual({ status: 'out_for_delivery', stage: 'out_for_delivery' });
    expect(whatsShipStatus('DELIVERY_ATTEMPT', 'Delivery attempt failed, recipient unavailable')).toEqual({ status: 'exception', stage: 'failed_attempt' });
    expect(whatsShipStatus('DELIVERY_ATTEMPT', 'Delivery attempt')).toBeUndefined();
    expect(whatsShipStatus('DELIVERY_ATTEMPT', 'Delivery attempt scheduled')).toBeUndefined();
    expect(whatsShipStatus('DELIVERED', 'Delivered to local carrier')).toBeUndefined();
    expect(whatsShipStatus('DELIVERED', 'Not delivered')).toBeUndefined();
  });

  it('does not inherit an older delivery or a summary code for an unknown newest scan', () => {
    const result = parseWhatsShip(reply([
      scan({ TrackNodeCode: 'DELIVERED', ProcessContent: 'Delivered, Door/Yard.' }),
      scan({ ProcessDate: '2026-01-11T09:00:00', TrackNodeCode: 'UNSEEN_CODE', ProcessContent: 'Synthetic unclassified milestone' }),
    ]), NUMBER);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic unclassified milestone', last_update: '2026-01-11T09:00:00+08:00' });
    expect(result.current_stage).toBeUndefined();
    expect(result.events![0]!.stage).toBeUndefined();
    expect(result.delivered_at).toBeUndefined();
    expect(result.events![1]!.stage).toBe('delivered');
  });

  it('never treats the envelope timestamp as a scan clock or estimate', () => {
    const data = reply();
    const result = parseWhatsShip(data, NUMBER);
    expect(result.last_update).toBe('2026-01-10T09:00:00+08:00');
    expect(result.expected_delivery).toBeNull();
    expect(JSON.stringify(result)).not.toContain(data.TimeStamp);
    expect(() => parseWhatsShip(reply([scan({ ProcessDate: undefined })]), NUMBER)).toThrow(SchemaError);
  });

  it('projects no proof URLs, contacts, parties, aliases or partner routing', () => {
    const data = reply([scan({ TrackNodeCode: 'DELIVERED', ProcessContent: 'Delivered, Door/Yard. For Delivery Issues & Tracking Support, Contact GOFO at +1 555 010-1234 or help@example.invalid',
      POD: 'https://example.invalid/private-proof', RecipientName: 'Synthetic Recipient', ProcessLocation: 'Private street address' })]);
    Object.assign(data.Item, { POD: 'https://example.invalid/proof', PODs: ['https://example.invalid/proof-two'],
      ProviderName: 'GOFO Express', ProviderTelephone: '+1 555 010-1234', SenderName: 'Synthetic Sender', ReceiverName: 'Synthetic Recipient',
      ReceiverAddress: 'Private street address', CreatedBy: 'private-account', ProviderSite: 'https://example.invalid/partner' });
    const result = parseWhatsShip(data, NUMBER);
    expect(result.last_status_text).toBe('Delivered, Door/Yard.');
    expect(result.events![0]!.description).toBe('Delivered, Door/Yard.');
    const serialized = JSON.stringify(result);
    for (const privateText of ['example.invalid', '555', 'Synthetic Recipient', 'Synthetic Sender', 'Private street', 'private-account',
      data.Item.TrackingNumber, data.Item.WayBillNumber, data.Item.PackageNumber, NUMBER]) expect(serialized).not.toContain(privateText);
    for (const field of ['delivery_carrier', 'delivery_tracking_number', 'canonical_tracking_number', 'international_tracking_number',
      'signed_by', 'receiver_name', 'receiver_address', 'sender_name']) expect(result).not.toHaveProperty(field);
  });

  it('retains the newest hundred unique events and declares truncation', () => {
    const rows = Array.from({ length: 101 }, (_, index) => scan({ ProcessDate: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString().slice(0, 19),
      ProcessContent: `Synthetic scan ${index}` }));
    const result = parseWhatsShip(reply(rows), NUMBER);
    expect(result.events).toHaveLength(100);
    expect(result.events![0]!.description).toBe('Synthetic scan 100');
    expect(result.events!.at(-1)!.description).toBe('Synthetic scan 1');
    expect(result.history_truncated).toBe(true);
    expect(parseWhatsShip(reply([...rows.slice(0, 100), rows[0]!]), NUMBER).history_truncated).toBeUndefined();
    expect(() => parseWhatsShip(reply(Array.from({ length: 501 }, () => scan())), NUMBER)).toThrow(SchemaError);
  });

  it('maps all catalogued public wording by the same conservative status function', () => {
    for (const entry of statuses.entries) {
      expect(whatsShipStage(entry.code, entry.wording)).toBe(entry.stage);
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase())).toBe(entry.stage);
    }
    expect(statusMap.stage('UNSEEN_CODE', 'Delivered')).toBeUndefined();
    expect(statusMap.stage(null, 'Delivered')).toBeUndefined();
  });
});
