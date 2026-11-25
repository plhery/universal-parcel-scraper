import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording } from '../../core/status/index.js';
import { centexStage } from './status.js';

export const PROVIDER = 'CENTEX';
export const CARRIER = 'centex';
/** A shipment's page is a few kilobytes. */
export const CENTEX_MAX_BYTES = 256 * 1024;

/** CENTEX's own waybill: ZJ and seventeen digits. */
export const CENTEX_WAYBILL = /^ZJ\d{17}$/;
/** The Correios number the line gives a parcel for Brazil, which the tracker finds as well. */
const CORREIOS_NUMBER = /^[A-Z]{2}\d{9}BR$/;
// Alibaba Cloud's firewall in front of the site, or another check, in place of the tracker's page.
const CHALLENGE = /acw_sc__v2|_waf_|aliyun_waf|滑动验证|slide to verify|captcha/i;

/** The number as the tracker matches it: one of CENTEX's waybills or the Correios number it gives the parcel. */
export function normalizeCentexNumber(raw: string): string {
  const number = raw.replace(/\s+/g, '').toUpperCase();
  if (!CENTEX_WAYBILL.test(number) && !CORREIOS_NUMBER.test(number)) {
    throw new InvalidInputError(PROVIDER, 'A CENTEX waybill is ZJ and seventeen digits, or the Correios number it gives the parcel');
  }
  return number;
}

const text = ($: CheerioAPI, node: Parameters<CheerioAPI>[0]) => $(node).text().replace(/\s+/g, ' ').trim();

/** A row's wall clock, `yyyy-MM-dd HH:mm:ss` with no offset: China's rows on China's, Brazil's on Brazil's. */
function wallClock(value: string): string {
  const clock = DateTime.fromFormat(value, 'yyyy-MM-dd HH:mm:ss', { zone: 'UTC' });
  if (!clock.isValid) throw new SchemaError(PROVIDER, 'CENTEX returned a scan without a readable clock');
  return clock.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/**
 * The tracker's page for one number (`/default/index/track?trackNos=`). It lists each shipment it finds by any of
 * three numbers, the Correios number, CENTEX's waybill and the customer's reference, with a hidden table of its scans.
 */
export function parseCentexPage(html: string, number: string): CarrierResult {
  const $ = load(html);
  const list = $('#table-module-list-data');
  if (!list.length || !$('form[action="/default/index/track"]').length) {
    if (CHALLENGE.test(html)) throw new ChallengeError(PROVIDER, 'CENTEX asked for a browser check');
    throw new IndeterminateError(PROVIDER, 'CENTEX answered with a page that is not its tracker');
  }
  const rows = list.children('tr.table-module-b1').toArray();
  // A number the tracker does not hold leaves one empty row.
  if (rows.length === 1 && $(rows[0]).children('td').length === 1 && !text($, rows[0])) throw new NotFoundError(PROVIDER);
  const row = rows.find((candidate) => $(candidate).children('td').slice(0, 3).toArray()
    .some((cell) => text($, cell).toUpperCase() === number));
  if (!row) throw new IndeterminateError(PROVIDER, 'CENTEX listed no shipment under the requested number');
  const cells = $(row).children('td').toArray().map((cell) => text($, cell));
  const [service = '', , , country = '', latestClock = '', latestPlace = '', latestText = ''] = cells;
  const id = /#track_(\d+)/.exec($(row).find('a[onclick]').attr('onclick') ?? '')?.[1];
  // The English tab and the hidden Chinese one hold the same rows.
  const detail = id ? $(`#en_${id}`).length ? $(`#en_${id}`) : $(`#cn_${id}`) : $();
  const events: CarrierEvent[] = [];
  const stages: (ClassifiedWording | null)[] = [];
  const seen = new Set<string>();
  const add = (clock: string, location: string, description: string) => {
    if (!description) return;
    const local = wallClock(clock);
    const key = JSON.stringify([local, location, description]);
    if (seen.has(key)) return;
    seen.add(key);
    const stage = centexStage(description);
    stages.push(stage);
    events.push({ local_time: local, description, ...(location ? { location } : {}),
      ...(stage ? { stage: stage.stage, stage_source: stage.source } : {}) });
  };
  for (const scan of detail.find('tr').not('.table-module-title').toArray()) {
    const [clock = '', location = '', description = ''] = $(scan).children('td').toArray().map((cell) => text($, cell));
    add(clock, location, description);
  }
  // A shipment whose scans the page leaves out still shows its latest.
  if (!events.length && latestClock) add(latestClock, latestPlace, latestText);
  if (!events.length) throw new NoHistoryError(PROVIDER);
  const latest = events[0]!;
  const stage = stages[0];
  // Asked by CENTEX's waybill, the Correios number is the one Correios delivers under in Brazil.
  const onward = CORREIOS_NUMBER.test(service) && service !== number ? service : '';
  const correios = onward && detectCarrierMatch(onward).carrier === 'correios-br';
  return {
    status: stage ? languageStageStatus(stage.stage) : 'unknown',
    ...(stage ? { current_stage: stage.stage, current_stage_source: stage.source } : {}),
    last_status_text: latest.description!,
    last_update: null,
    last_update_local: latest.local_time ?? null,
    expected_delivery: null,
    ...(/^[A-Z]{2}$/.test(country) ? { destination_country: country } : {}),
    ...(correios ? { delivery_carrier: 'correios-br', delivery_tracking_number: onward } : {}),
    events,
  };
}
