import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { normalizeWaybill, parseTracking } from './parser.js';

const delivered = readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8');
const waybill = { prefix: '514', serial: '09707762' };
const tracker = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

type Reply = { shipment_summary: Record<string, unknown>; shipment_history: { event_type: string; pieces: number }[] };
function edited(edit: (reply: Reply) => void): string {
  const reply = JSON.parse(delivered) as Reply;
  edit(reply);
  return JSON.stringify(reply);
}

it('asks the group airline API for the waybill and reads its history newest first with station offsets', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(delivered));
  const result = await tracker(fetcher).track({ number: '514-0970 7762' });

  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, request] = fetcher.mock.calls[0]!;
  expect(String(url)).toBe('https://airarabia-api.ibsplc.aero/icargo-api/g9/enterprise/v1/trackings/awbs/514-09707762');
  expect(new Headers(request?.headers).get('x-api-key')).toMatch(/^\w{40}$/);
  expect(result).toMatchObject({
    status: 'delivered', current_stage: 'delivered', last_status_text: 'Shipment delivered', last_update: '2024-02-12T14:53:00+04:00',
  });
  expect(result.events?.at(-1)).toMatchObject({
    provider_code: 'BKD', description: 'Shipment booked for G90553', location: 'SKT', time: '2024-02-09T09:55:17+05:00', stage: 'registered',
  });
});

it('drops repeated records and bookings saved again unchanged', () => {
  const { events = [] } = parseTracking(delivered, 200, waybill);
  expect(events.map(event => event.provider_code)).toEqual(
    ['DLV', 'NFD', 'RCF', 'ARR', 'DEP', 'MAN', 'PRE', 'RCS', 'FOH', 'CPT', 'BKD'],
  );
  expect(events.slice(0, 5)).toEqual([
    expect.objectContaining({ description: 'Shipment delivered', location: 'SHJ', stage: 'delivered' }),
    expect.objectContaining({ description: 'Customer notified', time: '2024-02-10T00:39:00+04:00', stage: 'ready_for_pickup' }),
    expect.objectContaining({ description: 'Breakdown from G90553', stage: 'in_transit' }),
    expect.objectContaining({ description: 'Shipment arrived on G90553', location: 'SHJ' }),
    expect.objectContaining({ description: 'Shipment departed on G90553', location: 'SKT', time: '2024-02-09T19:40:20+05:00' }),
  ]);
  expect(events.find(event => event.provider_code === 'MAN')).not.toHaveProperty('stage');
});

it('keeps a delivery of fewer pieces than stated in transit', () => {
  const partial = edited(reply => {
    for (const row of reply.shipment_history) if (row.event_type === 'DLV') row.pieces = 40;
  });
  expect(parseTracking(partial, 200, waybill)).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Shipment delivered' });
});

it('keeps the stage before a booking made after the goods moved', () => {
  const rebooked = edited(reply => {
    reply.shipment_history = reply.shipment_history.filter(row => !['RCF', 'NFD', 'DLV'].includes(row.event_type));
    reply.shipment_history.push({
      event_type: 'BKD', airport_code: 'SHJ', transaction_date: '2024-02-10T08:00:00+04:00', pieces: 42,
      flight_details: { flight_number: 'G90111' },
    } as never);
  });
  const result = parseTracking(rebooked, 200, waybill);
  expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Shipment booked for G90111' });
  expect(result.events?.[0]).not.toHaveProperty('stage');
});

it('answers an unknown waybill as not found and another waybill as indeterminate', async () => {
  const unknown = JSON.stringify([{ error_code: 'ICO_TRK_001 ', error_description: 'AWB Not found' }]);
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(unknown, { status: 400 }));
  await expect(tracker(fetcher).track({ number: '452-99999992' })).rejects.toMatchObject({ kind: 'not_found' });
  expect(String(fetcher.mock.calls[0]![0])).toContain('/3o/enterprise/v1/trackings/awbs/452-99999992');
  expect(() => parseTracking(delivered, 200, { prefix: '514', serial: '12345675' })).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});

it('reports a refused request and a malformed reply as such, not as a missing shipment', async () => {
  const refused = JSON.stringify([{ error_code: 'ICO_TRK_009', error_description: 'Invalid request' }]);
  expect(() => parseTracking(refused, 400, waybill)).toThrow(expect.objectContaining({ kind: 'schema' }));
  expect(() => parseTracking('<html>Error</html>', 200, waybill)).toThrow(expect.objectContaining({ kind: 'schema' }));
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"message":"Forbidden"}', { status: 403 }));
  await expect(tracker(fetcher).track({ number: '514-09707762' })).rejects.not.toMatchObject({ kind: 'not_found' });
});

it('accepts a group airline waybill or an Air Arabia serial when the check digit holds', () => {
  expect(normalizeWaybill('514 0970 7762')).toEqual(waybill);
  expect(normalizeWaybill('09707762')).toEqual(waybill);
  expect(normalizeWaybill('772-99999992')).toEqual({ prefix: '772', serial: '99999992' });
  expect(() => normalizeWaybill('514-09707763')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  expect(() => normalizeWaybill('253-99999992')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
});
