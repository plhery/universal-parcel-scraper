import { describe, expect, it, vi } from 'vitest';
import { adapter, JdLogisticsTracker } from './adapter.js';
import { jdDomesticBrowser, JD_DOMESTIC_PROXY, JD_DOMESTIC_TRACK, parseJdDomestic } from './domestic.js';
import { TrawlClient } from '../../core/transport/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';

const NUMBER = 'JDJ146283975062', OTHER = 'JDJ257394086173';
const history = () => ({ code: 1, obj: [{ rawWaybillCode: NUMBER, exists: true, receiverName: 'PRIVATE',
  traceAllVoList: [{ categoryName: 'Delivered', traceVoList: [
    { operateMessage: '已签收，签收人：PRIVATE', createTime: '2026-04-03 12:30:00', trackDay: '1999-01-01', trackTime: '01:00', state: '9' },
    { operateMessage: 'In transit', trackDay: '2026-04-02', trackTime: '10:20', attachment: 'PRIVATE' },
  ] }] }] });
const empty = () => new Response(JSON.stringify({ code: 1, data: [] }));
function client(body: unknown = history(), extra = {}) {
  const trawl = new TrawlClient('https://browser.test');
  const scrape = vi.spyOn(trawl, 'scrape').mockResolvedValue({ tier: 3, statusCode: 200, capturedResponses: [{
    url: JD_DOMESTIC_TRACK, status: 200, body: JSON.stringify(body), headers: {}, truncated: false,
    base64Encoded: false, error: null, trackingNumberSubmitted: NUMBER, ...extra,
  }] } as never);
  return { trawl, scrape };
}

describe('JD domestic history', () => {
  it('binds the whole shipment, retains clocks and removes contact/recipient fields', () => {
    const result = parseJdDomestic(history(), NUMBER);
    expect(result.events).toHaveLength(2);
    expect(result.events?.[0]).toMatchObject({ description: '已签收', local_time: '2026-04-03T12:30:00', provider_code: '9' });
    expect(result.events?.[1]).toMatchObject({ description: 'In transit', local_time: '2026-04-02T10:20:00' });
    expect(result.last_update).toBeNull(); expect(result.last_update_local).toBe('2026-04-03T12:30:00');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('preserves a stated offset and an epoch instead of guessing the locale as its zone', () => {
    const data = history(); data.obj[0]!.traceAllVoList[0]!.traceVoList[0]!.createTime = '2026-04-03T12:30:00+03:00';
    expect(parseJdDomestic(data, NUMBER).events?.[0]?.time).toBe('2026-04-03T12:30:00+03:00');
    data.obj[0]!.traceAllVoList[0]!.traceVoList = [
      { operateMessage: 'Older', createTime: Date.parse('2026-04-02T10:00Z') },
      { operateMessage: 'Newest', createTime: Date.parse('2026-04-03T10:00Z') },
    ] as never;
    expect(parseJdDomestic(data, NUMBER).events?.map(e => e.description)).toEqual(['Newest', 'Older']);
  });

  it('does not turn an older courier-first row into the group\'s current delivered status', () => {
    const data = history();
    data.obj[0]!.traceAllVoList[0]!.traceVoList[1]!.operateMessage = '配送员PRIVATE正在为您派送，联系电话PRIVATE';
    const event = parseJdDomestic(data, NUMBER).events![1]!;
    expect(event.description).toBe('正在为您派送'); expect(event.stage).not.toBe('delivered');
    expect(JSON.stringify(event)).not.toContain('PRIVATE');
  });

  it('refuses wrong identities, multiple records and malformed or omitted rows', () => {
    const wrong = history(); wrong.obj[0]!.rawWaybillCode = OTHER;
    expect(() => parseJdDomestic(wrong, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const multi = history(); multi.obj.push(multi.obj[0]!);
    expect(() => parseJdDomestic(multi, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const bad = history(); bad.obj[0]!.traceAllVoList[0]!.traceVoList[0]!.createTime = '2026-02-30 12:00:00';
    expect(() => parseJdDomestic(bad, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const blank = history(); blank.obj[0]!.traceAllVoList[0]!.traceVoList[0]!.operateMessage = '';
    expect(() => parseJdDomestic(blank, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps a session error or empty result inconclusive and requires a bound explicit missing verdict', () => {
    for (const data of [{ code: -200010, obj: [] }, { code: 1, obj: [] }]) {
      expect(() => parseJdDomestic(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => parseJdDomestic({ code: 1, obj: [{ rawWaybillCode: NUMBER, exists: false }] }, NUMBER))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    const empty = history(); empty.obj[0]!.traceAllVoList = [];
    expect(() => parseJdDomestic(empty, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('marks a bounded long history partial rather than hiding the omitted scans', () => {
    const data = history(); data.obj[0]!.traceAllVoList[0]!.traceVoList = Array.from({ length: 101 }, (_, i) =>
      ({ operateMessage: `Synthetic step ${i}`, createTime: '2026-04-03 12:00:00' })) as never;
    expect(parseJdDomestic(data, NUMBER)).toMatchObject({ history_truncated: true, events: expect.any(Array) });
    expect(parseJdDomestic(data, NUMBER).events).toHaveLength(100);
  });
});

describe('JD domestic recovery boundaries', () => {
  it('uses the browser only after an inconclusive international answer for a supported domestic shape', async () => {
    const { trawl, scrape } = client();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => empty());
    const result = await new JdLogisticsTracker({ trawl, fetcher }).fetch(NUMBER);
    expect(result.events).toHaveLength(2); expect(fetcher).toHaveBeenCalledTimes(1); expect(scrape).toHaveBeenCalledTimes(1);
    expect(scrape.mock.calls[0]?.[0]).toMatchObject({ captureResponses: [JD_DOMESTIC_TRACK, JD_DOMESTIC_PROXY], skipHttp: true });
  });

  it('an abstention preserves a challenge for the provider fallback without another JD call', async () => {
    const { trawl, scrape } = client();
    scrape.mockResolvedValue({ tier: 3, statusCode: 200, capturedResponses: [{ url: 'https://www.jdl.com/orderSearch/', status: 200,
      body: null, headers: {}, truncated: false, base64Encoded: false, error: 'jd-domestic-unreadable' }] } as never);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => empty());
    await expect(new JdLogisticsTracker({ trawl, fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge', reason: 'verification_unreadable' });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(scrape).toHaveBeenCalledTimes(1);
  });

  it('an older browser service or failed page setup stays a transport failure, not a false site challenge', async () => {
    const { trawl, scrape } = client();
    for (const capturedResponses of [[], [{ url: 'https://www.jdl.com/orderSearch/', status: 200, error: 'jd-domestic-unprepared' }]]) {
      scrape.mockResolvedValue({ tier: 3, statusCode: 200, capturedResponses } as never);
      await expect(jdDomesticBrowser(trawl, NUMBER, new AbortController().signal, 20000)).rejects.toMatchObject({ kind: 'transport' });
    }
  });

  it('a matching international answer takes precedence without any browser request', async () => {
    const { trawl, scrape } = client();
    const data = { code: 1, data: [{ waybillNo: NUMBER, waybillNum: 1, wayBillTrackItemDtoList: [{ waybillNo: NUMBER,
      trackNodeList: [{ operatorTime: '2026-04-03T12:00:00+08:00', operatorDesc: 'In transit' }] }] }] };
    const result = await new JdLogisticsTracker({ trawl, fetcher: async () => new Response(JSON.stringify(data)) }).fetch(NUMBER);
    expect(result.events).toHaveLength(1); expect(scrape).not.toHaveBeenCalled();
  });

  it('never changes an international answer or runs a browser on an unrelated shape or HTTP recognition', async () => {
    const { trawl, scrape } = client();
    const factory = adapter({ trawl, fetcher: async () => empty(), recorder: NOOP_RECORDER, env: {}, browserExecutablePath: null });
    await expect(factory.recognize!(NUMBER, {})).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(scrape).not.toHaveBeenCalled();
    await expect(new JdLogisticsTracker({ trawl, fetcher: async () => empty() }).fetch('JDW146283975062'))
      .rejects.toMatchObject({ reason: 'portal_not_found' });
    expect(scrape).not.toHaveBeenCalled();
  });

  it('refuses an unbound capture and keeps a later refusal instead of an earlier history', async () => {
    const { trawl, scrape } = client(history(), { trackingNumberSubmitted: OTHER });
    await expect(jdDomesticBrowser(trawl, NUMBER, new AbortController().signal, 20000)).rejects.toMatchObject({ kind: 'schema' });
    scrape.mockResolvedValue({ tier: 3, statusCode: 200, capturedResponses: [
      { url: JD_DOMESTIC_TRACK, status: 200, body: JSON.stringify(history()), trackingNumberSubmitted: NUMBER },
      { url: JD_DOMESTIC_TRACK, status: 403, body: null, trackingNumberSubmitted: NUMBER },
    ] } as never);
    await expect(jdDomesticBrowser(trawl, NUMBER, new AbortController().signal, 20000)).rejects.toMatchObject({ kind: 'challenge' });
  });
});
