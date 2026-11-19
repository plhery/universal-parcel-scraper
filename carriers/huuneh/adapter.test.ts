import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adapter } from './adapter.js';
import { normalizeHuunehNumber, parseHuuneh } from './parser.js';
import { huunehStage } from './status.js';

const NUMBER = 'AWB7750149870';
const UNKNOWN = 'AWB0000000000';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const page = (body: string, status = 200) => async () => new Response(body, { status, headers: { 'content-type': 'text/html' } });
const factory = (fetcher: typeof fetch) => adapter({ fetcher, env: {}, trawl: null, browserExecutablePath: null } as never);

describe('Huuneh tracking page', () => {
  it('reads the delivered sample’s history as wall clocks, newest first', () => {
    const result = parseHuuneh(fixture('delivered'), NUMBER);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', last_update: null, last_update_local: '2026-08-13T13:16:58',
      last_status_text: 'Delivered: The shipment has been delivered', expected_delivery: null,
      sender_name: 'Medoptimal Healthcare Consultancy', receiver_name: 'Precision Care Centre - Hamilton',
      receiver_address: '25 Charlton Ave E, Unit # 101\nHamilton',
    });
    expect(result.events).toEqual([
      { local_time: '2026-08-13T13:16:58', description: 'Delivered: The shipment has been delivered', stage: 'delivered', stage_source: 'carrier_map' },
      { local_time: '2026-08-13T09:03:17', description: 'On Route', stage: 'out_for_delivery', stage_source: 'carrier_map' },
      { local_time: '2026-08-12T18:38:25', description: 'Picked up', stage: 'accepted', stage_source: 'carrier_map' },
      { local_time: '2026-08-11T15:16:01', description: 'Pick_up: Package pickup created by customer! Medoptimal Healthcare Consultancy', stage: 'registered', stage_source: 'carrier_map' },
    ]);
    expect(result.events!.every(event => event.time === undefined)).toBe(true);
  });

  it('reads the echoed unknown page as not found, and only for the number asked', () => {
    expect(() => parseHuuneh(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseHuuneh(fixture('not-found'), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('refuses another waybill, a changed page, a challenge and bad clocks', () => {
    for (const [from, to, kind] of [
      ['<b>AWB7750149870</b>', '<b>AWB7750149871</b>', 'schema'],
      ['Track and Trace | Huuneh', 'Maintenance', 'schema'],
      ['2026/08/12', '2026/02/30', 'schema'],
      ['06:38:25 pm', '18:38:25 pm', 'schema'],
      ['<title>Track and Trace | Huuneh</title>', '<title>Just a moment...</title>', 'challenge'],
    ] as const) expect(() => parseHuuneh(fixture('delivered').replace(from, to), NUMBER)).toThrow(expect.objectContaining({ kind }));
  });

  it('reads a new status name by the shared wording rules, and keeps one they do not read without a stage', () => {
    const held = parseHuuneh(fixture('delivered').replace('Delivered\t', 'Held at depot\t'), NUMBER);
    expect(held).toMatchObject({ current_stage: 'in_transit', current_stage_source: 'wording:language' });
    const result = parseHuuneh(fixture('delivered').replace('Delivered\t', 'Reassigned\t'), NUMBER);
    expect(result.events![0]).toMatchObject({ description: 'Reassigned: The shipment has been delivered' });
    expect(result.events![0]).not.toHaveProperty('stage');
    // A newer scan without a stage does not undo the round, as it would a delivery.
    expect(result).toMatchObject({ current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      last_status_text: 'Reassigned: The shipment has been delivered' });
  });

  it('accepts one waybill and stages the names the page shows', () => {
    expect(normalizeHuunehNumber(' awb7750149870 ')).toBe(NUMBER);
    for (const value of ['AWB7750149870,AWB0000000000', '7750149870', 'AWB']) expect(() => normalizeHuunehNumber(value)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(huunehStage('Pick_up')).toBe('registered');
    expect(huunehStage('On Route')).toBe('out_for_delivery');
  });

  it('asks one bound URL and keeps refusals, moved routes and absences apart', async () => {
    const urls: string[] = [];
    const found = factory(async input => { urls.push(String(input)); return page(fixture('delivered'))(); });
    await expect(found.track({ number: NUMBER })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(urls).toEqual(['https://huuneh.com/dashboard/track.php?order_track=AWB7750149870']);
    await expect(factory(page(fixture('not-found'))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(factory(page('', 403)).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(factory(page('', 404)).track({ number: NUMBER })).rejects.not.toMatchObject({ kind: 'not_found' });
  });
});
