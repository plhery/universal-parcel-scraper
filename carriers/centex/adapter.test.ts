import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, centexLookupUrl } from './adapter.js';
import { normalizeCentexNumber, parseCentexPage } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const delivered = fixture('delivered.html');
const archived = fixture('archived-transit.html');
const notFound = fixture('not-found.html');
// The public sample: CENTEX's waybill and the Correios number of the same parcel.
const WAYBILL = 'ZJ00471201019000851';
const CORREIOS = 'NX031367846BR';

const respond = (body: string, status = 200) => async () => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
const tracker = (fetcher: typeof fetch) => adapter({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {}, fetcher });

describe('CENTEX tracker', () => {
  it('reads the China leg and the Correios posting on their wall clocks', () => {
    const result = parseCentexPage(archived, WAYBILL);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'objeto postado',
      last_update: null, last_update_local: '2020-10-22T13:58:00', destination_country: 'BR',
      delivery_carrier: 'correios-br', delivery_tracking_number: CORREIOS });
    expect(result.events).toHaveLength(5);
    expect(result.events!.every((event) => event.local_time && !event.time)).toBe(true);
    expect(result.events![0]).toMatchObject({ description: 'objeto postado', location: 'china', stage: 'in_transit', stage_source: 'carrier_map' });
    expect(result.events![2]).toMatchObject({ local_time: '2020-10-21T17:13:32', location: '坂田', description: 'Departed Facility in SHENZHEN' });
    expect(result.events![4]).toMatchObject({ description: 'SHIPMENT INFORMATION SUBMITTED', stage: 'registered' });
    expect(result.events![4]!.location).toBeUndefined();
  });

  it('reads the delivery, and names no onward number when asked by the Correios number', () => {
    const result = parseCentexPage(delivered, CORREIOS);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update_local: '2020-11-09T14:00:00' });
    expect(result.events).toEqual([expect.objectContaining({ description: 'objeto entregue ao destinatário', location: 'balneario camboriu / sc' })]);
    expect(result.delivery_tracking_number).toBeUndefined();
  });

  it('answers not found only on the empty list the tracker gives an unknown number', () => {
    expect(() => parseCentexPage(notFound, 'ZJ00000000000000017')).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // A list that holds another shipment is not this one's answer.
    expect(() => parseCentexPage(delivered, 'ZJ00000000000000017')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps a check page or another page apart from a missing parcel', () => {
    expect(() => parseCentexPage('<html><script>var arg1="acw_sc__v2"</script></html>', WAYBILL)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseCentexPage('<html><body>502 Bad Gateway</body></html>', WAYBILL)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const unreadable = delivered.replace(/2020-11-09 14:00:00/g, 'yesterday');
    expect(() => parseCentexPage(unreadable, CORREIOS)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('accepts its waybills and Correios numbers for Brazil only', () => {
    expect(normalizeCentexNumber(' zj00471201019000851 ')).toBe(WAYBILL);
    expect(normalizeCentexNumber(CORREIOS)).toBe(CORREIOS);
    for (const invalid of ['ZJ0047120101900085', 'NX031367846CN', '1234567890']) {
      expect(() => normalizeCentexNumber(invalid)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    expect(centexLookupUrl(WAYBILL)).toBe(`https://www.baxida.cn/default/index/track?trackNos=${WAYBILL}`);
  });

  it('asks the tracker once, and recognizes only its own waybills', async () => {
    const urls: string[] = [];
    const fetcher = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return respond(delivered)();
    }) as typeof fetch;
    await expect(tracker(fetcher).track({ number: WAYBILL })).resolves.toMatchObject({ status: 'delivered' });
    expect(urls).toEqual([centexLookupUrl(WAYBILL)]);
    await expect(tracker(fetcher).recognize!(CORREIOS)).resolves.toMatchObject({ known: false });
    expect(urls).toHaveLength(1);
    await expect(tracker(fetcher).recognize!(WAYBILL)).resolves.toMatchObject({ known: true });
    // A moved page is no answer about the parcel.
    await expect(tracker(respond('', 404) as typeof fetch).track({ number: WAYBILL }, { budgetMs: 2_000 }))
      .rejects.toMatchObject({ kind: 'transport' });
  });
});
