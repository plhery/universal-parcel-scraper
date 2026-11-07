import { load } from 'cheerio';
import { isSeinoSuperExpressReference } from '../../core/detection/seinoSuperExpress.js';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { seinoSuperExpressStage } from './status.js';

export const PROVIDER = 'Seino Super Express';
export const ORIGIN = 'https://inquire.trc.ssx.seino.co.jp';
export const SUMMARY_URL = ORIGIN + '/inquire/main.jsp';
export const DETAIL_URL = ORIGIN + '/inquire/Main.jsp';
export const MAX_BYTES = 1024 * 1024;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
const HEADERS = ['伝票番号', '指定日', 'お届け予定', '日付', '時間', '状況', '個数', '営業所', '車号', '作業員'];
const HIDDEN = '[hidden],[aria-hidden="true"],.hidden,.hide,.d-none,[style*="display:none"],[style*="display: none"]';
const NOT_REGISTERED = 'お問い合わせの伝票番号は登録されておりません。恐れ入りますが、発送取扱い店へお問い合わせください。';
const compact = (value: string): string => value.replace(/\s+/g, ' ').trim();
const schema = (message: string): never => { throw new SchemaError(PROVIDER, message); };

export interface SeinoSuperExpressPage {
  result: CarrierResult;
  /** Issued by this bound public row; never retained in a tracking result or diagnostics. */
  detailBody?: URLSearchParams;
}

export function normalizeSeinoSuperExpressNumber(raw: string): string {
  if (!isSeinoSuperExpressReference(raw)) throw new InvalidInputError(PROVIDER, 'SSX needs its whole numeric slip number');
  return normalizeTrackingNumber(raw);
}

export function seinoSuperExpressSummaryBody(raw: string): URLSearchParams {
  return new URLSearchParams({ strDenpyoNo1: normalizeSeinoSuperExpressNumber(raw),
    'uji.verbs': 'NAHS0010_find', 'uji.bean': 'com.seibu.bean.na.NAHS0010Bean' });
}

function sourceClock(day: string, clock: string): string {
  const date = /^(\d{2})\/(\d{2})$/.exec(day);
  // Leap day is a possible month/day; the reply does not establish which year it belongs to.
  if (!date || !calendarDay(2000, Number(date[1]), Number(date[2])) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(clock)) {
    return schema('SSX returned a malformed source clock');
  }
  return day + ' ' + clock;
}

/** Only the bound result table supplies scans; staff, vehicles, phones and other form modes stay out. */
export function parseSeinoSuperExpressPage(html: string, raw: string, view: 'summary' | 'detail'): SeinoSuperExpressPage {
  const number = normalizeSeinoSuperExpressNumber(raw);
  if (html.length > MAX_BYTES || new TextEncoder().encode(html).byteLength > MAX_BYTES) return schema('SSX returned too much tracking HTML');
  if (/<title>\s*(?:Just a moment|Access Denied|Attention Required|403 Forbidden|Request Rejected)|_cf_chl_opt|cf-turnstile|\/cdn-cgi\/challenge-platform\/|["'](?:challenge-form|cf-challenge-running)["']|>\s*Verify (?:that )?you are human|class=["'][^"']*(?:g-recaptcha|h-captcha)|<input[^>]+name=["'](?:captcha|captcha_code|validcode|verification_code)["']/i.test(html)) {
    throw new ChallengeError(PROVIDER, 'SSX returned browser verification');
  }
  const $ = load(html);
  if (!$('title').text().includes('セイノースーパーエクスプレス')) return schema('SSX returned another tracking service');
  $('script,style,template').remove();
  const heading = $('h1'), expected = view === 'detail' ? '伝票番号によるお届け状況確認（詳細画面）' : '伝票番号によるお届け状況確認';
  if (heading.length !== 1 || heading.text().replace(/\s+/g, '') !== expected) return schema('SSX returned another tracking view');
  const form = $('form[name="main"]'), table = $('table.table-typeB');
  if (form.length !== 1 || table.length !== 1 || table.closest('form')[0] !== form[0] || table.find('table').length
    || table.closest(HIDDEN).length || form.attr('method')?.toLowerCase() !== 'post') return schema('SSX returned no unique result table');
  const action = form.attr('action');
  if (!action || !['Main.jsp', 'main.jsp', SUMMARY_URL, DETAIL_URL].includes(action)) return schema('SSX changed its result form target');
  const rows = table.find('tr'), headings = rows.filter((_, row) => $(row).children('th').length > 0);
  if (rows.length > MAX_ROWS + 1 || headings.length !== 1
    || JSON.stringify(headings.children('th').map((_, cell) => compact($(cell).text())).get()) !== JSON.stringify(HEADERS)) {
    return schema('SSX changed its result columns');
  }
  const heads = table.find('td.head'), dataRows = rows.filter((_, row) => $(row).children('td').length > 0);
  if (heads.length !== 1 || heads.closest(HIDDEN).length
    || heads.children().not('a,br').length || heads.clone().children().remove().end().text().trim() !== number.padStart(15, '0')) {
    return schema('SSX returned a different or malformed whole slip number');
  }
  const absent = table.find('td.rbodyFull');
  if (absent.length) {
    if (absent.length !== 1 || dataRows.length !== 1 || table.find('td.rbody').length
      || absent.closest(HIDDEN).length || absent.find(HIDDEN).length
      || absent.text().replace(/\s+/g, '') !== NOT_REGISTERED) return schema('SSX returned an inconclusive result notice');
    if (view === 'detail') throw new NoHistoryError(PROVIDER, 'SSX found the slip but returned no detail scans', { reason: 'parcel_found' });
    throw new NotFoundError(PROVIDER, 'SSX has not registered this slip');
  }
  if (!dataRows.length || !table.find('td.rbody').length) {
    throw new NoHistoryError(PROVIDER, 'SSX knows the slip but returned no scans', { reason: 'parcel_found' });
  }
  if (heads.attr('rowspan') !== String(dataRows.length) || (view === 'summary' && dataRows.length !== 2)) return schema('SSX changed its scan grouping');
  const scans: CarrierEvent[] = [];
  for (const [index, row] of dataRows.toArray().entries()) {
    const item = $(row), labels = item.children('td.rhead'), values = item.children('td.rbody');
    const expectedFields = index === 0 ? 10 : 8;
    if (labels.length !== expectedFields || values.length !== expectedFields
      || item.children('td').length !== expectedFields * 2 + (index === 0 ? 1 : 0)) return schema('SSX changed a scan row');
    const field = (name: string): string => {
      const label = labels.filter((_, cell) => compact($(cell).text()) === name), value = label.next('td.rbody');
      if (label.length !== 1 || value.length !== 1 || value.closest(HIDDEN).length || value.find(HIDDEN).length) return schema('SSX returned a missing or hidden scan field');
      return compact(value.text());
    };
    const clock = sourceClock(field('日付'), field('時間')), wording = field('状況'), location = field('営業所名');
    if (!wording || wording.length > 200 || location.length > 200) return schema('SSX returned malformed scan wording or facility');
    const stage = seinoSuperExpressStage(null, wording);
    scans.push({ provider_time_text: clock, description: stage ? wording : 'Tracking update',
      ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) });
  }
  // Both views list oldest first. No calendar year or instant is inferred from the retention notice.
  const events = scans.reverse().slice(0, MAX_EVENTS), newest = events[0]!, stage = seinoSuperExpressStage(null, newest.description ?? '');
  const result: CarrierResult = { status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update: null, expected_delivery: null,
    history_truncated: true, events };
  const estimates = dataRows.first().children('td.rhead').filter((_, cell) => ['指定日', 'お届け予定'].includes(compact($(cell).text())))
    .filter((_, cell) => compact($(cell).next('td.rbody').text()) !== '').map((_, cell) => compact($(cell).text()) === '指定日' ? 'summary.designated_day' : 'summary.expected_day').get();
  if (estimates.length) result.unread_estimates = estimates;
  if (view === 'detail') return { result };
  const links = heads.find('a[onclick]');
  if (!links.length) return { result };
  if (links.length !== 1 || links.closest(HIDDEN).length) return schema('SSX returned ambiguous or hidden detail actions');
  const callback = /^nahs0030find\('([0-9]{15})','([0-9]{6})','([A-Za-z0-9]{1,32})'\)$/.exec(links.attr('onclick') ?? '');
  if (!callback || callback[1] !== number.padStart(15, '0')) return schema('SSX returned an unbound detail action');
  const detailBody = new URLSearchParams();
  const allowed = /^(?:uji\.(?:verbs|bean)|strDenpyoNo\d*|strSyukaTenCD|strNinsyoNo|strFrontGamen|strFlg|bakDenpyoNo\d+)$/;
  for (const input of form.find('input[name]').toArray()) {
    const name = $(input).attr('name')!, value = $(input).attr('value') ?? '';
    if (!allowed.test(name)) continue;
    if (value.length > 64 || detailBody.has(name)) return schema('SSX returned malformed detail state');
    detailBody.set(name, value);
  }
  detailBody.set('uji.verbs', 'NAHS0030_find'); detailBody.set('uji.bean', 'com.seibu.bean.na.NAHS0030Bean');
  detailBody.set('strDenpyoNo', callback[1]); detailBody.set('strSyukaTenCD', callback[2]!); detailBody.set('strNinsyoNo', callback[3]!);
  return { result, detailBody };
}
