import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseWangjing } from './parser.js';
import { wangjingStage } from './status.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');

function tracker(reply: () => Response) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string | URL, init: RequestInit = {}) => {
    requests.push({ url: String(url), init });
    return reply();
  }) as typeof fetch;
  return { requests, track: adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null, fetcher }) };
}

describe('Wangjing 3CQ tracking', () => {
  it('reads a delivered parcel from the China warehouse to J&T Express Brazil, on the clocks 3CQ states', () => {
    const result = parseWangjing(fixture('delivered-contagem'), '888002598569574', 200);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', provider_code: '100',
      last_update: '2026-11-09T19:12:15+08:00', delivered_at: '2026-11-09T19:12:15+08:00',
    });
    expect(result.last_status_text).toMatch(/^【Contagem】Recceived！/);
    expect(result.events).toHaveLength(40);
    expect(result.events![1]).toMatchObject({ provider_code: '94', stage: 'out_for_delivery', location: 'JDI-MG' });
    expect(result.events!.at(-1)).toMatchObject({
      time: '2026-09-21T17:06:19+08:00', location: 'China', stage: 'registered', stage_source: 'carrier_map',
      description: 'As informações sobre a encomenda foram recebidas',
    });
    // The air waybill's flights, without a code, read by their recorded wording.
    expect(result.events!.find((event) => event.description === 'Departed from DOH on QR8174/04-Oct-2026'))
      .toMatchObject({ stage: 'in_transit', stage_source: 'carrier_map', location: 'DOH' });
    // A time to the microsecond keeps its stated offset.
    expect(result.events!.find((event) => event.description === 'Objeto postado')).toMatchObject({ time: '2026-10-02T16:45:09.585+08:00' });
    const times = result.events!.map((event) => Date.parse(event.time!));
    expect(times).toEqual([...times].sort((left, right) => right - left));
  });

  it('reads one code by its wording where 3CQ gives it two stages', () => {
    const result = parseWangjing(fixture('delivered-contagem'), '888002598569574', 200);
    const coded = (code: string) => result.events!.filter((event) => event.provider_code === code).map((event) => event.stage);
    expect(coded('610')).toEqual(['customs', 'in_transit']);
    expect(coded('620')).toEqual(['customs']);
    // A wording not recorded for a code that has one stage keeps the code's stage.
    expect(wangjingStage('90', '【Example】Arrival at another centre')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(wangjingStage('610', 'Synthetic customs wording')?.source).not.toBe('carrier_map');
  });

  it('reads a second public parcel delivered in São Paulo', () => {
    const result = parseWangjing(fixture('delivered-sao-paulo'), '888002507522830', 200);
    expect(result).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-09-18T23:15:16+08:00' });
    expect(result.events).toHaveLength(36);
    expect(result.events!.every((event) => event.stage)).toBe(true);
  });

  it('rejects a reply for another number', () => {
    expect(() => parseWangjing(fixture('delivered-contagem'), '888002507522830', 200))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads the empty history the page shows for an unknown number as not found, and no other reply', () => {
    expect(() => parseWangjing(fixture('not-found'), '888002123456789', 200)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const refused = JSON.stringify({ data: null, resultCode: 500, resultMsg: 'Example failure' });
    expect(() => parseWangjing(refused, '888002123456789', 200)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseWangjing('{"data":null,"resultCode":0,"resultMsg":"OK"}', '888002123456789', 200))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('never reads a blocked or malformed reply as not found', () => {
    const page = '<html><head><title>Just a moment...</title></head><body>cf-turnstile</body></html>';
    expect(() => parseWangjing(page, '888002598569574', 200)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    const aliyun = '<!doctype html><html><script>var acw_sc__v2="x"</script></html>';
    expect(() => parseWangjing(aliyun, '888002598569574', 200)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    // The application shell, as the tracker serves it for any unknown path.
    expect(() => parseWangjing('<!doctype html><html><div id="app"></div></html>', '888002598569574', 200))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseWangjing('<html>Bad gateway</html>', '888002598569574', 502)).toThrow(expect.objectContaining({ kind: 'indeterminate', status: 502 }));
    const timeless = fixture('delivered-contagem').replace('"2026-11-09T19:12:15+08:00"', '"2026-11-09 19:12:15"');
    expect(() => parseWangjing(timeless, '888002598569574', 200)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('posts the number as the tracking page does and keeps HTTP failures apart from not found', async () => {
    const json = (body: string, status = 200) => () => new Response(body, { status, headers: { 'content-type': 'application/json' } });
    const found = tracker(json(fixture('delivered-contagem')));
    await expect(found.track.track({ number: ' 888002 598569574 ' })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(found.requests).toHaveLength(1);
    expect(found.requests[0]).toMatchObject({ url: 'https://track.wjdrop.com/api/tracking/list', init: { method: 'POST' } });
    expect(JSON.parse(String(found.requests[0]!.init.body))).toEqual({ trackingNumbers: ['888002598569574'] });

    const unknown = tracker(json(fixture('not-found')));
    await expect(unknown.track.track({ number: '888002123456789' })).rejects.toMatchObject({ kind: 'not_found' });
    const limited = tracker(() => new Response('Too many requests', { status: 429 }));
    await expect(limited.track.track({ number: '888002598569574' })).rejects.toMatchObject({ kind: 'rate_limited' });
    const refused = tracker(() => new Response('<html>Forbidden</html>', { status: 403 }));
    await expect(refused.track.track({ number: '888002598569574' })).rejects.toMatchObject({ kind: 'challenge' });
    const moved = tracker(() => new Response('<html>Not Found</html>', { status: 404 }));
    await expect(moved.track.track({ number: '888002598569574' })).rejects.toMatchObject({ kind: 'transport' });
    await expect(found.track.track({ number: '8880' })).rejects.toMatchObject({ kind: 'invalid_input' });
  });
});
