import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { createTracker } from '../../facade/index.js';
import { resolveResult } from '../../core/result/resolve.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { parseEtsAbsencePage, parseEtsTrack } from './parser.js';
import { etsStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'RETS004827610539UES';
const READ_AT = Date.parse('2026-02-20T12:00:00Z');
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/track.json', import.meta.url), 'utf8')) as [{ ack: string; data: Record<string, unknown>[] }];
const unknownPage = () => readFileSync(new URL('./fixtures/page-unknown.html', import.meta.url), 'utf8');
const noTrack = () => [{ ack: 'false', message: '未查询到轨迹' }];

describe('ETS Express response fixtures', () => {
  it('does not state an older delivery through a newer unmapped scan', () => {
    const payload = fixture(), rows = payload[0].data[0]!.trackDetails as Record<string, unknown>[];
    rows.unshift({ track_date: '2026-02-19 12:00:00', track_createdate: '2026-02-19 12:01:00',
      track_content: 'Synthetic carrier amendment', track_location: '', track_kind: 'SYNTHETIC_AMENDMENT' });
    const result = parseEtsTrack(payload, NUMBER, READ_AT)!;
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic carrier amendment', last_update_local: '2026-02-19T12:00:00' });
    expect(result).not.toHaveProperty('current_stage');
    expect(resolveResult(result).current_stage).not.toBe('delivered');
    expect(result.events?.[1]).toMatchObject({ stage: 'delivered' });
  });

  it('keeps contradictory or truncated-identity empty pages inconclusive', () => {
    for (const page of [unknownPage().replace('<li>/</li>', '<li>Shipment is handed over to the customer</li>'),
      unknownPage().replace(`<li>${NUMBER}</li>`, `<li>${NUMBER}${'-'.repeat(600)}RETS004827610538UES</li>`),
      unknownPage().replace('<li>/</li><li></li>', '<li>/</li><li>Synthetic recipient</li>'),
      unknownPage().replace('<li></li></ul></div>', '<li>1.2</li></ul></div>')]) {
      expect(() => parseEtsAbsencePage(page, NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('keeps local scan clocks, milestones and customs-script provenance without claiming Ozon references', () => {
    const result = parseEtsTrack(fixture(), NUMBER, READ_AT)!;
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Shipment is handed over to the customer', last_update: null,
      last_update_local: '2026-02-18T18:34:29', destination_country: 'RU', service_name: 'RETS EXtra small Standard',
      written_ahead: ['2026-02-08T13:25:16', '2026-02-08T05:25:16'] });
    expect(result.events).toHaveLength(8);
    expect(result.events!.map((event) => event.stage)).toEqual([
      'delivered', 'ready_for_pickup', 'in_transit', 'in_transit', 'in_transit', 'accepted', 'registered', 'registered',
    ]);
    expect(result.events!.every((event) => event.local_time && !event.time && !event.written_at)).toBe(true);
    expect(result.events![4]).toMatchObject({ location: '示例市', provider_code: 'SHIPMENT' });
    for (const field of ['canonical_tracking_number', 'delivery_tracking_number', 'delivery_carrier', 'receiver_name']) {
      expect(result).not.toHaveProperty(field);
    }
    expect(JSON.stringify(result)).not.toContain('Synthetic private address');
  });

  it('requires the whole returned invoice or tracking number, without truncated-prefix matches', () => {
    for (const returned of ['RETS004827610538UES', `${NUMBER}${'0'.repeat(80)}`]) {
      const payload = fixture();
      payload[0].data[0]!.business_seqinvoicecode = returned;
      payload[0].data[0]!.referenceNumber = NUMBER;
      expect(() => parseEtsTrack(payload, NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    const payload = fixture();
    payload[0].data[0]!.trackingNumber = NUMBER;
    payload[0].data[0]!.business_seqinvoicecode = '';
    expect(parseEtsTrack(payload, NUMBER, READ_AT)?.events).toHaveLength(8);
  });

  it('requires a RETS product and one unambiguous matching record', () => {
    for (const product of ['', 'Other network', 'RETSOTHER']) {
      const payload = fixture();
      payload[0].data[0]!.productKindName = product;
      expect(() => parseEtsTrack(payload, NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    const payload = fixture();
    payload[0].data.push(structuredClone(payload[0].data[0]!));
    expect(() => parseEtsTrack(payload, NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects malformed identity and record/history schema', () => {
    for (const [key, value] of [['business_seqinvoicecode', {}], ['trackingNumber', []], ['productKindName', {}], ['trackDetails', {}]] as const) {
      const payload = fixture();
      payload[0].data[0]![key] = value;
      expect(() => parseEtsTrack(payload, NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const payload of [[], [{ ack: 'true', data: [] }], [{ ack: 'true', data: [null] }], [{ data: fixture()[0].data }]]) {
      expect(() => parseEtsTrack(payload, NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('settles only the explicit empty-waybill signature as absence', () => {
    expect(() => parseEtsAbsencePage(unknownPage(), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(parseEtsTrack(noTrack(), NUMBER, READ_AT)).toBeNull();
    expect(() => parseEtsAbsencePage(unknownPage().replaceAll(NUMBER, 'RETS004827610538UES'), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseEtsAbsencePage('<html>No data</html>', NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseEtsTrack([{ ack: 'false', message: 'temporary failure' }], NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseEtsTrack([{ ack: 'false', message: '未查询到轨迹', data: [] }], NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('does not accept a positive page whose matching query is only echoed', () => {
    const page = unknownPage().replace('件数:【】', '件数:【1】')
      .replace('<li>RETS004827610539UES</li>', '<li>73492816-0265-2</li>')
      .replace('</div></div>', '<div class="difmeam"><table><tr><td>2026-02-04 07:12:15</td><td></td><td>Shipment registered</td></tr></table></div></div></div>');
    expect(() => parseEtsAbsencePage(page, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps provider-declared throttles and verification errors separate from absence', () => {
    expect(() => parseEtsTrack([{ ack: 'false', message: '查询过于频繁' }], NUMBER)).toThrow(expect.objectContaining({ kind: 'rate_limited' }));
    expect(() => parseEtsTrack([{ ack: 'false', message: '请完成验证码' }], NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('retains a capped history flag instead of silently claiming completeness', () => {
    const payload = fixture();
    payload[0].data[0]!.trackDetails = Array.from({ length: 101 }, (_, index) => ({
      track_date: `2026-01-01 ${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00`,
      track_content: `Synthetic scan ${index}`, track_location: '', track_kind: '',
    }));
    expect(parseEtsTrack(payload, NUMBER, READ_AT)).toMatchObject({ history_truncated: true, events: expect.any(Array) });
    expect(parseEtsTrack(payload, NUMBER, READ_AT)?.events).toHaveLength(100);
  });

  it('maps the observed whole wordings and preserves unknown kind meanings', () => {
    for (const entry of statuses.entries) {
      expect(etsStage(entry.code ?? null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    }
    expect(etsStage('ARRIVAL', normalizeStatusWording('Synthetic unrelated arrival'))).toBeUndefined();
    expect(statusMap.gaps).toContainEqual(expect.objectContaining({ code: 'CO_C_CR' }));
  });
});

it('routes ETS through enabled providers and never sends its reference over HTTP', async () => {
  expect(recognitionAskedCarriers(NUMBER)).not.toContain('ets-express');
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
    carriers: ['ETS Express'], states: [{ date: '2026-11-04T08:00:00Z', status: 'Delivered', carrier: 0 }],
  }));
  const tracker = createTracker({ fetcher, providers: ['ParcelsApp'], env: {}, trawlUrl: '' });
  const answer = await tracker.track({ number: NUMBER, carrier: 'ets-express' });
  expect(answer.source).toBe('ParcelsApp');
  expect(fetcher.mock.calls.length).toBeGreaterThan(0);
  for (const [url] of fetcher.mock.calls) expect(new URL(String(url)).protocol).toBe('https:');
});
