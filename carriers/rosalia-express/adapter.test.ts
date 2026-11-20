import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking, readGuestForm } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const example = fixture('example');
const number = '076250118711';
const searchUrl = 'https://www.rosalia-express.com/cek-paket';
const endpoint = 'https://www.rosalia-express.com/livewire/message/front::float-card.tracking';
const fingerprint = { id: 'guest-component', name: 'front::float-card.tracking', locale: 'en', path: 'cek-paket', method: 'GET', v: 'acj' };
const serverMemo = { data: { receipt: '', receiptResult: null, isHomePage: false }, checksum: 'guest-state' };
const form = `<div wire:initial-data='${JSON.stringify({ fingerprint, serverMemo })}'>
  <form wire:submit.prevent="checkReceipts"><input wire:model.defer="receipt"></form>
</div><script>window.livewire_token='${'a'.repeat(40)}';</script>`;

describe('Rosalia Express public waybill tracking', () => {
  it('keeps five local events and gives the confirmed delivery priority in a same-time tie', () => {
    const result = parseTracking(example, number);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'explicit_mapping',
      provider_code: 'Selesai, telah diambil', last_update: null, last_update_local: '2025-02-03T08:48:43',
    });
    expect(result.events?.map(event => [event.description, event.local_time, event.stage, event.location])).toEqual([
      ['Selesai, telah diambil', '2025-02-03T08:48:43', 'delivered', undefined],
      ['Paket dalam proses delivery oleh agen', '2025-02-03T08:48:43', 'out_for_delivery', undefined],
      ['Ke Cargo Delivery', '2025-02-02T04:10:52', 'in_transit', '(SIDOARJO) SURABAYA BUNGURASIH'],
      ['Perjalanan', '2025-02-01T14:34:15', 'in_transit', undefined],
      ['Tunggu berangkat', '2025-01-31T15:45:16', 'registered', '(BANTUL) YOGYA ROS-IN'],
    ]);
  });

  it('distinguishes invalid input, a mismatched receipt, invalid dates and a browser check', () => {
    expect(() => parseTracking(fixture('invalid'), 'INVALID SAMPLE')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => parseTracking(example, '999000000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTracking(example.replace('Min 02, Feb 2025', 'Min 32, Feb 2025'), number))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => readGuestForm('<title>Just a moment...</title>')).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('preserves the leading zero and posts fresh guest component state to the expected route', async () => {
    const opened = new Response(form, { headers: { 'Set-Cookie': 'guest_session=fresh; Path=/; Secure' } });
    Object.defineProperty(opened, 'url', { value: searchUrl });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(opened).mockResolvedValueOnce(new Response(example));
    const tracker = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(tracker.track({ number })).resolves.toMatchObject({ status: 'delivered' });
    const calls = fetcher.mock.calls;
    expect(calls.map(([url]) => String(url))).toEqual([searchUrl, endpoint]);
    const headers = new Headers(calls[1]?.[1]?.headers);
    expect(headers.get('Cookie')).toBe('guest_session=fresh');
    expect(headers.get('X-CSRF-TOKEN')).toBe('a'.repeat(40));
    expect(JSON.parse(String(calls[1]?.[1]?.body))).toEqual({
      fingerprint, serverMemo, updates: [
        { type: 'syncInput', payload: { id: 'receipt', name: 'receipt', value: number } },
        { type: 'callMethod', payload: { id: 'lookup', method: 'checkReceipts', params: [] } },
      ],
    });
  });
});
