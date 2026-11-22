import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { createTracker } from '../../facade/index.js';
import { FeibaoTracker } from './adapter.js';
import { FEIBAO_ENDPOINT, feibaoJson, normalizeFeibaoNumber, parseFeibao } from './parser.js';
import { statusMap } from './status.js';

const DELIVERED = '119033244150';
const OUT = 'F00002866447';
const TWICE = 'F00002864814';
const raw = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
type Row = Record<string, unknown>;
type Reply = { track: { ConsignID: string; GoodsTrackObject: Row[] }[] };
const fixture = (name: string) => JSON.parse(raw(name)) as Reply;
const edited = (edit: (reply: Reply) => void) => { const reply = fixture('delivered.json'); edit(reply); return reply; };
const rows = (reply: Reply) => reply.track[0]!.GoodsTrackObject;
const response = (body: string, status = 200) => new Response(body, { status });

describe('Feibao Logistics guest adapter', () => {
  it('posts the waybill with an empty code as the tracking page does, with no session or captcha', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('delivered.json')));
    const result = await new FeibaoTracker({ fetcher, userAgent: 'SyntheticHost/1' }).fetch(' 1190 3324 4150 ', { budgetMs: 5000 });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(FEIBAO_ENDPOINT);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', body: `code=&word=${DELIVERED}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': 'SyntheticHost/1' } });
    expect(new Headers(init!.headers).get('referer')).toContain(`word=${DELIVERED}`);
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: '已签收',
      last_update: '2026-09-28T16:08:37+08:00' });
  });

  it('words the rows as the page does, with instants and stations and without the signatory or the recipient', () => {
    const result = parseFeibao(fixture('delivered.json'), DELIVERED);
    expect(result.events!.map(event => [event.time, event.provider_code, event.location, event.stage, event.description])).toEqual([
      ['2026-09-28T16:08:37+08:00', '4', undefined, 'delivered', '已签收'],
      ['2026-09-28T11:17:49+08:00', '3', '江苏省徐州市新沂市', 'out_for_delivery', '正在送货'],
      ['2026-09-27T17:34:01+08:00', '1', '江苏省徐州市新沂市', 'in_transit', '快件已到达【江苏省徐州市新沂市】'],
      ['2026-09-24T16:28:36+08:00', '2', '北京分拨中心', 'in_transit', '由【北京分拨中心】发往【江苏省徐州市新沂市】'],
      ['2026-09-24T09:13:32+08:00', '1', '北京分拨中心', 'in_transit', '快件已到达【北京分拨中心】'],
      ['2026-09-23T18:45:09+08:00', '2', '北京项目三部C', 'in_transit', '由【北京项目三部C】发往【北京分拨中心】'],
      ['2026-09-23T15:59:02+08:00', '1', '北京项目三部C', 'in_transit', '快件已到达【北京项目三部C】'],
    ]);
    expect(result.events!.every(event => event.time && !event.local_time)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/张\*\*|收件人|寄件人|13800000000/);
  });

  it('keeps the page\'s out-for-delivery row without the driver and both signature rows', () => {
    const driven = edited(reply => { Object.assign(rows(reply)[5]!, { DriverMan: '司机甲', DriverTelephone: '13900000000' }); });
    expect(parseFeibao(driven, DELIVERED).events![1]).toMatchObject({ description: '正在送货', location: '江苏省徐州市新沂市' });
    expect(JSON.stringify(parseFeibao(driven, DELIVERED))).not.toMatch(/司机|13900000000/);
    expect(parseFeibao(fixture('out-for-delivery.json'), OUT)).toMatchObject({ status: 'out_for_delivery', last_status_text: '正在送货 · 白沙分部' });
    const twice = parseFeibao(fixture('signed-twice.json'), TWICE);
    expect(twice.events!.slice(0, 2).map(event => [event.time, event.description])).toEqual([
      ['2026-08-08T16:20:37+08:00', '已签收'], ['2026-08-08T16:20:06+08:00', '已签收']]);
  });

  it('reports an unknown waybill as not found and requires the whole waybill', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('not-found.json')));
    await expect(new FeibaoTracker({ fetcher }).fetch('F99999999990')).rejects.toMatchObject({ kind: 'not_found' });
    for (const reply of [edited(reply => { reply.track[0]!.ConsignID = '119033244151'; }),
      edited(reply => { rows(reply)[2]!.ConsignID = '119033244151'; }),
      edited(reply => { reply.track.push(reply.track[0]!); }),
      edited(reply => { rows(reply)[2]!.operTime = '2026-09-24 09:13:32'; }),
      edited(reply => { rows(reply)[2]!.Status = '1'; }),
      edited(reply => { (reply as Record<string, unknown>).track = {}; })]) {
      expect(() => parseFeibao(reply, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseFeibao(edited(reply => { rows(reply).forEach(row => { row.BillType = 1; }); }), DELIVERED))
      .toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(normalizeFeibaoNumber('f00002866447')).toBe(OUT);
    for (const number of ['F0000286644', '11903324415', 'FW00002866447', '1190332441500']) {
      expect(() => normalizeFeibaoNumber(number)).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('keeps captcha codes, checks and malformed replies distinct', async () => {
    expect(() => feibaoJson('1')).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    expect(() => feibaoJson('<html><title>Just a moment...</title></html>')).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    expect(() => feibaoJson('<html>maintenance</html>')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const [status, kind] of [[403, 'challenge'], [404, 'transport'], [429, 'rate_limited']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('{}', status));
      await expect(new FeibaoTracker({ fetcher }).fetch(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it('maps the statuses and leaves others without a stage', () => {
    expect(statusMap.stage('4', '')).toBe('delivered');
    expect(statusMap.stage('5', '')).toBe('exception');
    expect(statusMap.stage('99', '')).toBeUndefined();
    const result = parseFeibao(edited(reply => {
      rows(reply).push({ ...rows(reply).at(-1)!, Status: 99, StationName: '新沂市', Remark: '客户要求改期', operTime: '/Date(1790590000000)/' });
    }), DELIVERED);
    expect(result.events![0]).toMatchObject({ provider_code: '99', description: '客户要求改期', location: '新沂市' });
    expect(result.events![0]!.stage).toBeUndefined();
    expect(result).toMatchObject({ status: 'unknown', last_status_text: '客户要求改期 · 新沂市' });
  });

  it('is not detected and tracks on explicit selection', async () => {
    expect(detectCarrierMatch(DELIVERED).candidates ?? []).not.toContain('feibao-logistics');
    expect(detectCarrierMatch(OUT).candidates ?? []).not.toContain('feibao-logistics');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('delivered.json')));
    const tracked = await createTracker({ fetcher, env: {}, providers: [] }).track({ carrier: 'feibao-logistics', number: DELIVERED });
    expect(tracked.source).toBe('feibao-logistics');
    expect(tracked.result.status).toBe('delivered');
  });
});
