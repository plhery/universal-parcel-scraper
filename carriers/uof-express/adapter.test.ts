import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import samples from './numbers.json' with { type: 'json' };

const number = samples.records[0]!.number;
const delivered = readFileSync(new URL('./fixtures/china-japan.jsonp', import.meta.url), 'utf8');

function trackWith(body: string, status = 200) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(body, { status }));
  const tracker = adapter({ env: {}, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null, fetcher });
  return { fetcher, tracker };
}

describe('UOF International tracking', () => {
  it('reads the carrier’s history through explicit selection, with unzoned scan clocks', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(delivered));
    const tracker = createTracker({ fetcher, providers: [], env: {}, userAgent: 'UOF adapter test' });

    const reply = await tracker.track({ number, carrier: 'uof-express' }, { budgetMs: 3_000 });
    expect(reply).toMatchObject({
      source: 'uof-express',
      carrier: 'uof-express',
      result: {
        status: 'delivered',
        current_stage: 'delivered',
        last_status_text: '配达完了',
        last_update: '2022-07-25T14:18:27+09:00',
        last_update_local: '2022-07-25T14:18:27',
        destination_country: 'JP',
      },
    });
    expect(reply.result.events).toHaveLength(9);
    expect(reply.result.events[0]).toMatchObject({
      local_time: '2022-07-25T14:18:27', description: '配达完了', location: '日本', stage: 'delivered',
    });
    expect(reply.result.planned_events).toEqual([
      { description: '通関予定7/23', location: '日本', local_time: '2022-07-21T11:08:59' },
    ]);
    expect(reply.result.events[2]).toMatchObject({ description: '資料検査', stage_source: 'none' });

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, request] = fetcher.mock.calls[0]!;
    const lookup = new URL(String(url));
    expect(lookup.origin + lookup.pathname).toBe('https://oms.uofexp.com/webservice/Service.ashx');
    expect(lookup.searchParams.get('method')).toBe('track');
    expect(lookup.searchParams.get('callbackparam')).toBe('trackingCallback');
    const param = lookup.searchParams.get('param')!;
    expect(JSON.parse(param)).toEqual({ sp: '', nums: [number] });
    expect(Buffer.from(lookup.searchParams.get('key')!, 'base64').toString()).toBe('0800934115594b9574d93edb27875c9c');
    expect(new Headers(request?.headers).get('user-agent')).toBe('UOF adapter test');
    expect(request?.redirect).toBe('manual');
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects a response whose waybill only starts with the requested number', async () => {
    const { tracker } = trackWith(delivered.replaceAll(number, number + 'X'));
    await expect(tracker.track({ number })).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([
    ['trackingCallback({"success":0,"enmessage":"No query to track information"})', 200, 'not_found'],
    ['trackingCallback({"success":0,"enmessage":"Parameter error"})', 200, 'schema'],
    ['trackingCallback({"success":1,"data":[]})', 200, 'schema'],
    ['<title>Just a moment...</title>', 200, 'challenge'],
    ['Not Found', 404, 'transport'],
    ['Too Many Requests', 429, 'rate_limited'],
  ])('keeps lookup failures distinct (HTTP %s %s)', async (body, status, kind) => {
    const { tracker } = trackWith(body, status);
    await expect(tracker.track({ number })).rejects.toMatchObject({ kind });
  });

  it('rejects invalid input before requesting the tracker', async () => {
    const { fetcher, tracker } = trackWith(delivered);
    await expect(tracker.track({ number: '///' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
