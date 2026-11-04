import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeJunfengInternationalNumber, parseJunfengInternational } from './parser.js';
import { junfengInternationalStage, statusMap } from './status.js';

const NUMBER = 'IW864209751GB';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/tracking.json', import.meta.url), 'utf8'));

describe('JunFeng International history', () => {
  it('binds the postal identity and forwarding leg, retaining overseas and China clocks in source order', () => {
    const result = parseJunfengInternational(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null, last_update_local: '2026-07-04T10:20:30' });
    expect(result.events).toHaveLength(5);
    expect(result.events![0]).toMatchObject({ location: 'Example PFW Depot', stage: 'delivered' });
    expect(result.events![3]).not.toHaveProperty('stage');
    expect(result.events![4]).toMatchObject({ local_time: '2026-07-02T12:00:00', stage: 'in_transit' });
    expect(result.events!.every(event => !event.time && !event.provider_code)).toBe(true);
    expect(result).not.toHaveProperty('delivery_carrier'); expect(result).not.toHaveProperty('destination_country');
    expect(JSON.stringify(result)).not.toContain('12345');
  });

  it('requires forwarding evidence rather than claiming any partner-only postal history', () => {
    const data = fixture(), row = data.data.TrackInfo.Data.dataList[0];
    // A schedule alongside the partner's scans still does not establish custody.
    row.Data.Destination = row.Data.Destination.slice(0, 4);
    expect(() => parseJunfengInternational(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'unsupported_service' }));
    row.Data.Destination = []; row.Data.TheSenderTo = []; row.Data.Result = '-1'; row.LatestStatus = null;
    expect(() => parseJunfengInternational(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    row.outwaybillCode += '0';
    expect(() => parseJunfengInternational(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps flight plans unstaged and first-mile airport delivery distinct from a final delivery round', () => {
    expect(statusMap.gapNote!(null, '头程航班预计03日13:40起飞')).toBeTruthy();
    expect(junfengInternationalStage('已发货，司机正在送到机场')).toBe('in_transit');
    expect(junfengInternationalStage('清关完成，已交邮')).toBe('in_transit');
    expect(junfengInternationalStage('航司载量不足，头程延误，航班预配中')).toBe('exception');
    const data = fixture(), row = data.data.TrackInfo.Data.dataList[0];
    row.Data.Destination.unshift({ Date: '2026-07-05 09:00:00', Details: '头程航班预计06日13:40起飞' });
    row.LatestStatus = row.Data.Destination[0].Details;
    expect(parseJunfengInternational(data, NUMBER).status).toBe('unknown');
  });

  it('rejects multiple records, unsupported extra history, changed summaries and malformed rows', () => {
    for (const mutate of [
      (p: ReturnType<typeof fixture>) => { p.data.TrackInfo.Data.dataList.push(p.data.TrackInfo.Data.dataList[0]); },
      (p: ReturnType<typeof fixture>) => { p.data.TrackInfo.Data.dataList[0].LatestStatus = 'Different activity'; },
      (p: ReturnType<typeof fixture>) => { p.data.TrackInfo.Data.dataList[0].Data.TheSenderTo = [{ Date: '2026-07-01' }]; },
      (p: ReturnType<typeof fixture>) => { p.data.TrackInfo.Data.dataList[0].Data.Destination[0].Date = '2026-02-30 10:20:30'; },
    ]) {
      const data = fixture(); mutate(data);
      expect(() => parseJunfengInternational(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(normalizeJunfengInternationalNumber(' iw 864209751 gb ')).toBe(NUMBER);
    expect(() => normalizeJunfengInternationalNumber('IW864209752GB')).toThrow(expect.objectContaining({ reason: 'unsupported_reference' }));
  });
});
