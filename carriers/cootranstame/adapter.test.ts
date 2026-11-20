import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking, SEARCH_URL } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const example = fixture('example');
const missing = fixture('missing');
const number = '2257392';
const synthetic = '000000000000000';
const token = 'x'.repeat(40);
const fingerprint = { name: 'traza-guia', path: 'rastreo-envios', id: 'test' };
const serverMemo = { data: { guia: '', tipoServicio: '' }, checksum: 'fixture' };
const form = `<div wire:initial-data='${JSON.stringify({ fingerprint, serverMemo })}'><form>
<input name="_token" value="${token}">
<input wire:model.defer="guia">
<button wire:click="sendForm">Consulta</button>
</form></div>`;

describe('CootransTame guest guide tracking', () => {
  it('reads the four clocked scans from the shipment data', () => {
    const result = parseTracking(example, number, '110');
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'explicit_mapping',
      last_status_text: 'TRANSITO', last_update: null, last_update_local: '2025-07-09T04:01:40.110',
    });
    expect(result.events?.map(event => [event.description, event.local_time, event.stage, event.location])).toEqual([
      ['TRANSITO', '2025-07-09T04:01:40.110', 'in_transit', 'BOGOTA'],
      ['OFICINA ORIGEN', '2025-07-08T23:12:50.353', 'in_transit', 'BOGOTA'],
      ['TRANSITO', '2025-07-08T23:12:37.110', 'in_transit', 'BOGOTA'],
      ['RECOGIDA', '2025-07-08T09:48:26.523', 'accepted', 'CPV-01 KUBOX LOGISTIC'],
    ]);
  });

  it('distinguishes an explicit absence from a mismatched guide or service', () => {
    expect(() => parseTracking(missing, synthetic, '110')).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTracking(missing, number, '110')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTracking(example, number, '111')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTracking(example.replace('"NumeroDocumento": 2257392', '"NumeroDocumento": 2257393'), number, '110'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('uses the anonymous form state and checks the second service after an explicit absence', async () => {
    const formResponse = new Response(form, { headers: { 'set-cookie': 'session=synthetic; Path=/; Secure' } });
    Object.defineProperty(formResponse, 'url', { value: SEARCH_URL });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(formResponse)
      .mockResolvedValueOnce(new Response(missing))
      .mockResolvedValueOnce(new Response(missing.replace('"110"', '"111"')));
    const tracker = adapter({
      fetcher, userAgent: 'CootransTame Test', trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER,
    });
    await expect(tracker.track({ number: synthetic })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const [, first, second] = fetcher.mock.calls;
    for (const [service, call] of [['110', first], ['111', second]] as const) {
      expect(String(call?.[0])).toBe('https://www.cootranstame.com/livewire/message/traza-guia');
      const options = call?.[1];
      expect(new Headers(options?.headers).get('cookie')).toBe('session=synthetic');
      expect(new Headers(options?.headers).get('x-csrf-token')).toBe(token);
      expect(JSON.parse(String(options?.body))).toMatchObject({
        fingerprint, serverMemo, updates: [
          { payload: { name: 'guia', value: synthetic } },
          { payload: { name: 'tipoServicio', value: service } },
          { payload: { method: 'sendForm' } },
        ],
      });
    }
  });
});
