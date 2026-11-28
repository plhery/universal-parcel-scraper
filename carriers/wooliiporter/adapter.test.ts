import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, WOOLII_API } from './adapter.js';
import { normalizeWooliiNumber, parseWoolii } from './parser.js';

const NUMBER = 'WP1000000000009';
const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const delivered = () => JSON.parse(fixture('delivered.json')) as { trackingNumber: string; events: Record<string, unknown>[] };
const reply = (body: string, status = 200, type = 'application/json') => new Response(body, { status, headers: { 'Content-Type': type } });
const carrier = (fetcher: typeof fetch) => adapter({ env: {}, fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER });

describe('WooliiPorter', () => {
  it('asks the page\'s lookup for the number and reads its scans newest first, once each', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => reply(fixture('delivered.json')));
    const result = await carrier(fetcher).track({ number: ' wp 1000000000009 ' }, { budgetMs: 8000 });
    expect(String(fetcher.mock.calls[0]![0])).toBe(`${WOOLII_API}${NUMBER}`);
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get('accept')).toBe('application/json');
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_update: '2031-05-02T03:20:00Z', delivered_at: '2031-05-02T03:20:00Z', last_status_text: 'Delivered to the recipient' });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage])).toEqual([
      ['2031-05-02T03:20:00Z', 'DELIVERED', 'delivered'],
      ['2031-05-01T22:05:00Z', 'OUT_FOR_DELIVERY', 'out_for_delivery'],
      ['2031-04-26T09:40:00+08:00', 'IN_TRANSIT', 'in_transit'],
      ['2031-04-25T16:12:00+08:00', 'HANDED_OVER', 'accepted'],
      ['2031-04-24T10:00:00+08:00', 'INFO_RECEIVED', 'registered'],
    ]);
    // A scan without its own wording takes the page's label; one without a place has none.
    expect(result.events!.at(-1)).toEqual({ time: '2031-04-24T10:00:00+08:00', description: 'Information received',
      provider_code: 'INFO_RECEIVED', stage: 'registered', stage_source: 'carrier_map' });
    expect(result.events![3]!.location).toBe('Guangzhou, CN');
    expect(JSON.stringify(result)).not.toContain('"carrier"');
  });

  it('reads the service\'s 404 as not found and keeps other failures distinct', async () => {
    await expect(carrier(async () => reply(fixture('not-found.json'), 404)).track({ number: NUMBER }, { budgetMs: 8000 }))
      .rejects.toMatchObject({ kind: 'not_found' });
    // The service's earlier wording.
    await expect(carrier(async () => reply('{"error":"Tracking not found"}', 404)).track({ number: NUMBER }, { budgetMs: 8000 }))
      .rejects.toMatchObject({ kind: 'not_found' });
    for (const [response, kind] of [
      [() => reply('{"error":"Tracking number not found anywhere"}', 404), 'transport'],
      [() => reply('{"message":"Not Found"}', 404), 'transport'],
      [() => reply('', 302), 'transport'],
      [() => reply('<html><title>Just a moment...</title></html>', 403, 'text/html'), 'challenge'],
      [() => reply('<html><title>Just a moment...</title></html>', 200, 'text/html'), 'challenge'],
      [() => reply('{}', 429), 'rate_limited'],
      [() => reply('not json'), 'schema'],
    ] as const) {
      await expect(carrier(async () => response()).track({ number: NUMBER }, { budgetMs: 8000 })).rejects.toMatchObject({ kind });
    }
  });

  it.each([['100', '900'], ['100000001', '100000009']])('orders scans within a second at source precision (%s, %s)', (early, late) => {
    const events = [{ eventAt: `2031-05-02T03:20:00.${early}Z`, status: 'OUT_FOR_DELIVERY' },
      { eventAt: `2031-05-02T03:20:00.${late}Z`, status: 'DELIVERED' }];
    expect(parseWoolii({ ...delivered(), events }, NUMBER)).toMatchObject({ current_stage: 'delivered', last_update: events[1]!.eventAt });
  });

  it('binds the reply to the number, takes a reference\'s public number, and reads a shipment without scans as no history yet', () => {
    expect(() => parseWoolii({ ...delivered(), trackingNumber: 'WP1000000000017' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseWoolii(delivered(), 'WPTRK-AB12')).toMatchObject({ canonical_tracking_number: NUMBER });
    expect(() => parseWoolii({ ...delivered(), trackingNumber: 'WPTRK-ZZ99' }, 'WPTRK-AB12')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseWoolii({ ...delivered(), status: 'INFO_RECEIVED', events: [] }, NUMBER)).toThrow(expect.objectContaining({ name: 'NoHistoryError', reason: 'listed' }));
    for (const payload of [null, [], {}, { trackingNumber: NUMBER }, { ...delivered(), events: [null] },
      { ...delivered(), events: [{ eventAt: '2031-05-02T03:20:00', descriptionEn: 'Delivered', status: 'DELIVERED' }] },
      { ...delivered(), events: [{ eventAt: '2031-05-02T24:20:00Z', descriptionEn: 'Delivered', status: 'DELIVERED' }] },
      { ...delivered(), events: [{ eventAt: '2031-05-02T03:20:00Z', descriptionEn: '', status: 'SOMETHING_NEW' }] }]) {
      expect(() => parseWoolii(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // A code the page does not list is kept unstaged.
    const unlisted = parseWoolii({ ...delivered(), events: [{ eventAt: '2031-05-02T03:20:00Z', descriptionEn: 'Held at the hub', status: 'SOMETHING_NEW' }] }, NUMBER);
    expect(unlisted).toMatchObject({ status: 'unknown', events: [{ provider_code: 'SOMETHING_NEW' }] });
    expect(unlisted.current_stage).toBeUndefined();
  });

  it('asks only WP numbers whose check digit passes, as the page does, and WPTRK- references', () => {
    expect(normalizeWooliiNumber('wp-1000000000009')).toBe(NUMBER);
    expect(normalizeWooliiNumber('WPTRK-AB12')).toBe('WPTRK-AB12');
    expect(normalizeWooliiNumber('wptrkab12')).toBe('WPTRK-AB12');
    for (const number of ['WP1000000000008', 'WP100000000009', 'XP1000000000009', 'WPTRK-']) {
      expect(() => normalizeWooliiNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('recognizes a number the service knows, and not one it does not', async () => {
    await expect(carrier(async () => reply(fixture('delivered.json'))).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
    await expect(carrier(async () => reply(fixture('not-found.json'), 404)).recognize!(NUMBER)).resolves.toMatchObject({ known: false });
  });
});
