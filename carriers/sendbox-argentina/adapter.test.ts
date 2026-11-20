import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { endpoint, parseFormState, parseTracking, portal } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const number = numbers.records[0]!.number;
const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8');

it('posts both guide components and returns a delivery summary without a scan date', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(fixture('form.html')))
    .mockResolvedValueOnce(new Response(fixture('delivered.json')));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('sendbox-argentina', number) });
  expect(fetcher).toHaveBeenNthCalledWith(1, portal, expect.any(Object));
  expect(fetcher).toHaveBeenNthCalledWith(2, endpoint, expect.objectContaining({
    method: 'POST',
    body: new URLSearchParams({
      action: 'seguimiento_bfg', nonce: '123456abcd', vPrefijoGuia: '0117', vNroGuia: '00443416', vNroControl: '0',
    }),
  }));
  expect(result).toMatchObject({
    status: 'delivered', current_stage: 'delivered', last_status_text: 'Entregado', summary_only: true, events: [],
  });
  expect(result).not.toHaveProperty('last_update');
  expect(result).not.toHaveProperty('delivered_at');
});

it('distinguishes an empty guide reply, an invalid guest form and an unrelated result', () => {
  expect(() => parseTracking(fixture('missing.json'))).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking('{"error":"2","guia_fecha":"2026-06-25"}')).toThrow(expect.objectContaining({ kind: 'schema' }));
  expect(() => parseFormState('<title>Just a moment</title>')).toThrow(expect.objectContaining({ kind: 'challenge' }));
  expect(() => parseFormState(fixture('form.html').replace('www.sendbox.com.ar', 'unrelated.example')))
    .toThrow(expect.objectContaining({ kind: 'schema' }));
});
