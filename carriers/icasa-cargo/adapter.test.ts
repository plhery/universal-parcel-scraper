import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking, readFormToken } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const example = fixture('example');
const number = '036-25917183';
const url = 'https://integracargo.com/rastreo/';

describe('ICASA Cargo air waybill tracking', () => {
  it('reads confirmed aircraft movements and delivery without treating a manifest as departure', () => {
    const result = parseTracking(example, number);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'explicit_mapping',
      last_status_text: 'Entregado', last_update: null, last_update_local: '2024-07-11T17:11',
    });
    expect(result.events).toHaveLength(10);
    expect(result.events?.slice(0, 3).map(event => [event.description, event.local_time, event.location, event.stage])).toEqual([
      ['Entregado', '2024-07-11T17:11', 'PVR', 'delivered'],
      ['Arribó', '2024-07-11T13:26', 'PVR', 'in_transit'],
      ['Partió', '2024-07-11T11:50', 'MEX', 'in_transit'],
    ]);
    expect(result.events?.filter(event => event.description === 'Manifestado')).toHaveLength(5);
    expect(result.events?.filter(event => event.description === 'Manifestado').every(event => !event.stage)).toBe(true);
    expect(result.events?.slice(-2).map(event => [event.description, event.stage])).toEqual([
      ['Aceptado', 'accepted'],
      ['Reservado', 'registered'],
    ]);
  });

  it('distinguishes an explicit absence, a different shipment, malformed dates and a challenge', () => {
    expect(() => parseTracking(fixture('missing'), number)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTracking(example, '036-25900000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTracking(example.replace('11/07/2024 17:11', '31/06/2024 17:11'), number))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => readFormToken('<title>Just a moment...</title>')).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('submits a waybill with a fresh anonymous form token and cookie', async () => {
    const form = new Response(fixture('form'), { headers: { 'Set-Cookie': 'csrftoken=guest-form; Path=/; Secure' } });
    Object.defineProperty(form, 'url', { value: url });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(form).mockResolvedValueOnce(new Response(example));
    const tracker = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(tracker.track({ number: '03625917183' })).resolves.toMatchObject({ status: 'delivered' });
    const calls = fetcher.mock.calls;
    expect(calls.map(([requested]) => String(requested))).toEqual([url, url]);
    expect(new Headers(calls[0]?.[1]?.headers).has('Cookie')).toBe(false);
    expect(new Headers(calls[1]?.[1]?.headers).get('Cookie')).toBe('csrftoken=guest-form');
    expect(calls[1]?.[1]?.method).toBe('POST');
    expect(String(calls[1]?.[1]?.body)).toBe(new URLSearchParams({
      csrfmiddlewaretoken: 'a'.repeat(64), modo_envio: 'aereo', awb: number,
    }).toString());
  });

  it('stops before submission if the site omits the guest cookie', async () => {
    const form = new Response(fixture('form'));
    Object.defineProperty(form, 'url', { value: url });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(form);
    const tracker = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(tracker.track({ number })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
