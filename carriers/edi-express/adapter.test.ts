import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, EDI_LOOKUP } from './adapter.js';
import { normalizeEdiNumber, parseEdiExpress } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample in numbers.json, and an invented PRO number.
const SAMPLE = '605323877';
const OTHER = '000000000';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const DELIVERED = fixture('delivered');
const NOT_FOUND = fixture('not-found');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The delivered page with some of its values changed.
const variant = (...changes: [string | RegExp, string][]) => changes.reduce((page, [from, to]) => {
  const changed = page.replace(from, to);
  if (changed === page) throw new Error(`The fixture has no ${String(from)}`);
  return changed;
}, DELIVERED);
const NOT_DELIVERED: [string, string] = ['11/2/2021', ''];
const OUT_FOR_DELIVERY: [RegExp, string] = [/(Out for Del:[\s\S]*?<font size="2" face="Arial">)\s*/, '$1 11/2/2021'];

describe('EDI Express PRO numbers', () => {
  it('takes nine digits, with spaces or hyphens', () => {
    expect(normalizeEdiNumber(' 605-323-877 ')).toBe(SAMPLE);
    for (const other of ['', '60532387', '6053238770', 'A05323877', '1'.repeat(70)]) {
      expect(() => normalizeEdiNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('EDI Express tracking adapter', () => {
  it('posts the number as the trace page’s PRO form does', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(html(DELIVERED));
    await expect(carrier(fetcher).track({ number: '605 323 877' })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe(EDI_LOOKUP);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(String(init.body)).toBe(`p=${SAMPLE}&Submit=Trace`);
    expect(new Headers(init.headers).get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(carrier(fetcher)).toMatchObject({ id: 'edi-express', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the page’s answer for a PRO it has no shipment under as not found', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(html(NOT_FOUND))).track({ number: OTHER }))
      .rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps challenges, outages, redirects and changed pages apart from a missing shipment', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: OTHER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    const challenge = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    expect(await answer(() => html(challenge, { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(challenge))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('Forbidden', { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('', { status: 503 }))).toMatchObject({ kind: 'maintenance' });
    expect(await answer(() => html('', { status: 302, headers: { Location: 'https://my.ediexpressinc.com/login.asp' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('<h1>Not Found</h1>', { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => html('', { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => html(' '))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => html('<html><body><h1>Welcome</h1></body></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => html(NOT_FOUND.replace('No data available', 'Server busy')))).toMatchObject({ kind: 'schema' });
  });
});

describe('EDI Express shipment pages', () => {
  it('reads the delivered sample’s milestones, newest first, each on its day', () => {
    expect(parseEdiExpress(DELIVERED, SAMPLE)).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      last_update: null, last_update_local: '2021-11-02', expected_delivery: null, weight_kg: 331.122, destination_country: 'US',
      receiver_address: 'PRESCOTT, AZ', summary_only: true,
      events: [
        { local_time: '2021-11-02', description: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2021-10-27', description: 'Trailer dispatched to AZ', original_description: 'Trailer dispatched to AZ on 10/27/2021',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2021-10-22', description: 'Picked up', stage: 'accepted', stage_source: 'carrier_map' },
      ],
    });
  });

  it('gives freight on its way the revised estimate, or the appointment once one is made', () => {
    expect(parseEdiExpress(variant(NOT_DELIVERED), SAMPLE)).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Trailer dispatched to AZ', last_update_local: '2021-10-27',
      expected_delivery: '2021-11-04',
    });
    expect(parseEdiExpress(variant(NOT_DELIVERED, ['&nbsp', '11/5/2021']), SAMPLE)).toMatchObject({ expected_delivery: '2021-11-05' });
    expect(parseEdiExpress(variant(NOT_DELIVERED, ['11/4/2021', '']), SAMPLE)).toMatchObject({ expected_delivery: '2021-10-29' });
  });

  it('puts a day’s milestones in the order freight reaches them', () => {
    expect(parseEdiExpress(variant(OUT_FOR_DELIVERY), SAMPLE).events?.slice(0, 2)).toMatchObject([
      { local_time: '2021-11-02', description: 'Delivered' }, { local_time: '2021-11-02', description: 'Out for delivery', stage: 'out_for_delivery' },
    ]);
    expect(parseEdiExpress(variant(NOT_DELIVERED, OUT_FOR_DELIVERY), SAMPLE)).toMatchObject({ current_stage: 'out_for_delivery' });
  });

  it('keeps a status no rule reads visible, and stands on an undated status alone without milestones', () => {
    const unknown = parseEdiExpress(variant(NOT_DELIVERED, ['Trailer dispatched to AZ on', 'Parked on']), SAMPLE);
    expect(unknown).toMatchObject({ last_status_text: 'Parked' });
    expect(unknown.events?.[0]).not.toHaveProperty('stage');
    const undated = variant(NOT_DELIVERED, ['10/22/2021', ''], ['Trailer dispatched to AZ on 10/27/2021', 'Trailer dispatched to AZ']);
    expect(parseEdiExpress(undated, SAMPLE)).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Trailer dispatched to AZ', last_update: null,
      expected_delivery: '2021-11-04', summary_only: true, events: [],
    });
    expect(() => parseEdiExpress(undated.replace('Trailer dispatched to AZ', 'Parked'), SAMPLE))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('never reads the shipper, the bill-to party, ZIP codes or the freight’s description', () => {
    const answer = JSON.stringify(parseEdiExpress(DELIVERED, SAMPLE));
    for (const hidden of ['BRUNSWICK', 'PISCATAWAY', 'NJ', '00000', 'CELLULOSE', 'Surcharge']) expect(answer).not.toContain(hidden);
  });

  it('refuses a page for another shipment', () => {
    expect(() => parseEdiExpress(DELIVERED, OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a changed page', () => {
    for (const changed of [
      variant(['10/22/2021', '13/45/2021']), variant(['10/22/2021', 'soon']), variant(['Trailer dispatched to AZ on 10/27/2021', 'Trailer dispatched to AZ on 2/30/2021']),
      variant([/<strong>INVOICE NO:<\/strong>/, '<strong>PRO:</strong>']), variant(['Est Del Date:', 'Pickup Date:']),
      DELIVERED.replace(/<table[\s\S]*$/, ''),
    ]) {
      expect(() => parseEdiExpress(changed, SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('EDI Express statuses', () => {
  it('maps every wording it was seen to give, by its whole wording', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'edi-express', providerCode: null, description: entry.wording })).toMatchObject({ stage: entry.stage });
    }
    expect(statusMap.stage(null, 'anything')).toBeUndefined();
  });
});
