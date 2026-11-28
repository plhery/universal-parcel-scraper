import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AdapterRegistry } from '../../core/adapter/index.js';
import { trackCarrier } from '../../core/adapter/track.js';
import { sameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NoHistoryError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { trackingPlace } from '../../places/trackingLocation.js';
import type { UniversalTracker } from '../../providers/universal.js';
import { adapter, JetspeedTracker } from './adapter.js';
import { jetspeedPlace, jetspeedUrl, parseJetspeedPage } from './parser.js';
import { jetspeedStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The synthetic sample in numbers.json, which `track.html` answers.
const NUMBER = 'JSD000000000199';
const UNKNOWN = 'JSD000000000000';
const own = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
/** A tracker page for `NUMBER` with the rows given, newest first. */
const rowsPage = (rows: readonly (readonly [string, string])[]) => `<div class="query-main" id="result"><div class="main-content">
  <p>单号：<strong>${NUMBER}</strong></p><div class="timeline">${rows.map(([time, context]) =>
  `<div class="timeline-item"><div class="time">${time}</div><div class="context">${context}</div></div>`).join('')}</div></div></div>`;

describe('JETSPEED tracking adapter', () => {
  it('names JETSPEED for JSD and twelve digits, and for no other length', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'jetspeed', confidence: 'high', candidates: ['jetspeed'] });
    for (const other of [NUMBER.slice(0, -1), `${NUMBER}0`, `JSA${NUMBER.slice(3)}`]) {
      expect(detectCarrierMatch(other).candidates).not.toContain('jetspeed');
    }
  });

  it('reads the tracker’s page for the whole number, every row on the tracker’s clock', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(own('track.html')));
    const result = await new JetspeedTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase());
    expect(String(fetcher.mock.calls[0]![0])).toBe(`https://www.jetspeed-express.com/search_kuai_di/search/orderid/${NUMBER}`);
    // The site fails on `Accept-Language: *`, Node's default.
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get('Accept-Language')).toBe('zh-CN,zh;q=0.9,en;q=0.8');
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', last_update: '2026-05-23T01:16:57+08:00',
      last_status_text: 'Parcel arrived at the local delivery station, serving Lyon,69007.', last_update_local: '2026-05-23T01:16:57',
    });
    expect(result.events).toHaveLength(19);
    // Rows of the origin and the destination alike: the tracker writes them all on its clock in Shenzhen.
    expect(result.events?.every((event) => event.time === `${event.local_time}+08:00` && event.time_zone === 'Asia/Shanghai'
      && event.time_zone_basis === 'carrier' && event.stage)).toBe(true);
    expect(result.events?.at(-1)).toEqual({
      time: '2026-05-04T11:20:18+08:00', local_time: '2026-05-04T11:20:18', time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier',
      description: 'Mississauga,ON,CA,L5T 0A1,Order information received by the carrier.',
      location: 'Mississauga, ON, CA', stage: 'registered', stage_source: 'carrier_map',
    });
    expect(result.events?.at(-2)).toMatchObject({ stage: 'accepted', location: 'Mississauga, ON, CA' });
    // The places the wordings name, and the destination facility's country.
    expect(result.destination_country).toBe('FR');
    expect(result.events?.map((event) => event.location).filter(Boolean)).toEqual(['Lyon', 'FR', 'FR', 'Toronto', 'Mississauga, ON, CA', 'Mississauga, ON, CA']);
  });

  it('holds back a row the tracker dates after the lookup until it is due', async () => {
    const page = own('track.html').replace(
      /(<div class="timeline-item latest">\s*<div class="time">)[^<]+(<\/div>\s*<div class="context">)[^<]+/,
      '$12999-01-01 08:00:00$2Delivery has been scheduled with the carrier.',
    );
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page));
    expect(parseJetspeedPage(page, NUMBER).events?.[0]).toMatchObject({ time: '2999-01-01T08:00:00+08:00', stage: 'in_transit' });
    const registry = new AdapterRegistry({ factories: { jetspeed: adapter }, carriers: { jetspeed: 'jetspeed' } }, environment(fetcher));
    const result = await trackCarrier('jetspeed', { number: NUMBER }, { registry, universal: {} as UniversalTracker });
    expect(result.events).toHaveLength(18);
    expect(result.events?.[0]).toMatchObject({ local_time: '2026-05-21T03:09:55', time: '2026-05-21T03:09:55+08:00' });
  });

  it('settles the site’s no-order page as not found, and recognition with it', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(own('unknown.html')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(adapter(environment(fetcher)).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockResolvedValue(reply(own('track.html')));
    await expect(adapter(environment(known)).recognize!(NUMBER)).resolves.toMatchObject({ known: true, lastActivityAt: '2026-05-22T17:16:57.000Z' });
  });

  it('never takes another page, another number or an empty history for a missing parcel', () => {
    expect(() => parseJetspeedPage(own('track.html'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseJetspeedPage(own('unknown.html').replace('未查询到对应订单', '系统繁忙'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseJetspeedPage('<html><title>Just a moment...</title>cf-chl-</html>', NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    const empty = own('track.html').replace(/<div class="timeline-item[\s\S]*?<\/div>\s*<\/div>/g, '');
    expect(() => parseJetspeedPage(empty, NUMBER)).toThrow(NoHistoryError);
  });

  it('reads a refusal as a challenge, and one number only', async () => {
    const refused = vi.fn<typeof fetch>().mockImplementation(async () => reply('Forbidden', 403));
    await expect(adapter(environment(refused)).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(adapter(environment(refused)).track({ number: `${NUMBER};${UNKNOWN}` })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(jetspeedUrl('A B')).toBe('https://www.jetspeed-express.com/search_kuai_di/search/orderid/A%20B');
  });

  it('reads the other line’s shorter rows, with the place in brackets before or after the words', () => {
    const result = parseJetspeedPage(rowsPage([
      ['2026-05-09 12:00:00', 'Arrived at the delivery station Example Town,Example Area,00000'],
      ['2026-05-09 09:00:00', 'Move to the next Example Branch office'],
      ['2026-05-08 09:00:00', 'Clearance in the destination country has been completed'],
      ['2026-05-07 18:00:00', 'Inspection documents are being submitted'],
      ['2026-05-06 10:00:00', 'Arrive at airport [Example]'],
      ['2026-05-03 12:00:00', 'Export customs/release [Example]'],
      ['2026-05-01 12:00:00', '[Example Hub] Consignment received at transit point'],
      ['2026-05-01 03:00:00', '[Example Hub] The order information has been sent'],
    ]), NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map' });
    expect(result.events?.map((event) => [event.stage, event.stage_source, event.location])).toEqual([
      ['in_transit', 'carrier_map', 'Example Town, Example Area'],
      ['in_transit', 'carrier_map', undefined], ['in_transit', 'carrier_map', undefined], ['customs', 'carrier_map', undefined], ['in_transit', 'carrier_map', 'Example'],
      ['in_transit', 'carrier_map', 'Example'], ['accepted', 'carrier_map', 'Example Hub'], ['registered', 'carrier_map', 'Example Hub'],
    ]);
  });

  it('reads the last mile\'s round and delivery after their town, area and postcode', () => {
    // Synthetic rows in the shape of a French last mile's: the delivery names its country before the postcode, and the address after.
    const result = parseJetspeedPage(rowsPage([
      ['2026-05-10 16:46:00', 'Example Town,Example Area,France,00000,Delivered Example Residence, Esc 1 porte 2'],
      ['2026-05-10 14:45:25', 'Example Town,Example Area,00000 Out for Delivery'],
      ['2026-05-10 12:07:06', 'Arrived at the delivery station Example Town,Example Area,00000'],
    ]), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map' });
    expect(result.events?.map((event) => [event.stage, event.stage_source, event.location])).toEqual([
      ['delivered', 'carrier_map', 'Example Town, Example Area'], ['out_for_delivery', 'carrier_map', 'Example Town, Example Area'],
      ['in_transit', 'carrier_map', 'Example Town, Example Area'],
    ]);
    expect(jetspeedPlace('Example Town,Example Area,France,00000,Not delivered')).toBeUndefined();
    expect(jetspeedStage('example town,example area,france,00000,delivery attempted')).toBeUndefined();
  });

  it('reads the brackets among the words too, and a country there gives the row its country', () => {
    // Synthetic rows of the other line, its countries in brackets after or among the words.
    const rows = ['About to be sent to the [France] warehouse', 'Arrived at [España] warehouse, Sorting in progress', 'Arrive at Airport [France]'];
    expect(rows.map((wording) => jetspeedPlace(wording))).toEqual(['France', 'España', 'France']);
    expect(rows.map((wording) => trackingPlace(jetspeedPlace(wording)!).country)).toEqual(['FR', 'ES', 'FR']);
    for (const wording of ['Package sorted [ready]x', 'Weight [kg]: 1', 'No brackets here']) expect(jetspeedPlace(wording)).toBeUndefined();
  });

  it('lets a row a release gives its place take over the row stored without one', () => {
    const policy = sameInstantIdentityPolicy('jetspeed', { supportsScanMatching: true })!;
    const stored = { stage: 'in_transit', description: 'About to be sent to the [Example] warehouse', location: '', providerCode: '' };
    expect(policy.matches!({ ...stored, location: 'Example' }, stored)).toBe(true);
    expect(policy.matches!({ ...stored, stage: '', location: 'Example' }, { ...stored, stage: '' })).toBe(true);
    expect(policy.matches!(stored, stored)).toBe(true);
    // Another place, another wording, or a place the stored row already had, is another scan.
    expect(policy.matches!({ ...stored, location: 'Elsewhere' }, stored)).toBe(false);
    expect(policy.matches!({ ...stored, location: 'Example' }, { ...stored, location: 'Elsewhere' })).toBe(false);
    expect(policy.matches!({ ...stored, description: 'Arrive at Airport [Example]', location: 'Example' }, stored)).toBe(false);
  });

  it('reads a row the map does not know by the shared rules, so its answer shows the parcel moving', async () => {
    const page = rowsPage([['2026-05-03 12:00:00', 'Arrived at the sorting center'], ['2026-05-02 12:00:00', 'Synthetic wording'],
      ['2026-05-01 03:00:00', '[Example Hub] The order information has been sent']]);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page));
    const registry = new AdapterRegistry({ factories: { jetspeed: adapter }, carriers: { jetspeed: 'jetspeed' } }, environment(fetcher));
    const result = await trackCarrier('jetspeed', { number: NUMBER }, { registry, universal: {} as UniversalTracker });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'wording:language' });
    expect(result.events?.map((event) => event.stage_source)).toEqual(['wording:language', undefined, 'carrier_map']);
  });

  it('maps every row it has written, and the app reads the map', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMapAnswer({ carrier: 'jetspeed', providerCode: null, description: 'Origin processing completed [Example].' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'jetspeed', providerCode: null, description: 'Consignment received at the local warehouse in Example.' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'jetspeed', providerCode: null, description: 'Synthetic wording' })).toEqual({ kind: 'unknown' });
  });
});
