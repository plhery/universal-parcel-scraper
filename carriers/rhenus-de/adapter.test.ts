import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, rhenusDeOrderUrl, rhenusDeTrackingUrl } from './adapter.js';
import { normalizeRhenusDeNumber, normalizeRhenusDePostcode, parseRhenusDe, readRhenusDeOrder } from './parser.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample's order, its contact data replaced, with its steps, and the answer for an
// invented number.
const SAMPLE = '465294362';
const POSTCODE = '47807';
const ORDER_ID = '00000000-0000-4000-8000-000000000001';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const json = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
/** The sample's order with these fields changed. */
const order = (fields: Record<string, unknown>) => {
  const reply = JSON.parse(fixture('order.json')) as { order: Record<string, unknown> };
  return JSON.stringify({ ...reply, order: { ...reply.order, ...fields } });
};
const steps = (...items: unknown[]) => JSON.stringify(items);
/** A fetcher answering the lookup and then the steps. */
const replies = (lookup: Response, tracking: Response = json(fixture('tracking-status.json'))) =>
  vi.fn<typeof fetch>().mockResolvedValueOnce(lookup).mockResolvedValueOnce(tracking);

describe('Rhenus Germany inputs', () => {
  it('takes the order number in letters and digits and the five-digit postcode', () => {
    expect(normalizeRhenusDeNumber(` ${SAMPLE} `)).toBe(SAMPLE);
    expect(normalizeRhenusDeNumber('des-10401647')).toBe('DES10401647');
    for (const other of ['', '123', 'ÄÖÜ12345', '9'.repeat(41)]) {
      expect(() => normalizeRhenusDeNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    expect(normalizeRhenusDePostcode(' 47807 ')).toBe(POSTCODE);
    for (const missing of [undefined, null, '', '  ']) {
      expect(() => normalizeRhenusDePostcode(missing)).toThrow(expect.objectContaining({ kind: 'input_required', field: 'postcode' }));
    }
    for (const other of ['4780', '478070', 'D-47807', 'SW1A 1AA']) {
      expect(() => normalizeRhenusDePostcode(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('Rhenus Germany tracking adapter', () => {
  it('looks the order up by its number and postcode, then reads its steps', async () => {
    const fetcher = replies(json(fixture('order.json')));
    const result = await carrier(fetcher).track({ number: SAMPLE, postcode: POSTCODE });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `https://rhemate.com/order-manager/booking/api/SelfScheduling/Order/OrderNumber/${SAMPLE}/PostalCode/${POSTCODE}`,
      `https://rhemate.com/order-manager/booking/api/SelfScheduling/order-tracking-status/${ORDER_ID}`,
    ]);
    expect(rhenusDeOrderUrl(SAMPLE, POSTCODE)).toBe(String(fetcher.mock.calls[0]![0]));
    expect(rhenusDeTrackingUrl(ORDER_ID)).toBe(String(fetcher.mock.calls[1]![0]));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Auftrag zugestellt' });
  });

  it('asks nothing without the postcode, so other sources answer', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: SAMPLE })).rejects.toMatchObject({ kind: 'input_required', field: 'postcode' });
    await expect(carrier(fetcher).track({ number: '12', postcode: POSTCODE })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads the answer without an order as inconclusive, since a wrong postcode gets it too', async () => {
    const fetcher = replies(json(fixture('not-found.json')));
    await expect(carrier(fetcher).track({ number: '999999999', postcode: '10115' }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps refusals, outages, redirects and changed replies apart from a missing order, without the postcode', async () => {
    const cases: [Response, string][] = [
      [new Response('', { status: 403 }), 'challenge'],
      [new Response('', { status: 302, headers: { Location: 'https://www.rhenusmydelivery.com/' } }), 'transport'],
      [new Response('<html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }), 'schema'],
      [json('{"isOk":true}'), 'schema'],
      [json('{"isOk":false,"order":{}}'), 'schema'],
      [json('not json'), 'schema'],
    ];
    for (const [response, kind] of cases) {
      await expect(carrier(replies(response)).track({ number: SAMPLE, postcode: POSTCODE }), kind).rejects.toMatchObject({ kind });
    }
    const limited = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429 }));
    const failure = await carrier(limited).track({ number: SAMPLE, postcode: POSTCODE }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind: 'rate_limited' });
    expect(JSON.stringify(failure)).not.toContain(POSTCODE);
  });

  it('refuses an order for another number', async () => {
    await expect(carrier(replies(json(order({ orderNumber: '465294363' })))).track({ number: SAMPLE, postcode: POSTCODE }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('sends a read that fails to reach the service once more', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(json(fixture('order.json')))
      .mockResolvedValueOnce(json(fixture('tracking-status.json')));
    await expect(carrier(fetcher).track({ number: SAMPLE, postcode: POSTCODE })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

describe('Rhenus Germany replies', () => {
  const sample = () => readRhenusDeOrder(fixture('order.json'), SAMPLE);

  it('reads the public sample: its steps with their offsets, newest first, and never its contact data', () => {
    const result = parseRhenusDe(sample(), fixture('tracking-status.json'));
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', provider_code: 'Fulfilled',
      last_status_text: 'Auftrag zugestellt', last_update: '2026-06-19T09:03:43+00:00', delivered_at: '2026-06-19T09:03:43+00:00',
      expected_delivery: null,
    });
    expect(result.events).toEqual([
      { time: '2026-06-19T09:03:43+00:00', description: 'Auftrag zugestellt', provider_code: 'delivered', stage: 'delivered', stage_source: 'carrier_map' },
      { time: '2026-06-18T05:33:45+00:00', description: 'Auftrag unterwegs', provider_code: 'inDelivery', stage: 'out_for_delivery', stage_source: 'carrier_map' },
      { time: '2026-06-18T05:33:45+00:00', description: 'Ware im Depot', provider_code: 'goodsReceived', stage: 'accepted', stage_source: 'carrier_map' },
      { time: '2026-06-11T09:01:26+00:00', description: 'Auftrag erfasst', provider_code: 'created', stage: 'registered', stage_source: 'carrier_map' },
    ]);
    const text = JSON.stringify(result);
    for (const personal of ['Mustermann', 'Musterstraße', '+49000000000', 'example.com', 'Krefeld', ORDER_ID]) expect(text).not.toContain(personal);
  });

  it('gives the delivery window while the order is on its way, and leaves steps still ahead out', () => {
    const open = readRhenusDeOrder(order({ currentStatus: 'OnWayToCustomer' }), SAMPLE);
    const result = parseRhenusDe(open, steps(
      { title: 'created', status: 'Success', date: '2026-06-11T09:01:26+00:00' },
      { title: 'goodsReceived', status: 'Success', date: '2026-06-18T05:33:45+00:00' },
      { title: 'inDelivery', status: 'Success', date: '2026-06-18T05:33:45+00:00' },
      { title: 'delivered', status: 'Pending', date: null },
    ));
    expect(result).toMatchObject({ status: 'out_for_delivery', last_status_text: 'Auftrag unterwegs',
      expected_delivery_from: '2026-06-18T07:00:00+02:00', expected_delivery: '2026-06-18T21:00:00+02:00' });
    expect(result.delivered_at).toBeUndefined();
    expect(result.events?.map((event) => event.provider_code)).toEqual(['inDelivery', 'goodsReceived', 'created']);
  });

  it('keeps a step it does not know with its code, and an order without steps as a summary', () => {
    const open = readRhenusDeOrder(order({ currentStatus: 'OrderCreated' }), SAMPLE);
    const unknown = parseRhenusDe(open, steps({ title: 'rescheduled', status: 'Success', date: '2026-06-12T08:00:00+00:00' }));
    expect(unknown).toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: 'Auftrag erfasst' });
    expect(unknown.events).toEqual([{ time: '2026-06-12T08:00:00+00:00', description: 'rescheduled', provider_code: 'rescheduled' }]);
    expect(parseRhenusDe(open, '[]')).toMatchObject({ current_stage: 'registered', summary_only: true, events: [] });
  });

  it('refuses changed replies', () => {
    for (const body of ['{}', '[{"title":"created"}]', '[{"title":"created","status":"Success","date":"11.06.2026"}]']) {
      expect(() => parseRhenusDe(sample(), body), body).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => readRhenusDeOrder(order({ internalOrderId: 'x' }), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => readRhenusDeOrder(order({ currentStatus: '' }), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('answers each code statuses.json records by its stage', () => {
    for (const { code, wording, stage } of statuses.entries) {
      expect(statusMapAnswer({ carrier: 'rhenus-de', providerCode: code, description: wording }), code).toEqual({ kind: 'mapped', stage });
    }
  });
});
