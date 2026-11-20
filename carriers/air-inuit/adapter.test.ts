import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, AIR_INUIT_ORIGIN, airInuitWaybill, parseAirInuit } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };
import sample from './fixtures/awb-13472675.json' with { type: 'json' };
import blank from './fixtures/not-found.json' with { type: 'json' };

type Reply = typeof sample;
type Line = Reply['data']['CommoditiesByNatureOfGoods'][number]['HistoriqueNew'][number];

const copy = (): Reply => structuredClone(sample);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const SAMPLE = airInuitWaybill('466-YKL-13472675');

/** The sample with its goods' history replaced by these lines. */
function withLines(lines: Line[], edit: (reply: Reply) => void = () => {}): Reply {
  const reply = copy();
  reply.data.CommoditiesByNatureOfGoods[0]!.HistoriqueNew = lines;
  edit(reply);
  return reply;
}
const lines = () => copy().data.CommoditiesByNatureOfGoods[0]!.HistoriqueNew;

describe('Air Inuit adapter', () => {
  it('asks cargo.php for the serial, however the waybill is written', async () => {
    for (const number of ['13472675', '466-13472675', '466 YKL 13472675', '466-ykl-13472675', '46613472675', ' 466YKL13472675 ']) {
      const fetcher = vi.fn<typeof fetch>(async () => json(sample));
      const result = await carrier(fetcher).track({ number });
      expect(result.events, number).toHaveLength(5);
      const [url, init] = fetcher.mock.calls[0]!;
      expect(String(url)).toBe(`${AIR_INUIT_ORIGIN}cargo.php?id=13472675&lang=2`);
      expect(init).toMatchObject({ headers: {
        Accept: 'application/json', Referer: `${AIR_INUIT_ORIGIN}en/cargo/follow-up/shipment-tracking/your-shipment`,
      } });
      expect(new Headers(init?.headers).get('user-agent')).toBeTruthy();
    }
  });

  it('refuses what is not an Air Inuit waybill before asking', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['014-12345675', '01412345675', '1347267', '134726751', '466-YK-13472675', '466-YKL1-3472675', 'ABCDEFGH', '']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps a missing waybill, a challenge and a refusal apart', async () => {
    await expect(carrier(async () => json(blank)).track({ number: '00000000' })).rejects.toMatchObject({ kind: 'not_found' });
    const challenge = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><div id="cf-chl-widget"></div></body></html>';
    await expect(carrier(async () => new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/html' } })).track({ number: '00000000' }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(async () => new Response(challenge, { status: 403 })).track({ number: '00000000' }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(async () => new Response('', { status: 429 })).track({ number: '00000000' }))
      .rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(carrier(async () => new Response('<html>maintenance</html>', { status: 200 })).track({ number: '00000000' }))
      .rejects.toThrow(/invalid tracking response/);
  });

  it('stops when the lookup is cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: '13472675' }, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('answers the facade for the public sample, which detection leaves to the reader', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(sample));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: '466-YKL-13472675', carrier: 'air-inuit' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'air-inuit', source: 'air-inuit', result: { status: 'delivered', current_stage: 'delivered' } });
    for (const { number } of numbers.records) expect(detectCarrierMatch(number).carrier, number).not.toBe('air-inuit');
  });
});

describe('Air Inuit reply', () => {
  it('reads the public sample: accepted, manifested, flown, received and picked up', () => {
    const result = parseAirInuit(sample, SAMPLE);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Picked up.', last_update: '2017-05-29T08:12:00-04:00', last_update_local: '2017-05-29T08:12:00',
      expected_delivery: null });
    expect(result.events).toEqual([
      { time: '2017-05-29T08:12:00-04:00', local_time: '2017-05-29T08:12:00', time_zone: 'America/Toronto', time_zone_basis: 'carrier',
        description: 'Picked up.', provider_code: '4', stage: 'delivered', stage_source: 'carrier_map' },
      { time: '2017-05-26T06:49:54-04:00', local_time: '2017-05-26T06:49:54', time_zone: 'America/Toronto', time_zone_basis: 'carrier',
        description: 'Received in Montréal Dorval (YUL).', location: 'Montréal Dorval (YUL)', provider_code: '1',
        stage: 'ready_for_pickup', stage_source: 'carrier_map' },
      { time: '2017-05-25T14:20:00-04:00', local_time: '2017-05-25T14:20:00', time_zone: 'America/Toronto', time_zone_basis: 'carrier',
        description: 'Shipped on flight 3H833.', location: 'Schefferville (YKL)', provider_code: '3', stage: 'in_transit',
        stage_source: 'carrier_map' },
      { time: '2017-05-25T14:01:09-04:00', local_time: '2017-05-25T14:01:09', time_zone: 'America/Toronto', time_zone_basis: 'carrier',
        description: 'Manifested on flight 3H833 for May 25, 2017 at 14:20.', location: 'Schefferville (YKL)', provider_code: '2',
        stage: 'in_transit', stage_source: 'carrier_map' },
      { time: '2017-05-25T12:51:05-04:00', local_time: '2017-05-25T12:51:05', time_zone: 'America/Toronto', time_zone_basis: 'carrier',
        description: 'Accepted by Air Inuit Cargo in Schefferville (YKL).', location: 'Schefferville (YKL)', provider_code: '9',
        stage: 'accepted', stage_source: 'carrier_map' },
    ]);
  });

  it('reads a shipment received at a station short of its destination as in transit', () => {
    // Invented: the sample routed on to Kuujjuaq, before it reaches there.
    const result = parseAirInuit(withLines(lines().slice(1), (reply) => { reply.data.UltimateDestination = 'Kuujjuaq (YVP)'; }), SAMPLE);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Received in Montréal Dorval (YUL).' });
    expect(result.events![0]).toMatchObject({ provider_code: '1', stage: 'in_transit' });
  });

  it('keeps once the lines that several lines of goods share, and orders them newest first', () => {
    const reply = copy();
    const goods = reply.data.CommoditiesByNatureOfGoods[0]!;
    // Invented: a second line of goods with the same history, its lines in another order.
    reply.data.CommoditiesByNatureOfGoods.push({ ...goods, m_sMarchandiseInterne: 'Synthetic', HistoriqueNew: [...goods.HistoriqueNew].reverse() });
    expect(parseAirInuit(reply, SAMPLE).events!.map((event) => event.provider_code)).toEqual(['4', '1', '3', '2', '9']);
    const unknown = withLines([{ ...lines()[0]!, statuID: 7, oSentence: { m_Sentence: 'Synthetic notice.' } }, ...lines().slice(1)]);
    expect(parseAirInuit(unknown, SAMPLE)).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup',
      last_status_text: 'Synthetic notice.' });
    expect(parseAirInuit(unknown, SAMPLE).events![0]).not.toHaveProperty('stage');
  });

  it('answers only for the waybill asked', () => {
    expect(() => parseAirInuit(blank, airInuitWaybill('00000000'))).toThrow(NotFoundError);
    expect(() => parseAirInuit(sample, airInuitWaybill('13472676'))).toThrow(IndeterminateError);
    expect(() => parseAirInuit(sample, airInuitWaybill('466-YUL-13472675'))).toThrow(IndeterminateError);
    expect(parseAirInuit(sample, airInuitWaybill('13472675')).events).toHaveLength(5);
    expect(() => parseAirInuit({ ...sample, status: 'error' }, SAMPLE)).toThrow(IndeterminateError);
    expect(() => parseAirInuit({ ...blank, status: 'error' }, SAMPLE)).toThrow(IndeterminateError);
  });

  it('refuses a reply it cannot read', () => {
    const broken = (edit: (reply: Reply) => void) => { const reply = copy(); edit(reply); return reply; };
    expect(() => parseAirInuit(null, SAMPLE)).toThrow(SchemaError);
    expect(() => parseAirInuit({ status: 'ok' }, SAMPLE)).toThrow(SchemaError);
    expect(() => parseAirInuit(broken((reply) => { reply.data.AwbPrefix = '014-YUL-'; }), SAMPLE)).toThrow(SchemaError);
    expect(() => parseAirInuit(broken((reply) => { (reply.data as Record<string, unknown>).CommoditiesByNatureOfGoods = null; }), SAMPLE)).toThrow(SchemaError);
    for (const edit of [{ m_sDateHistory: '29/05/2017' }, { m_sHeureHistory: '8h12' }, { m_sDateHistory: '1899-05-29' },
      { oSentence: { m_Sentence: ' ' } }, { statuID: '4' }]) {
      expect(() => parseAirInuit(withLines([{ ...lines()[0]!, ...edit } as Line]), SAMPLE), JSON.stringify(edit)).toThrow(SchemaError);
    }
    expect(() => parseAirInuit(withLines([]), SAMPLE)).toThrow(NoHistoryError);
  });

  it('maps every status code it has seen', () => {
    for (const entry of statuses.entries) {
      expect(statusMapAnswer({ carrier: 'air-inuit', providerCode: entry.code, description: entry.wording }), entry.code)
        .toMatchObject({ kind: 'mapped', stage: entry.stage });
    }
  });
});
