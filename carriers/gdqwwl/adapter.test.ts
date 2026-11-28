import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, QUANWANG_FORM, QUANWANG_SERVICE } from './adapter.js';
import { normalizeQuanwangNumber, parseQuanwang, parseQuanwangForm } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const delivered = fixture('delivered.html');
const notFound = fixture('not-found.html');
const number = '190423000281';
// Synthetic: the tracker's form cut down to the references its button posts.
const formPage = `<html><head><title>查货参数_输入</title></head><body><form id="theForm" method="POST">
<input type="hidden" name="ViewState" id="ViewState" value="%(pBd9SZS47y8vB4gZ3TDquuVR)" />
<input type="hidden" name="Action" id="Action" value="%(elK4qxR4S0vdSCwop1)" />
<input type="text" id="BG_Code" name="TB_FS_BG_Code" xname="BG_Code" />
<input type="text" id="LK_Code" name="TB_FS_LK_Code" xname="LK_Code" />
<script type="text/javascript">function OnClick_BN_1006(x) { SubmitExec('%(vh50b_A0MybRosmLr6b6dhoyO7u0nn2uFf_hl3)'); }</script>
</form></body></html>`;
const tracker = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const page = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

describe('Quanwang waybill numbers', () => {
  it('takes one waybill in letters and digits', () => {
    expect(normalizeQuanwangNumber(' 1904 2300 0281 ')).toBe(number);
    expect(normalizeQuanwangNumber('01803566')).toBe('01803566');
    for (const raw of ['12345', 'QUANWANG', `${number}/x`, '1'.repeat(21)]) {
      expect(() => normalizeQuanwangNumber(raw)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('Quanwang tracker', () => {
  it('reads the form\'s references, then posts them with the number', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(page(formPage)).mockResolvedValueOnce(page(delivered));
    const result = await tracker(fetcher).track({ number });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]![0])).toBe(QUANWANG_FORM);
    const [url, init] = fetcher.mock.calls[1]!;
    expect(String(url)).toBe(QUANWANG_SERVICE);
    expect(init?.method).toBe('POST');
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
      ViewState: '%(pBd9SZS47y8vB4gZ3TDquuVR)', Action: '%(elK4qxR4S0vdSCwop1)', TB_FS_BG_Code: number, TB_FS_LK_Code: '',
      _Source_: '%(vh50b_A0MybRosmLr6b6dhoyO7u0nn2uFf_hl3)',
    });
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '货物已签收', last_update: null, last_update_local: '2019-04-26T09:01:44', destination_country: 'CN',
    });
  });

  it('reads the rows newest first on their wall clock, without the people they name', () => {
    const { events = [] } = parseQuanwang(delivered, number);
    expect(events.map((event) => [event.local_time, event.description, event.location, event.stage])).toEqual([
      ['2019-04-26T09:01:44', '货物已签收', undefined, 'delivered'],
      ['2019-04-25T19:01:17', '货物正在派送中', undefined, 'out_for_delivery'],
      ['2019-04-25T18:00:56', '货物已到达嘉兴市', '嘉兴市', 'in_transit'],
      ['2019-04-23T14:30:19', '发货离开全网物流', undefined, 'in_transit'],
      ['2019-04-23T14:12:06', '在弗兰特收货', undefined, 'accepted'],
    ]);
    expect(JSON.stringify(events)).not.toContain('某某');
    expect(events.some((event) => event.time)).toBe(false);
    // Synthetic: a phone in a row is left out with the person it belongs to.
    const called = delivered.replace('货物正在派送中', '货物正在派送中，派送员：某某 13800000000');
    expect(parseQuanwang(called, number).events?.[1]?.description).toBe('货物正在派送中');
  });

  it('stages every recorded wording by the map, for any place', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, entry.wording.replaceAll('{place}', '杭州市'))).toBe(entry.stage);
  });

  it('takes the hand-written number the waybill carries as the same waybill', () => {
    expect(parseQuanwang(delivered, '01803566')).toMatchObject({ status: 'delivered' });
    expect(() => parseQuanwang(delivered, '190423000282')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reports the empty waybill page as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(page(formPage)).mockResolvedValueOnce(page(notFound));
    await expect(tracker(fetcher).track({ number: '000000000000' })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('reads the form\'s references and refuses a form without them', () => {
    expect(parseQuanwangForm(formPage)).toEqual({ viewState: '%(pBd9SZS47y8vB4gZ3TDquuVR)', action: '%(elK4qxR4S0vdSCwop1)',
      source: '%(vh50b_A0MybRosmLr6b6dhoyO7u0nn2uFf_hl3)' });
    expect(() => parseQuanwangForm(formPage.replace(/SubmitExec\('[^']*'\)/, ''))).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('does not take a failure, a changed page or a verification page for a missing waybill', async () => {
    expect(() => parseQuanwang(delivered.replace('2019-04-26&#32;09:01:44', '26/04/2019 09:01'), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseQuanwang(delivered.replace(/xname="运单编号"/, 'xname="编号"'), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseQuanwang(notFound.replace('</tbody>', '<tr onmousedown="OnRowSelector(this)"><td class="celler">1</td><td class="celler">2019-04-23&#32;14:12:06</td><td class="celler">x</td></tr></tbody>'), number))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseQuanwang('<html><head><title>错误</title></head></html>', number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const empty = delivered.replace(/<tbody>[\s\S]*<\/tbody>/, '<tbody></tbody>');
    expect(() => parseQuanwang(empty, number)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    const challenged = vi.fn<typeof fetch>().mockResolvedValueOnce(page('<html><head><title>Just a moment...</title></head></html>', 403));
    await expect(tracker(challenged).track({ number })).rejects.toMatchObject({ kind: 'challenge' });
    const blocked = vi.fn<typeof fetch>().mockResolvedValueOnce(page(formPage)).mockResolvedValueOnce(page('<html><body>请输入验证码</body></html>'));
    await expect(tracker(blocked).track({ number })).rejects.toMatchObject({ kind: 'challenge' });
    const down = vi.fn<typeof fetch>().mockResolvedValueOnce(page('<html><body>Service Unavailable</body></html>', 503));
    await expect(tracker(down).track({ number })).rejects.toMatchObject({ kind: 'transport' });
    const other = vi.fn<typeof fetch>().mockResolvedValueOnce(page(formPage)).mockResolvedValueOnce(page('<html><head><title>系统错误</title></head></html>'));
    await expect(tracker(other).track({ number })).rejects.toMatchObject({ kind: 'schema' });
  });
});
