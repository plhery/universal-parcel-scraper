import { describe, expect, it } from 'vitest';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { DETAIL_SCANS, fixture, NUMBER } from '../../testing/seinoSuperExpressFixture.js';
import { parseSeinoSuperExpressPage, seinoSuperExpressSummaryBody } from './parser.js';

describe('Seino Super Express guest HTML', () => {
  it('binds the padded whole slip and builds fresh private detail state', () => {
    const page = parseSeinoSuperExpressPage(fixture(), NUMBER, 'summary');
    expect(page.result).toMatchObject({ current_stage: 'delivered', last_update: null, history_truncated: true });
    expect(page.result.events?.map(e => e.provider_time_text)).toEqual(['01/01 00:11', '12/31 23:50']);
    expect(page.detailBody?.get('strDenpyoNo')).toBe(NUMBER.padStart(15, '0'));
    expect(page.detailBody?.get('strNinsyoNo')).toBe('SYNTHETICCAP');
    expect(page.detailBody?.get('uji.verbs')).toBe('NAHS0030_find');
    expect(JSON.stringify(page.result)).not.toMatch(/SYNTHETIC|strNinsyoNo|strSyukaTenCD|JSESSIONID|raw|vehicle|staff|phone/i);
  });

  it('preserves source order and month/day clocks across New Year without inventing a year', () => {
    const result = parseSeinoSuperExpressPage(fixture('detail'), NUMBER, 'detail').result;
    expect(result.events?.map(e => [e.provider_time_text, e.stage])).toEqual([
      ['01/01 00:10', 'delivered'], ['12/31 23:59', 'in_transit'], ['12/31 23:50', 'accepted'],
    ]);
    expect(result.events?.every(e => e.time === undefined && e.local_time === undefined)).toBe(true);
    expect(result).not.toHaveProperty('last_update_local');
    expect(result).not.toHaveProperty('delivered_at');
  });

  it.each(['1234567890', '0001234567890', '000001234567890'])('accepts the official zero-padding equivalence: %s', number => {
    expect(parseSeinoSuperExpressPage(fixture(), number, 'summary').result.events).toHaveLength(2);
  });

  it('only treats the exact notice inside the matching result as not registered', () => {
    expect(() => parseSeinoSuperExpressPage(fixture('summary', { missing: true }), NUMBER, 'summary')).toThrow(NotFoundError);
    expect(() => parseSeinoSuperExpressPage(fixture('summary', { missing: true, number: '9876543210' }), NUMBER, 'summary')).toThrow(SchemaError);
    const misleading = fixture().replace('</body>', '<p>お問い合わせの伝票番号は登録されておりません。</p></body>');
    expect(parseSeinoSuperExpressPage(misleading, NUMBER, 'summary').result.events).toHaveLength(2);
    expect(() => parseSeinoSuperExpressPage(fixture('summary', { missing: true }).replace('登録されておりません', '現在システムを利用できません'), NUMBER, 'summary')).toThrow(SchemaError);
  });

  it('does not turn a missing detail reply after a found slip into parcel absence', () => {
    expect(() => parseSeinoSuperExpressPage(fixture('detail', { missing: true }), NUMBER, 'detail')).toThrow(NoHistoryError);
  });

  it.each([
    (h: string) => h.replace(NUMBER.padStart(15, '0'), '000009876543210'),
    (h: string) => h.replace("nahs0030find('000001234567890'", "nahs0030find('000009876543210'"),
    (h: string) => h.replace('class="table-typeB col-xs-12"', 'hidden class="table-typeB col-xs-12"'),
    (h: string) => h.replace('action="Main.jsp"', 'action="https://example.invalid/collect"'),
    (h: string) => h.replace('href="javascript:void(0)"', 'hidden href="javascript:void(0)"'),
    (h: string) => h.replace('rowspan="2"', 'rowspan="3"'),
    (h: string) => h.replace('<th>営業所</th>', '<th>お届け先</th>'),
  ])('rejects unrelated, hidden or changed result structure', mutate => {
    expect(() => parseSeinoSuperExpressPage(mutate(fixture()), NUMBER, 'summary')).toThrow(SchemaError);
  });

  it.each([['04/31', '10:00'], ['01/02', '24:00'], ['01/02', '12:99'], ['', '10:00']])('rejects an invalid source clock %s %s', (day, clock) => {
    const scans = [...DETAIL_SCANS, { day, clock, wording: '運行' }];
    expect(() => parseSeinoSuperExpressPage(fixture('detail', { scans }), NUMBER, 'detail')).toThrow(SchemaError);
  });

  it('validates rows after the public output cap and preserves leap-day uncertainty', () => {
    const scans = Array.from({ length: 110 }, () => ({ day: '02/29', clock: '10:00', wording: '運行' }));
    expect(parseSeinoSuperExpressPage(fixture('detail', { scans }), NUMBER, 'detail').result.events).toHaveLength(100);
    scans[105] = { day: '02/30', clock: '10:00', wording: '運行' };
    expect(() => parseSeinoSuperExpressPage(fixture('detail', { scans }), NUMBER, 'detail')).toThrow(SchemaError);
  });

  it('keeps an unstaged update for an unrecognized status without exposing arbitrary prose', () => {
    const scans = [{ day: '03/04', clock: '10:00', wording: 'SYNTHETIC_RECIPIENT_NOTE' }];
    const result = parseSeinoSuperExpressPage(fixture('detail', { scans }), NUMBER, 'detail').result;
    expect(result.events?.[0]).toMatchObject({ description: 'Tracking update' });
    expect(result.events?.[0]).not.toHaveProperty('stage');
    expect(JSON.stringify(result)).not.toContain('RECIPIENT');
  });

  it('returns a partial summary when the carrier supplies no detail action', () => {
    const page = parseSeinoSuperExpressPage(fixture('summary', { detail: false }), NUMBER, 'summary');
    expect(page.detailBody).toBeUndefined();
    expect(page.result.history_truncated).toBe(true);
  });

  it('flags populated estimate fields without interpreting their absent year', () => {
    expect(parseSeinoSuperExpressPage(fixture('summary', { designated: '01/04' }), NUMBER, 'summary').result.unread_estimates).toEqual(['summary.designated_day']);
  });

  it('recognizes a protected response before reading stale result markup', () => {
    expect(() => parseSeinoSuperExpressPage('<title>Just a moment</title>' + fixture(), NUMBER, 'summary')).toThrow(ChallengeError);
    expect(() => parseSeinoSuperExpressPage(fixture().replace('</form>', '<input name="captcha_code"></form>'), NUMBER, 'summary')).toThrow(ChallengeError);
  });

  it.each(['', '12345678901', 'AA123456789JP', '12345678901234', '1'.repeat(65)])('rejects an unsupported identifier before request building', number => {
    expect(() => seinoSuperExpressSummaryBody(number)).toThrow(InvalidInputError);
  });
});
